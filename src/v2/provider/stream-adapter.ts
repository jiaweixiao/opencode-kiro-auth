import { Usage, type LLMEvent } from '@opencode/ai'
import { parseBracketToolCalls } from '../../infrastructure/transformers/tool-call-parser.js'
import { restoreToolName } from '../../infrastructure/transformers/tool-transformer.js'
import { getContextWindowSize } from '../../plugin/models.js'
import { estimateTokens } from '../../plugin/response.js'
import { findRealTag } from '../../plugin/streaming/stream-parser.js'
import { THINKING_END_TAG, THINKING_START_TAG } from '../../plugin/streaming/types.js'
import type { ToolNameMap } from '../../plugin/types.js'

interface PendingToolCall {
  toolUseId: string
  name?: string
  input: string
}

const TEXT_BLOCK_ID = 'text-0'
const REASONING_BLOCK_ID = 'reasoning-0'

/**
 * Convert the Kiro SDK event stream into canonical V2 `LLMEvent`s.
 *
 * Unlike the V1 path, which re-encoded everything as OpenAI-compatible SSE and
 * smuggled reasoning through a `reasoning_content` delta, V2 has first-class
 * `reasoning-*` events. The `<thinking>` tag scraper is retained only as a
 * fallback for responses that inline reasoning in the assistant text.
 */
export async function* adaptStream(
  sdkResponse: unknown,
  model: string,
  toolNameMap?: ToolNameMap
): AsyncGenerator<LLMEvent> {
  const eventStream = (sdkResponse as { generateAssistantResponseResponse?: AsyncIterable<any> })
    ?.generateAssistantResponseResponse
  if (!eventStream) throw new Error('SDK response has no event stream')

  let buffer = ''
  let inThinking = false
  let thinkingExtracted = false
  let sawNativeReasoning = false
  let reasoningOpen = false
  let textOpen = false

  let totalContent = ''
  let textOnlyContent = ''
  let contextUsagePercentage: number | null = null

  const toolCallFragments = new Map<string, PendingToolCall>()
  const toolCallOrder: string[] = []

  yield { type: 'step-start', index: 0 }

  function* openReasoning(): Generator<LLMEvent> {
    if (reasoningOpen) return
    reasoningOpen = true
    yield { type: 'reasoning-start', id: REASONING_BLOCK_ID }
  }

  function* closeReasoning(): Generator<LLMEvent> {
    if (!reasoningOpen) return
    reasoningOpen = false
    yield { type: 'reasoning-end', id: REASONING_BLOCK_ID }
  }

  function* emitReasoning(text: string): Generator<LLMEvent> {
    if (!text) return
    yield* openReasoning()
    yield { type: 'reasoning-delta', id: REASONING_BLOCK_ID, text }
  }

  function* openText(): Generator<LLMEvent> {
    if (textOpen) return
    textOpen = true
    yield { type: 'text-start', id: TEXT_BLOCK_ID }
  }

  function* emitText(text: string): Generator<LLMEvent> {
    if (!text) return
    yield* openText()
    yield { type: 'text-delta', id: TEXT_BLOCK_ID, text }
  }

  for await (const event of eventStream) {
    if (event.reasoningContentEvent) {
      // Native reasoning. `redactedContent` is provider-encrypted with no
      // readable form, so only `text` is surfaced.
      const reasoning = event.reasoningContentEvent.text
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        sawNativeReasoning = true
        yield* emitReasoning(reasoning)
      }
      continue
    }

    if (event.assistantResponseEvent?.content) {
      const text: string = event.assistantResponseEvent.content
      totalContent += text
      textOnlyContent += text

      // Native reasoning already streamed: close it and route the rest to text
      // instead of scraping for tags.
      if (sawNativeReasoning && !thinkingExtracted) {
        thinkingExtracted = true
        yield* closeReasoning()
      }

      buffer += text

      while (buffer.length > 0) {
        if (!inThinking && !thinkingExtracted) {
          const startPos = findRealTag(buffer, THINKING_START_TAG)
          if (startPos !== -1) {
            yield* emitText(buffer.slice(0, startPos))
            buffer = buffer.slice(startPos + THINKING_START_TAG.length)
            inThinking = true
            continue
          }

          // Hold back a tag-length tail so a split tag is not emitted as text.
          const safeLen = Math.max(0, buffer.length - THINKING_START_TAG.length)
          if (safeLen > 0) {
            yield* emitText(buffer.slice(0, safeLen))
            buffer = buffer.slice(safeLen)
          }
          break
        }

        if (inThinking) {
          const endPos = findRealTag(buffer, THINKING_END_TAG)
          if (endPos !== -1) {
            yield* emitReasoning(buffer.slice(0, endPos))
            buffer = buffer.slice(endPos + THINKING_END_TAG.length)
            inThinking = false
            thinkingExtracted = true
            yield* closeReasoning()
            if (buffer.startsWith('\n\n')) buffer = buffer.slice(2)
            continue
          }

          const safeLen = Math.max(0, buffer.length - THINKING_END_TAG.length)
          if (safeLen > 0) {
            yield* emitReasoning(buffer.slice(0, safeLen))
            buffer = buffer.slice(safeLen)
          }
          break
        }

        const rest = buffer
        buffer = ''
        yield* emitText(rest)
        break
      }
      continue
    }

    if (event.toolUseEvent) {
      const tc = event.toolUseEvent
      if (tc.name) totalContent += tc.name
      if (tc.input) totalContent += tc.input

      const toolUseId = tc.toolUseId
      if (typeof toolUseId === 'string' && toolUseId.length > 0) {
        let accumulated = toolCallFragments.get(toolUseId)
        if (!accumulated) {
          accumulated = { toolUseId, input: '' }
          toolCallFragments.set(toolUseId, accumulated)
          toolCallOrder.push(toolUseId)
          const name = typeof tc.name === 'string' ? restoreToolName(tc.name, toolNameMap) : ''
          if (name) {
            yield { type: 'tool-input-start', id: toolUseId, name }
          }
        }
        if (typeof tc.name === 'string' && tc.name.length > 0) {
          accumulated.name = restoreToolName(tc.name, toolNameMap)
        }
        if (tc.input !== undefined) {
          const fragment =
            typeof tc.input === 'string' ? tc.input : (JSON.stringify(tc.input) ?? '')
          accumulated.input += fragment
          if (fragment && accumulated.name) {
            yield {
              type: 'tool-input-delta',
              id: toolUseId,
              name: accumulated.name,
              text: fragment
            }
          }
        }
      }
      continue
    }

    if (event.metadataEvent?.contextUsagePercentage) {
      contextUsagePercentage = event.metadataEvent.contextUsagePercentage
    } else if (event.contextUseEvent?.contextUsagePercentage) {
      contextUsagePercentage = event.contextUseEvent.contextUsagePercentage
    } else if (event.contextUsageEvent?.contextUsagePercentage) {
      contextUsagePercentage = event.contextUsageEvent.contextUsagePercentage
    }
  }

  // Flush whatever remains in the tag-detection buffer.
  if (buffer) {
    if (inThinking) {
      yield* emitReasoning(buffer)
      yield* closeReasoning()
    } else {
      yield* emitText(buffer)
    }
    buffer = ''
  }

  yield* closeReasoning()
  if (textOpen) yield { type: 'text-end', id: TEXT_BLOCK_ID }

  const toolCalls = toolCallOrder
    .map((id) => toolCallFragments.get(id))
    .filter((tc): tc is PendingToolCall & { name: string } => typeof tc?.name === 'string')

  // Some models emit tool calls as bracket syntax in the assistant text rather
  // than through toolUseEvent.
  for (const bracket of parseBracketToolCalls(totalContent)) {
    const name = restoreToolName(bracket.name, toolNameMap)
    const input = typeof bracket.input === 'string' ? bracket.input : JSON.stringify(bracket.input)
    toolCalls.push({ toolUseId: bracket.toolUseId, name, input })
    yield { type: 'tool-input-start', id: bracket.toolUseId, name }
    yield { type: 'tool-input-delta', id: bracket.toolUseId, name, text: input }
  }

  for (const tc of toolCalls) {
    yield { type: 'tool-input-end', id: tc.toolUseId, name: tc.name }

    let parsed: unknown
    try {
      parsed = tc.input.trim() ? JSON.parse(tc.input) : {}
    } catch {
      yield { type: 'tool-input-error', id: tc.toolUseId, name: tc.name, raw: tc.input }
      continue
    }

    yield { type: 'tool-call', id: tc.toolUseId, name: tc.name, input: parsed }
  }

  const outputTokens = estimateTokens(textOnlyContent)
  let inputTokens = 0
  if (contextUsagePercentage !== null && contextUsagePercentage > 0) {
    const contextWindow = getContextWindowSize(model)
    const totalTokens = Math.round((contextWindow * contextUsagePercentage) / 100)
    inputTokens = Math.max(0, totalTokens - outputTokens)
  }

  // `usage` must be a `Usage` instance: the host identifies terminal events
  // with `LLMEvent.is.finish()`, which rejects a plain usage object and then
  // reports the stream as having ended unexpectedly.
  const usage = Usage.from({
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens
  })
  const reason = {
    normalized: toolCalls.length > 0 ? ('tool-calls' as const) : ('stop' as const)
  }

  yield { type: 'step-finish', index: 0, reason, usage }
  yield { type: 'finish', reason, usage }
}

import type { LLMRequest } from '@opencode/ai'

/**
 * Convert a canonical V2 `LLMRequest` into the Anthropic-ish body shape that
 * `transformToSdkRequest` already consumes.
 *
 * Reusing the V1 request builder keeps history construction, tool-name
 * aliasing, orphaned tool-result repair, image limits, and effort resolution
 * identical across both plugin generations. Only the inbound shape differs.
 */
export interface AdaptedBody {
  system: string
  messages: AdaptedMessage[]
  tools: AdaptedTool[]
}

interface AdaptedMessage {
  role: string
  content: AdaptedPart[] | string
}

type AdaptedPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

interface AdaptedTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Flatten a tool result into the single text blob CodeWhisperer accepts. */
function toolResultText(result: unknown): string {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') return result

  const value = result as { type?: string; value?: unknown }
  if (value.type === 'text' || value.type === 'json' || value.type === 'error') {
    return typeof value.value === 'string' ? value.value : JSON.stringify(value.value)
  }
  if (value.type === 'content' && Array.isArray(value.value)) {
    return value.value
      .map((part: { type?: string; text?: string; uri?: string }) =>
        part?.type === 'text' ? (part.text ?? '') : (part?.uri ?? '')
      )
      .join('\n')
  }
  return JSON.stringify(result)
}

/**
 * Media assets reach the provider in one of four source shapes. Only inline
 * bytes and base64 can be forwarded; `url` and `ref` would need a fetch the
 * Kiro request path does not perform, so they are dropped and the caller's
 * image-omission notice covers them.
 */
function mediaToPart(media: unknown): AdaptedPart | undefined {
  const asset = media as {
    source?: { type?: string; data?: unknown; mediaType?: string }
  }
  const source = asset?.source
  if (!source) return undefined

  const mediaType = source.mediaType ?? 'image/png'

  if (source.type === 'base64' && typeof source.data === 'string') {
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: source.data } }
  }
  if (source.type === 'bytes' && source.data instanceof Uint8Array) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: bytesToBase64(source.data) }
    }
  }
  return undefined
}

function adaptContent(content: readonly unknown[]): AdaptedPart[] {
  const parts: AdaptedPart[] = []

  for (const raw of content) {
    const part = raw as {
      type?: string
      text?: string
      id?: string
      name?: string
      input?: unknown
      result?: unknown
      media?: unknown
    }

    switch (part.type) {
      case 'text':
        if (part.text) parts.push({ type: 'text', text: part.text })
        break
      case 'reasoning':
        if (part.text) parts.push({ type: 'thinking', thinking: part.text })
        break
      case 'tool-call':
        parts.push({
          type: 'tool_use',
          id: part.id ?? '',
          name: part.name ?? 'tool',
          input: part.input ?? {}
        })
        break
      case 'tool-result':
        parts.push({
          type: 'tool_result',
          tool_use_id: part.id ?? '',
          content: toolResultText(part.result)
        })
        break
      case 'media': {
        const media = mediaToPart(part.media)
        if (media) parts.push(media)
        break
      }
      // `compaction` and `effort` markers carry no content for this provider.
      default:
        break
    }
  }

  return parts
}

/**
 * V2 delivers tool results as a `tool`-role message, while the V1 builder
 * expects them inside a `user` message's content array. Rewriting the role here
 * keeps the downstream orphan-repair logic on its well-tested path.
 */
function adaptRole(role: string, parts: AdaptedPart[]): string {
  if (role !== 'tool') return role
  return parts.some((part) => part.type === 'tool_result') ? 'user' : 'user'
}

export function adaptRequest(request: LLMRequest): AdaptedBody {
  const system = request.system
    .map((part) => part.text)
    .filter((text) => typeof text === 'string' && text.length > 0)
    .join('\n\n')

  const messages: AdaptedMessage[] = []
  for (const message of request.messages) {
    const parts = adaptContent(message.content as readonly unknown[])
    if (parts.length === 0) continue
    messages.push({ role: adaptRole(message.role, parts), content: parts })
  }

  const tools: AdaptedTool[] = []
  for (const entry of request.tools) {
    const tool = entry as {
      type?: string
      name?: string
      description?: string
      inputSchema?: Record<string, unknown>
      tools?: readonly unknown[]
    }

    // Namespaced tool groups are flattened; CodeWhisperer has no namespace concept.
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const nested of tool.tools) {
        const child = nested as {
          name?: string
          description?: string
          inputSchema?: Record<string, unknown>
        }
        if (!child.name) continue
        tools.push({
          name: `${tool.name}_${child.name}`,
          description: child.description ?? '',
          input_schema: child.inputSchema ?? {}
        })
      }
      continue
    }

    if (!tool.name) continue
    tools.push({
      name: tool.name,
      description: tool.description ?? '',
      input_schema: tool.inputSchema ?? {}
    })
  }

  return { system, messages, tools }
}

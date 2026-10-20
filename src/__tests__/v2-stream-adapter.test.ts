import { describe, expect, test } from 'bun:test'
import { withIdleTimeout } from '../v2/provider/index.js'
import { adaptStream } from '../v2/provider/stream-adapter.js'

function streamOf(events: any[]) {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
    })()
  }
}

function neverEndingStream() {
  return {
    generateAssistantResponseResponse: (async function* () {
      await new Promise(() => {})
    })()
  }
}

describe('V2 adaptStream', () => {
  test('emits finish for a complete response', async () => {
    const events: any[] = []
    for await (const event of adaptStream(
      streamOf([
        { reasoningContentEvent: { text: 'thinking' } },
        { assistantResponseEvent: { content: 'hello' } },
        { contextUsageEvent: { contextUsagePercentage: 5 } }
      ]),
      'claude-sonnet-4-5'
    )) {
      events.push(event)
    }
    const finish = events[events.length - 1]
    expect(finish.type).toBe('finish')
  })

  test('wraps a never-ending stream with a timeout and fails fast', async () => {
    const gen = adaptStream(neverEndingStream(), 'claude-sonnet-4-5')
    const timed = withIdleTimeout(gen, 50)
    const iterator = timed[Symbol.asyncIterator]()

    // First event should come through (step-start)
    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value.type).toBe('step-start')

    // Second read should hang until the timeout fires
    await expect(iterator.next()).rejects.toThrow('Kiro stream idle timeout after 50ms')
  })
})

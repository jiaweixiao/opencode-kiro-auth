import {
  AIError,
  Auth,
  LanguageModel,
  ProviderID,
  UnknownProviderError,
  type LLMEvent,
  type LLMRequest
} from '@opencode/ai'
import { Route } from '@opencode/ai/route/client'
import { Endpoint } from '@opencode/ai/route/endpoint'
import { Protocol } from '@opencode/ai/route/protocol'
import { Effect, Schema, Stream } from 'effect'
import * as logger from '../../plugin/logger.js'
import { KIRO_PROVIDER_ID } from '../model-registry.js'
import { sharedExecutor } from './executor.js'
import { adaptRequest } from './request-adapter.js'
import { adaptStream } from './stream-adapter.js'

/**
 * Kiro's wire protocol is AWS CodeWhisperer, driven by the AWS SDK rather than
 * plain HTTP. The SDK owns signing, the binary event-stream framing, and
 * retries, so this protocol does not use the HTTP transport at all: `body.from`
 * carries the canonical request through to a transport that calls the SDK and
 * emits already-converted `LLMEvent`s.
 */

interface KiroBody {
  readonly request: LLMRequest
  readonly modelID: string
  readonly effort?: string
}

/** Frames are the final events; the protocol's decode and step stages are pass-through. */
type KiroFrame = LLMEvent

const bodySchema = Schema.Any as unknown as Schema.Codec<KiroBody, unknown>
const frameSchema = Schema.Any as unknown as Schema.Codec<KiroFrame, KiroFrame>
const STREAM_IDLE_TIMEOUT_MS = 120000

function providerError(message: string, cause?: unknown): AIError {
  return new AIError({
    reason: new UnknownProviderError({ message, cause })
  })
}

/**
 * Wrap an async generator with an inactivity deadline. If no event arrives
 * within `idleMs`, the generator is closed and a timeout error is raised.
 */
export function withIdleTimeout<T>(
  generator: AsyncGenerator<T>,
  idleMs: number
): AsyncGenerator<T> {
  const source = generator[Symbol.asyncIterator]()
  return (async function* () {
    while (true) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          source.return?.(undefined).catch(() => {})
          reject(new Error(`Kiro stream idle timeout after ${idleMs}ms`))
        }, idleMs)
      })
      try {
        const { done, value } = await Promise.race([source.next(), timeout])
        clearTimeout(timeoutId)
        if (done) return
        yield value
      } catch (e) {
        clearTimeout(timeoutId)
        source.return?.(undefined).catch(() => {})
        throw e
      }
    }
  })()
}

const protocol = Protocol.make<KiroBody, KiroFrame, KiroFrame, null>({
  id: 'kiro-codewhisperer',
  body: {
    schema: bodySchema,
    from: (request: LLMRequest) =>
      Effect.succeed({
        request,
        modelID: request.model.id,
        effort: (request.providerOptions as { effort?: string } | undefined)?.effort
      })
  },
  stream: {
    event: frameSchema,
    initial: () => null,
    step: (state, event) => Effect.succeed([state, [event]])
  }
})

/**
 * Transport that runs the AWS SDK call instead of an HTTP request.
 *
 * Account selection, token refresh, rate-limit rotation, and retry all live in
 * the executor, which is the layer the host cannot reach: provider `settings`
 * are stripped of `fetch`, `timeout`, and `transport` before `model()` is
 * called, so none of this can be expressed as a custom fetch.
 */
const transport = {
  id: 'kiro-sdk',
  prepare: (input: { body: KiroBody }) => Effect.succeed(input.body),
  execute: (prepared: KiroBody) =>
    Effect.succeed({
      frames: Stream.unwrap(
        Effect.tryPromise({
          try: async () => {
            const executor = await sharedExecutor()
            const adapted = adaptRequest(prepared.request)
            logger.log('Kiro request start', { model: prepared.modelID, effort: prepared.effort })
            const { sdkResponse, prepared: sdkPrepared } = await executor.execute(
              adapted,
              prepared.modelID,
              prepared.effort
            )
            logger.log('Kiro request streaming', { model: sdkPrepared.effectiveModel })
            return Stream.fromAsyncIterable(
              withIdleTimeout(
                adaptStream(sdkResponse, sdkPrepared.effectiveModel, sdkPrepared.toolNameMap),
                STREAM_IDLE_TIMEOUT_MS
              ),
              (cause) => {
                logger.error(
                  'Kiro stream failed',
                  cause instanceof Error ? cause : new Error(String(cause))
                )
                return providerError('Kiro stream failed', cause)
              }
            )
          },
          catch: (cause) => {
            logger.error(
              'Kiro request failed',
              cause instanceof Error ? cause : new Error(String(cause))
            )
            return providerError(cause instanceof Error ? cause.message : String(cause), cause)
          }
        })
      )
    })
} as never

const route = Route.make({
  id: 'kiro-generate-assistant-response',
  provider: KIRO_PROVIDER_ID,
  protocol,
  // Unused by the SDK transport, but `Route.model()` requires a baseURL.
  endpoint: Endpoint.path('/generateAssistantResponse', {
    baseURL: 'https://q.us-east-1.amazonaws.com'
  }),
  auth: Auth.none,
  transport
})

/**
 * Provider package entrypoint.
 *
 * The host contract is a default export exposing `model(modelID, settings)`.
 * It is called more than once per run (auxiliary requests such as title
 * generation build their own model), so this stays cheap and side-effect free;
 * all stateful work is deferred to the executor on first request.
 */
export function model(modelID: string, settings: Record<string, unknown> = {}): LanguageModel {
  const effort = typeof settings.effort === 'string' ? settings.effort : undefined

  return route.model({
    id: modelID,
    provider: ProviderID.make(KIRO_PROVIDER_ID),
    defaults: effort === undefined ? undefined : { providerOptions: { effort } }
  })
}

export default { model }

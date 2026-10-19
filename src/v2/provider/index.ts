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

function providerError(message: string, cause?: unknown): AIError {
  return new AIError({
    reason: new UnknownProviderError({ message, cause })
  })
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
            const { sdkResponse, prepared: sdkPrepared } = await executor.execute(
              adapted,
              prepared.modelID,
              prepared.effort
            )
            return Stream.fromAsyncIterable(
              adaptStream(sdkResponse, sdkPrepared.effectiveModel, sdkPrepared.toolNameMap),
              (cause) => providerError('Kiro stream failed', cause)
            )
          },
          catch: (cause) =>
            providerError(cause instanceof Error ? cause.message : String(cause), cause)
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

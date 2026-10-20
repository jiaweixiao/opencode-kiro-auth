import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { KIRO_CONSTANTS } from '../constants.js'
import { buildEffortRequestFields, type EffortSchemaPath } from './effort.js'
import type { Effort, KiroAuthDetails } from './types'

/**
 * Cache key includes effort to ensure separate clients for different effort levels,
 * since middleware is configured at client creation time.
 */
interface ClientCacheEntry {
  client: CodeWhispererStreamingClient
  token: string
  effort?: Effort
  effortSchemaPath?: EffortSchemaPath
}

const clientCache = new Map<string, ClientCacheEntry>()
const KIRO_CLI_MAX_ATTEMPTS = 3
const CONNECTION_TIMEOUT_MS = 10000
const STREAM_IDLE_TIMEOUT_MS = 120000

function getProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy
  )
}

function createRequestHandler(): NodeHttpHandler | undefined {
  const proxy = getProxyUrl()
  if (!proxy) return undefined

  return new NodeHttpHandler({
    httpsAgent: new HttpsProxyAgent(proxy),
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: STREAM_IDLE_TIMEOUT_MS
  })
}

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  effort?: Effort,
  effortSchemaPath?: EffortSchemaPath
): CodeWhispererStreamingClient {
  const resolvedSchemaPath = effort ? (effortSchemaPath ?? 'output_config') : undefined
  const cacheKey = `${region}:${auth.email || 'default'}:${effort || 'none'}:${resolvedSchemaPath || 'none'}:${getProxyUrl() || 'none'}`
  const cached = clientCache.get(cacheKey)

  if (
    cached &&
    cached.token === auth.access &&
    cached.effort === effort &&
    cached.effortSchemaPath === resolvedSchemaPath
  ) {
    return cached.client
  }

  const token = auth.access
  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: `https://q.${region}.amazonaws.com`,
    token: () => Promise.resolve({ token }),
    maxAttempts: KIRO_CLI_MAX_ATTEMPTS,
    retryMode: 'standard',
    customUserAgent: [[KIRO_CONSTANTS.USER_AGENT]],
    requestHandler: createRequestHandler()
  })

  // Add Kiro-specific headers
  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  // Inject additionalModelRequestFields using the model's advertised schema path.
  if (effort && resolvedSchemaPath) {
    client.middlewareStack.add(
      (next: any) => async (args: any) => {
        if (args.request?.body) {
          try {
            const body = JSON.parse(args.request.body)
            body.additionalModelRequestFields = buildEffortRequestFields(effort, resolvedSchemaPath)
            args.request.body = JSON.stringify(body)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            throw new Error(`Failed to inject Kiro effort configuration: ${detail}`)
          }
        }
        return next(args)
      },
      { step: 'build', name: 'addEffortConfig', priority: 'high' }
    )
  }

  clientCache.set(cacheKey, {
    client,
    token,
    effort,
    effortSchemaPath: resolvedSchemaPath
  })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}

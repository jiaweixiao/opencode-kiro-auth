import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import { describe, expect, test } from 'bun:test'
import { clearSdkClientCache, createSdkClient } from '../plugin/sdk-client'
import type { KiroAuthDetails } from '../plugin/types'

const ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const

function preserveProxyEnv() {
  return ENV_KEYS.map((key) => [key, process.env[key]] as const)
}

function restoreProxyEnv(saved: ReturnType<typeof preserveProxyEnv>) {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function clearProxyEnv() {
  for (const key of ENV_KEYS) delete process.env[key]
}

function auth(): KiroAuthDetails {
  return {
    refresh: 'refresh-token',
    access: 'access-token',
    expires: Date.now() + 3600000,
    authMethod: 'idc',
    region: 'us-east-1',
    email: 'user@example.com'
  }
}

async function captureRequest(client: ReturnType<typeof createSdkClient>) {
  let capturedRequest: any

  client.middlewareStack.add(
    () => async (args: any) => {
      capturedRequest = args.request
      throw new Error('captured-request')
    },
    { step: 'finalizeRequest', name: 'captureRequest', priority: 'high' }
  )

  const command = new GenerateAssistantResponseCommand({
    conversationState: {
      chatTriggerType: 'MANUAL',
      conversationId: 'test-conversation',
      currentMessage: {
        userInputMessage: {
          content: 'hello',
          modelId: 'claude-opus-4.7',
          origin: 'AI_EDITOR'
        }
      }
    }
  })

  await client.send(command).catch((error) => {
    if (error.message !== 'captured-request') throw error
  })

  const bodyText =
    typeof capturedRequest.body === 'string'
      ? capturedRequest.body
      : Buffer.from(capturedRequest.body).toString('utf8')

  return {
    body: JSON.parse(bodyText),
    request: { headers: capturedRequest.headers, bodyText }
  }
}

describe('SDK client', () => {
  test('uses Kiro CLI-style standard SDK retries for throttling', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1')

    expect(await client.config.maxAttempts()).toBe(3)
    const retryMode = client.config.retryMode
    expect(typeof retryMode === 'function' ? await retryMode() : retryMode).toBe('standard')

    clearSdkClientCache()
  })

  test('injects effort before content-length is computed', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1', 'max')
    const { body, request } = await captureRequest(client)

    expect(body.additionalModelRequestFields.output_config.effort).toBe('max')
    expect(Number(request.headers['content-length'])).toBe(Buffer.byteLength(request.bodyText))

    clearSdkClientCache()
  })

  test('omits additionalModelRequestFields when no effort is set', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1')
    const { body } = await captureRequest(client)

    expect(body.additionalModelRequestFields).toBeUndefined()

    clearSdkClientCache()
  })

  test('injects xhigh, the level that was previously unreachable', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1', 'xhigh')
    const { body, request } = await captureRequest(client)

    expect(body.additionalModelRequestFields.output_config.effort).toBe('xhigh')
    expect(Number(request.headers['content-length'])).toBe(Buffer.byteLength(request.bodyText))

    clearSdkClientCache()
  })

  test('injects GPT effort under reasoning before content-length is computed', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1', 'high', 'reasoning')
    const { body, request } = await captureRequest(client)

    expect(body.additionalModelRequestFields.reasoning.effort).toBe('high')
    expect(body.additionalModelRequestFields.output_config).toBeUndefined()
    expect(Number(request.headers['content-length'])).toBe(Buffer.byteLength(request.bodyText))

    clearSdkClientCache()
  })

  test('fails explicitly when effort injection cannot rewrite the SDK body', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1', 'high', 'reasoning')
    client.middlewareStack.addRelativeTo(
      (next: any) => async (args: any) => {
        args.request.body = '{invalid-json'
        return next(args)
      },
      {
        name: 'corruptBodyBeforeEffort',
        relation: 'before',
        toMiddleware: 'addEffortConfig'
      }
    )

    const command = new GenerateAssistantResponseCommand({
      conversationState: {
        chatTriggerType: 'MANUAL',
        conversationId: 'test-conversation',
        currentMessage: {
          userInputMessage: {
            content: 'hello',
            modelId: 'gpt-5.6-sol',
            origin: 'AI_EDITOR'
          }
        }
      }
    })

    await expect(client.send(command)).rejects.toThrow('Failed to inject Kiro effort configuration')

    clearSdkClientCache()
  })

  test('creates a proxied request handler when proxy env is set', async () => {
    const saved = preserveProxyEnv()
    try {
      process.env.HTTPS_PROXY = 'http://10.108.157.36:80'
      clearSdkClientCache()
      const client = createSdkClient(auth(), 'us-east-1')
      const handler = client.config.requestHandler as any
      const config = await handler.configProvider

      expect(config.connectionTimeout).toBe(10000)
      expect(config.socketTimeout).toBe(120000)
      expect(config.httpsAgent).toBeDefined()
    } finally {
      restoreProxyEnv(saved)
      clearSdkClientCache()
    }
  })

  test('keeps the default handler when no proxy env is set', () => {
    const saved = preserveProxyEnv()
    try {
      clearProxyEnv()
      clearSdkClientCache()
      const client = createSdkClient(auth(), 'us-east-1')
      const handler = client.config.requestHandler as any

      expect(handler).toBeDefined()
    } finally {
      restoreProxyEnv(saved)
      clearSdkClientCache()
    }
  })

  test('prefers HTTPS_PROXY over HTTP_PROXY', async () => {
    const saved = preserveProxyEnv()
    try {
      process.env.HTTPS_PROXY = 'http://10.108.157.36:80'
      process.env.HTTP_PROXY = 'http://invalid-proxy:80'
      clearSdkClientCache()
      const client = createSdkClient(auth(), 'us-east-1')
      const handler = client.config.requestHandler as any
      const config = await handler.configProvider

      expect(config.httpsAgent.proxy.href).toBe('http://10.108.157.36/')
    } finally {
      restoreProxyEnv(saved)
      clearSdkClientCache()
    }
  })
})

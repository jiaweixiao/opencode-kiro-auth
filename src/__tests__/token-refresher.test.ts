import { describe, expect, mock, test } from 'bun:test'
import { KiroTokenRefreshError } from '../plugin/errors.js'

const holder: { error: Error | null } = { error: null }

mock.module('../plugin/storage/sqlite.js', () => ({
  kiroDb: {
    getAccounts: () => [],
    upsertAccount: () => Promise.resolve(),
    deleteAccount: () => Promise.resolve(),
    batchUpsertAccounts: () => Promise.resolve()
  }
}))
mock.module('../plugin/sync/kiro-cli.js', () => ({
  syncFromKiroCli: () => Promise.resolve(),
  writeToKiroCli: () => Promise.resolve()
}))
mock.module('../kiro/auth.js', () => ({
  decodeRefreshToken: (t: string) => ({ refreshToken: t, authMethod: 'idc' }),
  encodeRefreshToken: (p: any) => p.refreshToken,
  accessTokenExpired: () => true // always attempt the refresh
}))
mock.module('../plugin/token.js', () => ({
  // Read the error lazily so each test can swap it after module hoisting.
  refreshAccessToken: () => Promise.reject(holder.error)
}))
mock.module('../plugin/logger.js', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {},
  logApiError: () => {},
  getTimestamp: () => ''
}))

import { TokenRefresher } from '../core/auth/token-refresher.js'
import { AccountManager } from '../plugin/accounts.js'
import type { KiroAuthDetails, ManagedAccount } from '../plugin/types.js'

function makeAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc-1',
    email: 'test@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    oidcRegion: 'ap-southeast-1',
    refreshToken: 'refresh',
    accessToken: 'access',
    expiresAt: 0, // expired
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    lastUsed: 0,
    usedCount: 0,
    limitCount: 0,
    ...overrides
  }
}

function makeManager(acc: ManagedAccount): AccountManager {
  return new AccountManager([acc])
}

function makeAuth(mgr: AccountManager, acc: ManagedAccount): KiroAuthDetails {
  return mgr.toAuthDetails(acc)
}

const fakeRepo: any = {
  invalidateCache: () => {},
  findAll: async () => [],
  save: async () => {},
  batchSave: async () => {}
}

const config = {
  token_expiry_buffer_ms: 300000,
  auto_sync_kiro_cli: false,
  account_selection_strategy: 'sticky' as const
}

const noopToast = () => {}

describe('TokenRefresher refresh-failure classification', () => {
  test('invalid_request marks the account permanently unhealthy instead of throwing', async () => {
    const acc = makeAccount()
    const mgr = makeManager(acc)
    const refresher = new TokenRefresher(config, mgr, async () => {}, fakeRepo)
    holder.error = new KiroTokenRefreshError('Refresh failed: Invalid request', 'invalid_request')

    const result = await refresher.refreshIfNeeded(acc, makeAuth(mgr, acc), noopToast)

    expect(result.shouldContinue).toBe(true)
    expect(acc.isHealthy).toBe(false)
    expect(acc.failCount).toBe(10)
    expect(acc.unhealthyReason).toBe('invalid_request')
  })

  test('invalid_client marks the account permanently unhealthy instead of throwing', async () => {
    const acc = makeAccount()
    const mgr = makeManager(acc)
    const refresher = new TokenRefresher(config, mgr, async () => {}, fakeRepo)
    holder.error = new KiroTokenRefreshError('Refresh failed: Invalid client', 'invalid_client')

    const result = await refresher.refreshIfNeeded(acc, makeAuth(mgr, acc), noopToast)

    expect(result.shouldContinue).toBe(true)
    expect(acc.isHealthy).toBe(false)
    expect(acc.failCount).toBe(10)
    expect(acc.unhealthyReason).toBe('invalid_client')
  })

  test('transient network errors are rethrown and keep the account healthy', async () => {
    const acc = makeAccount()
    const mgr = makeManager(acc)
    const refresher = new TokenRefresher(config, mgr, async () => {}, fakeRepo)
    holder.error = new KiroTokenRefreshError('Token refresh failed: boom', 'NETWORK_ERROR')

    await expect(refresher.refreshIfNeeded(acc, makeAuth(mgr, acc), noopToast)).rejects.toThrow(
      'Token refresh failed: boom'
    )
    expect(acc.isHealthy).toBe(true)
    expect(acc.failCount).toBe(0)
  })
})

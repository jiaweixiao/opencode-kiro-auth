import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import { AccountSelector } from '../../core/account/account-selector.js'
import { UsageTracker } from '../../core/account/usage-tracker.js'
import { TokenRefresher } from '../../core/auth/token-refresher.js'
import { ErrorHandler } from '../../core/request/error-handler.js'
import { RetryStrategy } from '../../core/request/retry-strategy.js'
import { AccountCache } from '../../infrastructure/database/account-cache.js'
import { AccountRepository } from '../../infrastructure/database/account-repository.js'
import { AccountManager } from '../../plugin/accounts.js'
import { loadConfig, type KiroConfig } from '../../plugin/config/index.js'
import { isPermanentError } from '../../plugin/health.js'
import * as logger from '../../plugin/logger.js'
import { transformToSdkRequest } from '../../plugin/request.js'
import { createSdkClient } from '../../plugin/sdk-client.js'
import { syncFromKiroCli } from '../../plugin/sync/kiro-cli.js'
import type { ManagedAccount, SdkPreparedRequest } from '../../plugin/types.js'

/**
 * V2 has no `client.tui.showToast`, so operational notices go to the plugin log
 * instead. The signature matches the V1 toast function so the shared account,
 * token, and error components can be reused unchanged.
 */
type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

const logToast: ToastFunction = (message, variant) => {
  if (variant === 'error') logger.error(message, new Error(message))
  else if (variant === 'warning') logger.warn(message)
  else logger.log(message)
}

export interface KiroExecution {
  sdkResponse: unknown
  prepared: SdkPreparedRequest
}

/**
 * Account pool and request machinery for the V2 provider.
 *
 * The provider package runs in its own module scope with no access to the
 * plugin context, so it owns its account state and reads credentials straight
 * from the plugin database. This is what lets the provider work with
 * `activation: "enabled"` and no OpenCode-side connection.
 */
export class KiroExecutor {
  private readonly accountSelector: AccountSelector
  private readonly tokenRefresher: TokenRefresher
  private readonly errorHandler: ErrorHandler
  private readonly usageTracker: UsageTracker
  private readonly retryStrategy: RetryStrategy

  private constructor(
    private readonly config: KiroConfig,
    private readonly accountManager: AccountManager,
    repository: AccountRepository
  ) {
    this.accountSelector = new AccountSelector(accountManager, config, syncFromKiroCli, repository)
    this.tokenRefresher = new TokenRefresher(config, accountManager, syncFromKiroCli, repository)
    this.errorHandler = new ErrorHandler(config, accountManager, repository)
    this.usageTracker = new UsageTracker(config, accountManager, repository)
    this.retryStrategy = new RetryStrategy(config)
  }

  static async create(directory: string = process.cwd()): Promise<KiroExecutor> {
    const config = loadConfig(directory)
    const repository = new AccountRepository(new AccountCache(60000))
    const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
    return new KiroExecutor(config, accountManager, repository)
  }

  /**
   * Select an account, refresh its token if needed, and issue the Kiro request,
   * rotating accounts and retrying on the error classes the shared
   * `ErrorHandler` marks as retryable.
   */
  async execute(body: unknown, modelID: string, effort?: string): Promise<KiroExecution> {
    const think = effort !== undefined && effort !== 'none'
    let retry = 0
    let bearerRetried = false
    let consecutiveNullAccounts = 0
    const retryContext = this.retryStrategy.createContext()

    while (true) {
      const check = this.retryStrategy.shouldContinue(retryContext)
      if (!check.canContinue) throw new Error(check.error)

      if (this.allAccountsPermanentlyUnhealthy()) {
        throw new Error(
          'All Kiro accounts are permanently unhealthy. Re-authenticate with the Kiro CLI or OpenCode 1.x.'
        )
      }

      let account = await this.accountSelector.selectHealthyAccount(logToast)
      if (!account) {
        consecutiveNullAccounts += 1
        await this.sleep(Math.min(1000 * 2 ** (consecutiveNullAccounts - 1), 10000))
        continue
      }
      consecutiveNullAccounts = 0

      const auth = this.accountManager.toAuthDetails(account)
      const tokenResult = await this.tokenRefresher.refreshIfNeeded(account, auth, logToast)
      if (tokenResult.shouldContinue) {
        account = tokenResult.account
        await this.sleep(500)
        continue
      }

      const prepared = transformToSdkRequest(body, modelID, auth, think, 0, logToast, {
        effort: (effort ?? this.config.effort) as KiroConfig['effort'],
        autoEffortMapping: this.config.auto_effort_mapping
      })

      try {
        const client = createSdkClient(
          auth,
          prepared.region,
          prepared.effort,
          prepared.effortSchemaPath
        )
        const sdkResponse = await client.send(
          new GenerateAssistantResponseCommand({
            conversationState: prepared.conversationState as never,
            profileArn: prepared.profileArn
          })
        )

        this.markHealthy(account)
        this.usageTracker.syncUsage(account, auth)
        return { sdkResponse, prepared }
      } catch (e: unknown) {
        const error = e as {
          $metadata?: { httpStatusCode?: number }
          message?: string
          name?: string
        }
        const httpStatus = error?.$metadata?.httpStatusCode

        if (
          httpStatus === 403 &&
          !bearerRetried &&
          /bearer token.*is invalid/i.test(error.message ?? '')
        ) {
          bearerRetried = true
          logger.warn('403 bearer invalid, forcing token refresh and retrying')
          await this.tokenRefresher.forceRefresh(
            account,
            this.accountManager.toAuthDetails(account)
          )
          continue
        }

        if (!httpStatus) {
          const network = await this.errorHandler.handleNetworkError(e, { retry }, logToast)
          if (network.shouldRetry) {
            if (network.newContext) retry = network.newContext.retry
            continue
          }
          throw e
        }

        const mock = new Response(JSON.stringify({ message: error.message, __type: error.name }), {
          status: httpStatus,
          statusText: error.name || 'Error',
          headers: { 'Content-Type': 'application/json' }
        })

        const handled = await this.errorHandler.handle(
          e,
          mock,
          account,
          { retry, bearerRetried },
          logToast
        )

        if (handled.shouldRetry) {
          if (handled.newContext) {
            retry = handled.newContext.retry
            bearerRetried = handled.newContext.bearerRetried ?? bearerRetried
          }
          if (handled.forceRefresh) {
            await this.tokenRefresher.forceRefresh(
              account,
              this.accountManager.toAuthDetails(account)
            )
          }
          continue
        }

        throw new Error(error.message || `Kiro Error: ${httpStatus}`)
      }
    }
  }

  private markHealthy(account: ManagedAccount): void {
    if (!account.failCount || account.failCount === 0) return
    if (isPermanentError(account.unhealthyReason)) return
    account.failCount = 0
    account.isHealthy = true
    delete account.unhealthyReason
    delete account.recoveryTime
  }

  private allAccountsPermanentlyUnhealthy(): boolean {
    const accounts = this.accountManager.getAccounts()
    if (accounts.length === 0) return false
    return accounts.every((a) => !a.isHealthy && isPermanentError(a.unhealthyReason))
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

let cached: Promise<KiroExecutor> | undefined

/**
 * The host builds a model more than once per run — auxiliary requests such as
 * title generation construct their own. Sharing one executor keeps the account
 * pool, rate-limit state, and database handle single per process.
 */
export function sharedExecutor(): Promise<KiroExecutor> {
  cached ??= KiroExecutor.create()
  return cached
}

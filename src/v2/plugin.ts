import { Plugin } from '@opencode/plugin'
import * as logger from '../plugin/logger.js'
import {
  buildV2Models,
  buildV2Provider,
  KIRO_PROVIDER_ID,
  resolveProviderPackage
} from './model-registry.js'

/**
 * V2 plugin setup.
 *
 * V1 and V2 share one default export: V1 calls `server()`, V2 calls `setup()`.
 * The two implementations stay independent — V2 hooks are registered through
 * the context rather than returned as an object.
 */
export const KiroV2Plugin = Plugin.define({
  id: KIRO_PROVIDER_ID,
  async setup(ctx) {
    // Resolve once so the provider entry and every model agree on the runtime.
    const providerPackage = resolveProviderPackage()
    const models = buildV2Models(providerPackage)
    const info = buildV2Provider(providerPackage)

    await ctx.provider.transform((editor) => {
      editor.add({ info, models })
    })

    logger.log('V2 provider registered', {
      provider: KIRO_PROVIDER_ID,
      models: models.length,
      package: info.package
    })
  }
})

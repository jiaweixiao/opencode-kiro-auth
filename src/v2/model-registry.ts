import { Model, Provider } from '@opencode/plugin'
import { getSupportedEffortLevels, supportsEffort } from '../plugin/effort.js'
import { MODEL_SPECS, type ModelSpec } from '../plugin/model-registry.js'
import { resolveKiroModel } from '../plugin/models.js'

/** Provider ID advertised to OpenCode V2. Matches the V1 provider ID. */
export const KIRO_PROVIDER_ID = 'kiro'

/** Published subpath that exports `model(modelID, settings)`. */
export const KIRO_PROVIDER_SUBPATH = '@zhafron/opencode-kiro-auth/provider'

/**
 * Locate the provider runtime for `Provider.Info.package`.
 *
 * The host resolves a provider package by checking its built-in table, then
 * `file://` and `@opencode/ai/` prefixes, then `import.meta.resolve`, and
 * finally by installing the name from npm. `import.meta.resolve` runs inside
 * the host's own bundle, so a bare package name does not resolve to a locally
 * loaded plugin and silently falls through to the npm install path — which
 * fetches the published version instead of the code that is running.
 *
 * Deriving an absolute `file://` URL from this module keeps the provider
 * runtime pinned to the same copy as the plugin. The sibling extension is
 * matched to this module's own, because a local plugin runs from `.ts` sources
 * under Bun while a published install runs from compiled `.js`.
 */
export function resolveProviderPackage(): string {
  try {
    const self = import.meta.url
    const extension = self.endsWith('.ts') ? '.ts' : '.js'
    return new URL(`./provider/index${extension}`, self).href
  } catch {
    return KIRO_PROVIDER_SUBPATH
  }
}

/**
 * V1 advertised reasoning models as separate `-thinking` IDs because the V1
 * model schema had no first-class notion of a reasoning level. V2 models carry
 * `variants`, so a single base model exposes its effort ladder and the
 * `-thinking` companions are no longer needed.
 *
 * Variant settings are merged into the settings passed to
 * `model(modelID, settings)`, so `effort` arrives before model construction.
 */
function buildVariants(kiroModel: string): Model.Info['variants'] {
  return getSupportedEffortLevels(kiroModel).map((level) => ({
    id: Model.VariantID.make(level),
    settings: { effort: level }
  }))
}

function buildModel(modelID: string, spec: ModelSpec, providerPackage: string): Model.Info {
  const providerID = Provider.ID.make(KIRO_PROVIDER_ID)
  const base = Model.Info.default(providerID, Model.ID.make(modelID))

  const kiroModel = resolveKiroModel(modelID)
  const reasoning = supportsEffort(kiroModel)

  return {
    ...base,
    name: `${spec.name} (${spec.rate})`,
    limit: { context: spec.limit.context, output: spec.limit.output },
    capabilities: {
      tools: true,
      input: [...spec.modalities.input],
      output: [...spec.modalities.output]
    },
    variants: reasoning ? buildVariants(kiroModel) : [],
    package: providerPackage
  }
}

/** Every Kiro model, as V2 `Model.Info`. */
export function buildV2Models(providerPackage = resolveProviderPackage()): Model.Info[] {
  return Object.entries(MODEL_SPECS).map(([modelID, spec]) =>
    buildModel(modelID, spec, providerPackage)
  )
}

/**
 * Provider definition for `ctx.provider.transform`.
 *
 * `activation: "enabled"` with no `integrationID` keeps the provider usable
 * from credentials this plugin manages in its own database, without requiring
 * an OpenCode-side connection.
 */
export function buildV2Provider(providerPackage = resolveProviderPackage()): Provider.Info {
  const providerID = Provider.ID.make(KIRO_PROVIDER_ID)

  return {
    ...Provider.Info.empty(providerID),
    name: 'Kiro',
    activation: 'enabled',
    package: providerPackage
  }
}

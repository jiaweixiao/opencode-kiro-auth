import { MODEL_MAPPING, SUPPORTED_MODELS, isLongContextModel } from '../constants'
import { MODEL_SPECS } from './model-specs.js'

export function resolveKiroModel(model: string): string {
  const resolved = MODEL_MAPPING[model]
  if (!resolved) {
    throw new Error(`Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(', ')}`)
  }
  return resolved
}

const DEFAULT_CONTEXT_WINDOW = 200000

/**
 * Context window for a model, used to turn Kiro's context-usage percentage into
 * a token count.
 *
 * Callers pass different ID spaces: the V1 streaming path forwards the
 * OpenCode slug (possibly with a `-thinking` suffix), while the V2 provider
 * forwards the resolved Kiro wire ID. Advertised model IDs match their wire ID
 * exactly, so one MODEL_SPECS lookup serves both; anything else falls back to
 * the `-1m` suffix convention and then to Kiro's standard window.
 */
export function getContextWindowSize(model: string): number {
  const base = model.endsWith('-thinking') ? model.slice(0, -'-thinking'.length) : model

  const spec = MODEL_SPECS[base] ?? MODEL_SPECS[model]
  if (spec) return spec.limit.context

  return isLongContextModel(base) ? 1000000 : DEFAULT_CONTEXT_WINDOW
}

import { getSupportedEffortLevels, supportsEffort, THINKING_BUDGETS } from './effort.js'
import { MODEL_SPECS } from './model-specs.js'
import { resolveKiroModel } from './models.js'

export { MODEL_SPECS } from './model-specs.js'
export type { Modalities, ModelSpec } from './model-specs.js'

/**
 * Build the thinking variants a model supports.
 *
 * Levels come from the model's own effort capabilities, so xhigh only appears on
 * models that accept it and the budgets stay in step with budgetToEffort.
 */
function buildVariants(kiroModel: string): Record<string, unknown> {
  const variants: Record<string, unknown> = {}

  for (const level of getSupportedEffortLevels(kiroModel)) {
    variants[level] = { thinkingConfig: { thinkingBudget: THINKING_BUDGETS[level] } }
  }

  return variants
}

/**
 * Model registry advertised to OpenCode.
 *
 * Reasoning-capable entries carry `reasoning` and `interleaved`. Both are
 * required: `reasoning` declares the capability, and `interleaved.field` tells
 * OpenCode that reasoning arrives in the non-standard `reasoning_content` delta
 * this plugin emits (see streaming/openai-converter.ts). Without them OpenCode
 * silently drops every reasoning chunk and no thinking block is rendered.
 *
 * Reasoning depth is selected through variants on the base model. Earlier
 * versions advertised a separate `-thinking` companion per model; those IDs
 * still resolve for existing sessions but are no longer offered.
 */
export function buildModelRegistry(): Record<string, unknown> {
  const models: Record<string, unknown> = {}

  for (const [modelID, spec] of Object.entries(MODEL_SPECS)) {
    const base: Record<string, unknown> = {
      name: `${spec.name} (${spec.rate})`,
      limit: spec.limit,
      modalities: spec.modalities
    }

    const kiroModel = resolveKiroModel(modelID)
    if (!supportsEffort(kiroModel)) {
      models[modelID] = base
      continue
    }

    models[modelID] = {
      ...base,
      reasoning: true,
      interleaved: { field: 'reasoning_content' },
      variants: buildVariants(kiroModel)
    }
  }

  return models
}

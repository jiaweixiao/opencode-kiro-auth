export type Modalities = {
  input: Array<'text' | 'image' | 'pdf'>
  output: ['text']
}

const TEXT_ONLY: Modalities = { input: ['text'], output: ['text'] }
const MULTIMODAL: Modalities = { input: ['text', 'image', 'pdf'], output: ['text'] }

const CONTEXT_1M = { context: 1000000, output: 64000 }

export interface ModelSpec {
  /** Display name, without the credit multiplier suffix. */
  name: string
  /** Kiro credit multiplier, rendered into the display name. */
  rate: string
  limit: { context: number; output: number }
  modalities: Modalities
}

/**
 * Models advertised to OpenCode, keyed by the OpenCode-facing model ID. The set
 * and its multipliers track what `kiro-cli` currently offers; model IDs match
 * Kiro's wire IDs exactly, so a context-window lookup resolves from either.
 *
 * Reasoning capability is not declared here. It comes from `supportsEffort()`
 * in effort.ts, which is keyed by the same wire ID and is the single source of
 * truth for which effort levels a model accepts.
 *
 * Kiro resolves more IDs than this (see MODEL_MAPPING in constants.ts). Those
 * stay resolvable for existing sessions and hand-written config, but are not
 * offered in the model picker.
 */
export const MODEL_SPECS: Record<string, ModelSpec> = {
  'claude-opus-5.5': {
    name: 'Claude Opus 5.5',
    rate: '2.00x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL
  },
  'claude-sonnet-5.5': {
    name: 'Claude Sonnet 5.5',
    rate: '1.30x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL
  },
  'gpt-5.6-sol': {
    name: 'GPT-5.6 Sol',
    rate: '4.40x',
    limit: CONTEXT_1M,
    modalities: TEXT_ONLY
  },
  'gpt-5.6-terra': {
    name: 'GPT-5.6 Terra',
    rate: '2.20x',
    limit: CONTEXT_1M,
    modalities: TEXT_ONLY
  },
  'claude-opus-5': {
    name: 'Claude Opus 5',
    rate: '2.20x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL
  },
  'claude-sonnet-5': {
    name: 'Claude Sonnet 5',
    rate: '1.30x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL
  }
}

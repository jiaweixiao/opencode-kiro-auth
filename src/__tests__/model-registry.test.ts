import { describe, expect, test } from 'bun:test'
import { SUPPORTED_MODELS } from '../constants.js'
import type { Effort } from '../plugin/config/schema.js'
import { budgetToEffort, THINKING_BUDGETS } from '../plugin/effort.js'
import { buildModelRegistry } from '../plugin/model-registry.js'
import { getContextWindowSize, resolveKiroModel } from '../plugin/models.js'

const registry = buildModelRegistry() as Record<string, any>

/** The exact set `kiro-cli` offers that this plugin advertises. */
const ADVERTISED_MODELS = [
  'claude-opus-5.5',
  'claude-sonnet-5.5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'claude-opus-5',
  'claude-sonnet-5'
]

const GPT_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra']

const reasoningIDs = Object.entries(registry)
  .filter(([, model]) => model.reasoning === true)
  .map(([id]) => id)

describe('model registry', () => {
  test('advertises exactly the models kiro-cli offers', () => {
    expect(Object.keys(registry).sort()).toEqual([...ADVERTISED_MODELS].sort())
  })

  test('every advertised model is resolvable to a Kiro model ID', () => {
    for (const modelID of Object.keys(registry)) {
      expect(SUPPORTED_MODELS).toContain(modelID)
    }
  })

  // Reasoning depth is selected through variants on the base model. The older
  // `-thinking` companions still resolve for existing sessions but must not be
  // advertised, or the picker shows each model twice.
  test('advertises no -thinking companion models', () => {
    expect(Object.keys(registry).filter((id) => id.endsWith('-thinking'))).toEqual([])
  })

  test('renders the credit multiplier into the display name', () => {
    expect(registry['claude-opus-5.5'].name).toBe('Claude Opus 5.5 (2.00x)')
    expect(registry['claude-sonnet-5.5'].name).toBe('Claude Sonnet 5.5 (1.30x)')
    expect(registry['gpt-5.6-sol'].name).toBe('GPT-5.6 Sol (4.40x)')
    expect(registry['gpt-5.6-terra'].name).toBe('GPT-5.6 Terra (2.20x)')
    expect(registry['claude-opus-5'].name).toBe('Claude Opus 5 (2.20x)')
    expect(registry['claude-sonnet-5'].name).toBe('Claude Sonnet 5 (1.30x)')
  })

  test('advertises a 1M context window on every model', () => {
    for (const modelID of ADVERTISED_MODELS) {
      expect(registry[modelID].limit).toEqual({ context: 1000000, output: 64000 })
    }
  })

  // The registry limit and the token accounting in the streaming paths read
  // from different functions. They have to agree, or context usage is scaled
  // against the wrong window.
  test('token accounting uses the advertised context window', () => {
    for (const modelID of ADVERTISED_MODELS) {
      expect(getContextWindowSize(modelID)).toBe(registry[modelID].limit.context)
      expect(getContextWindowSize(resolveKiroModel(modelID))).toBe(registry[modelID].limit.context)
    }
  })

  test('carries input modalities', () => {
    expect(registry['claude-opus-5'].modalities.input).toEqual(['text', 'image', 'pdf'])
    expect(registry['gpt-5.6-sol'].modalities.input).toEqual(['text'])
  })

  describe('reasoning capability flags', () => {
    // Both are required: `reasoning` declares the capability, `interleaved.field`
    // tells OpenCode reasoning arrives as `reasoning_content` deltas. Missing
    // either one means reasoning chunks are silently dropped.
    test('every advertised model declares reasoning and the reasoning_content field', () => {
      expect(reasoningIDs.sort()).toEqual([...ADVERTISED_MODELS].sort())

      for (const id of reasoningIDs) {
        expect(registry[id].reasoning).toBe(true)
        expect(registry[id].interleaved).toEqual({ field: 'reasoning_content' })
      }
    })
  })

  describe('reasoning variants', () => {
    test('offers the full ladder on Claude models', () => {
      for (const id of ADVERTISED_MODELS.filter((m) => !GPT_MODELS.includes(m))) {
        expect(Object.keys(registry[id].variants)).toEqual([
          'low',
          'medium',
          'high',
          'xhigh',
          'max'
        ])
      }
    })

    // GPT-5.6 sends effort as `reasoning.effort` and rejects `max`.
    test('omits max on GPT models', () => {
      for (const id of GPT_MODELS) {
        expect(Object.keys(registry[id].variants)).toEqual(['low', 'medium', 'high', 'xhigh'])
      }
    })

    test('variant budgets map back to the effort level they are named for', () => {
      for (const id of reasoningIDs) {
        const kiroModel = resolveKiroModel(id)
        for (const [name, variant] of Object.entries<any>(registry[id].variants)) {
          const level = name as Effort
          const budget = variant.thinkingConfig.thinkingBudget
          expect(budget).toBe(THINKING_BUDGETS[level])
          expect(budgetToEffort(budget, kiroModel)).toBe(level)
        }
      }
    })

    test('variants are ordered low to max', () => {
      for (const id of reasoningIDs) {
        const budgets = Object.values<any>(registry[id].variants).map(
          (v) => v.thinkingConfig.thinkingBudget
        )
        expect(budgets).toEqual([...budgets].sort((a, b) => a - b))
      }
    })
  })
})

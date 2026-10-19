import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pluginModule from '../index.js'
import {
  buildV2Models,
  buildV2Provider,
  KIRO_PROVIDER_SUBPATH,
  resolveProviderPackage
} from '../v2/model-registry.js'

describe('package plugin module', () => {
  test('uses the kiro provider id in the default export', () => {
    expect(pluginModule.id).toBe('kiro')
  })

  // OpenCode 1.x calls server(); OpenCode 2.x calls setup(). Both must be
  // present on the single default export for one package to serve both.
  test('exposes the V1 server entrypoint', () => {
    expect(typeof pluginModule.server).toBe('function')
  })

  test('exposes the V2 setup entrypoint', () => {
    expect(typeof pluginModule.setup).toBe('function')
  })
})

describe('v2 provider registration', () => {
  test('activates without an OpenCode integration', () => {
    const info = buildV2Provider()
    // Credentials live in this plugin's own database, so the provider must be
    // usable with no OpenCode-side connection.
    expect(info.activation).toBe('enabled')
    expect(info.integrationID).toBeUndefined()
  })

  // The host resolves `package` from inside its own bundle, so a bare package
  // name falls through to an npm install of the *published* version rather
  // than the copy being loaded. An absolute file URL pins both to one copy.
  test('resolves the provider runtime to a concrete file URL', () => {
    const resolved = resolveProviderPackage()
    expect(resolved.startsWith('file://')).toBe(true)
    expect(resolved).toContain('/provider/index.')
  })

  // A local plugin runs from .ts sources under Bun; a published install runs
  // from compiled .js. The runtime path has to follow whichever is loaded, or
  // the host resolves a file that does not exist.
  test('matches the provider extension to the loaded module', () => {
    const resolved = resolveProviderPackage()
    const expected = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
    expect(resolved.endsWith(`/provider/index${expected}`)).toBe(true)
    expect(existsSync(fileURLToPath(resolved))).toBe(true)
  })

  test('declares the published subpath for installed trees', () => {
    expect(KIRO_PROVIDER_SUBPATH).toBe('@zhafron/opencode-kiro-auth/provider')
  })

  test('points the provider and every model at the same runtime', () => {
    const info = buildV2Provider()
    for (const model of buildV2Models()) {
      expect(model.package).toBe(info.package)
      expect(model.providerID as string).toBe('kiro')
    }
  })
})

describe('v2 reasoning models', () => {
  const models = buildV2Models()
  const byID = new Map(models.map((model) => [model.id as string, model]))

  // V1 advertised reasoning as separate `-thinking` model IDs. V2 carries
  // `variants`, so the companions are gone.
  test('drops the -thinking companion models', () => {
    expect(models.filter((model) => (model.id as string).endsWith('-thinking'))).toHaveLength(0)
  })

  test('exposes the full effort ladder on xhigh-capable Claude models', () => {
    expect(byID.get('claude-sonnet-5')?.variants.map((v) => v.id as string)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
  })

  test('omits xhigh on Claude models that do not accept it', () => {
    expect(byID.get('claude-sonnet-4-5')?.variants.map((v) => v.id as string)).toEqual([
      'low',
      'medium',
      'high',
      'max'
    ])
  })

  // GPT-5.6 uses reasoning.effort and rejects the plugin's `max` level.
  test('omits max on GPT models', () => {
    expect(byID.get('gpt-5.6-sol')?.variants.map((v) => v.id as string)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh'
    ])
  })

  test('leaves non-reasoning models without variants', () => {
    expect(byID.get('claude-haiku-4-5')?.variants).toEqual([])
    expect(byID.get('glm-5')?.variants).toEqual([])
  })

  test('carries the effort level in variant settings', () => {
    const high = byID.get('claude-opus-5')?.variants.find((v) => v.id === 'high')
    expect(high?.settings).toEqual({ effort: 'high' })
  })
})

describe('v2 model metadata', () => {
  const byID = new Map(buildV2Models().map((model) => [model.id as string, model]))

  test('preserves context and output limits', () => {
    expect(byID.get('claude-sonnet-5')?.limit).toEqual({ context: 1000000, output: 64000 })
    expect(byID.get('gpt-5.6-sol')?.limit).toEqual({ context: 272000, output: 64000 })
  })

  test('preserves input modalities', () => {
    expect(byID.get('claude-opus-5')?.capabilities.input).toEqual(['text', 'image', 'pdf'])
    expect(byID.get('claude-haiku-4-5')?.capabilities.input).toEqual(['text', 'image'])
    expect(byID.get('glm-5')?.capabilities.input).toEqual(['text'])
  })

  test('renders the credit multiplier into the display name', () => {
    expect(byID.get('claude-opus-5')?.name).toBe('Claude Opus 5 (2.2x)')
  })
})

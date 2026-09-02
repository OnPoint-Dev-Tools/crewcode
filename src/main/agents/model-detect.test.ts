import { describe, expect, it, vi } from 'vitest'

import { contextWindowFor } from './model-context'
import { applyPiEnabledModelScope, modelsFromPiEnabledModelPatterns, parseContextWindowToken, parsePiListing, registerDetectedModelContextWindows } from './model-detect'

describe('model detection context metadata', () => {
  it('parses compact token-window values from provider catalogs', () => {
    expect(parseContextWindowToken('272K')).toBe(272_000)
    expect(parseContextWindowToken('204.8K')).toBe(204_800)
    expect(parseContextWindowToken('1M')).toBe(1_000_000)
    expect(parseContextWindowToken('1.1M')).toBe(1_100_000)
  })

  it('keeps Pi context metadata and registers it for usage calculations', () => {
    const models = parsePiListing(`provider      model                    context  max-out  thinking  images\nproviderx     claude-sonnet-ctx-test   750K     64K      yes       yes`)

    expect(models).toEqual([
      { id: 'providerx/claude-sonnet-ctx-test', label: 'claude-sonnet-ctx-test', provider: 'providerx', contextWindow: 750_000 },
    ])

    registerDetectedModelContextWindows(models)

    // Metadata must win over the generic /claude/ 200k fallback.
    expect(contextWindowFor('providerx/claude-sonnet-ctx-test')).toBe(750_000)
    expect(contextWindowFor('claude-sonnet-ctx-test')).toBe(750_000)
  })

  it('builds concrete Pi enabledModels without spawning pi', () => {
    expect(modelsFromPiEnabledModelPatterns([
      'openai-codex/gpt-5.5',
      'opencode-go/kimi-k2.6:high',
    ], 'openai-codex')).toEqual([
      { id: 'openai-codex/gpt-5.5', label: 'gpt-5.5', provider: 'openai-codex' },
      { id: 'opencode-go/kimi-k2.6', label: 'kimi-k2.6', provider: 'opencode-go' },
    ])
  })

  it('falls back to pi listing when enabledModels contains globs', () => {
    expect(modelsFromPiEnabledModelPatterns(['opencode-go/kimi-*'], 'openai-codex')).toEqual([])
  })

  it('applies Pi enabledModels scope in saved order', () => {
    const models = parsePiListing(`provider      model                    context  max-out  thinking  images
openai-codex  gpt-5.5                  272K     128K     yes       yes
opencode      kimi-k2.6                262K     64K      yes       yes
opencode      claude-sonnet-4-6        1M       64K      yes       yes`)

    expect(applyPiEnabledModelScope(models, ['opencode/kimi-*', 'gpt-5.5:high']).map(model => model.id)).toEqual([
      'opencode/kimi-k2.6',
      'openai-codex/gpt-5.5',
    ])
  })

  it('keeps all Pi models when enabledModels patterns are stale', () => {
    const models = parsePiListing(`provider      model                    context  max-out  thinking  images
openai-codex  gpt-5.5                  272K     128K     yes       yes`)

    expect(applyPiEnabledModelScope(models, ['not-a-real-model'])).toEqual(models)
  })
})

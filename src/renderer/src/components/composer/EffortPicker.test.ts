import { describe, expect, it } from 'vitest'

import { effortRowsForProvider, providerSupportsEffort } from './EffortPicker'

describe('provider effort options', () => {
  it('exposes Claude native max effort', () => {
    expect(effortRowsForProvider('claude').map(row => row.id)).toEqual([
      'off', 'low', 'medium', 'high', 'xhigh', 'max',
    ])
    expect(providerSupportsEffort('claude', 'max')).toBe(true)
  })

  it('exposes Codex max and ultra without leaking ultra to Claude', () => {
    expect(effortRowsForProvider('codex').map(row => row.id)).toEqual([
      'off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
    ])
    expect(providerSupportsEffort('codex', 'max')).toBe(true)
    expect(providerSupportsEffort('codex', 'ultra')).toBe(true)
    expect(providerSupportsEffort('claude', 'ultra')).toBe(false)
  })

  it('shows only effort levels each newly wired provider accepts', () => {
    expect(effortRowsForProvider('crewcoder').map(row => row.id)).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(effortRowsForProvider('openrouter').map(row => row.id)).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    expect(effortRowsForProvider('ollama').map(row => row.id)).toEqual(['off', 'low', 'medium', 'high'])
    expect(effortRowsForProvider('opencode').map(row => row.id)).toEqual(['off', 'low', 'medium', 'high', 'xhigh'])
    expect(effortRowsForProvider('hermes')).toEqual([])
  })

  it('exposes only Grok\'s three native efforts and no off', () => {
    // Grok has no "off"; offering one would silently clamp to low at spawn.
    expect(effortRowsForProvider('grok').map(row => row.id)).toEqual(['low', 'medium', 'high'])
    expect(providerSupportsEffort('grok', 'off')).toBe(false)
    expect(providerSupportsEffort('grok', 'xhigh')).toBe(false)
    expect(providerSupportsEffort('grok', 'high')).toBe(true)
  })
})

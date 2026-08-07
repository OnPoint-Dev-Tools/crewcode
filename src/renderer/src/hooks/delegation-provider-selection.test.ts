import { describe, it, expect } from 'vitest'
import {
  describeProviders,
  isSelectionError,
  resolveProviderSelection,
} from './delegation-provider-selection'
import type { DelegationProviderInfo } from '../../../shared/delegation-types'
import type { AgentInfo } from '../types'

const agent = (over: Partial<AgentInfo> & { id: string }): AgentInfo => ({
  name: over.id,
  path: `/usr/bin/${over.id}`,
  available: true,
  transport: 'bridge',
  ...over,
})

const provider = (over: Partial<DelegationProviderInfo> & { id: string }): DelegationProviderInfo => ({
  name: over.id,
  available: true,
  models: [],
  ...over,
})

describe('describeProviders', () => {
  it('reports each provider with its models and default', () => {
    const result = describeProviders(
      [agent({ id: 'claude' })],
      () => ['sonnet', 'opus'],
      () => 'sonnet',
    )
    expect(result).toEqual([{
      id: 'claude', name: 'claude', available: true, models: ['sonnet', 'opus'], defaultModel: 'sonnet',
    }])
  })

  // An agent that can see *why* a provider is unusable can tell the user to fix
  // it, instead of silently substituting a different model.
  it('explains why an unavailable provider cannot be used', () => {
    const result = describeProviders(
      [
        agent({ id: 'openrouter', available: false, requiresApiKey: true, hasKey: false }),
        agent({ id: 'ollama', available: false, path: null }),
      ],
      () => [],
      () => undefined,
    )
    expect(result[0]).toMatchObject({ available: false, unavailableReason: 'no API key configured' })
    expect(result[1]).toMatchObject({ available: false, unavailableReason: 'binary not found in PATH' })
  })
})

describe('resolveProviderSelection', () => {
  const parent = { agentId: 'claude', model: 'sonnet' }
  const providers = [
    provider({ id: 'claude', models: ['sonnet', 'opus'], defaultModel: 'sonnet' }),
    provider({ id: 'codex', models: ['gpt-5.5'], defaultModel: 'gpt-5.5' }),
    provider({ id: 'openrouter', available: false, unavailableReason: 'no API key configured' }),
    // Providers that only learn their models at start can't be validated against.
    provider({ id: 'pi', models: [] }),
  ]

  it('falls back to the parent provider and model', () => {
    expect(resolveProviderSelection({}, parent, providers)).toEqual({ agentId: 'claude', model: 'sonnet' })
  })

  it('accepts an explicit provider and model', () => {
    expect(resolveProviderSelection({ agentId: 'codex', model: 'gpt-5.5' }, parent, providers))
      .toEqual({ agentId: 'codex', model: 'gpt-5.5' })
  })

  // A model id is provider-specific: carrying the parent's across a provider
  // switch guarantees a failure at bridge start.
  it('does not carry the parent model onto a different provider', () => {
    expect(resolveProviderSelection({ agentId: 'codex' }, parent, providers))
      .toEqual({ agentId: 'codex', model: 'gpt-5.5' })
  })

  it('rejects an unknown provider and names the available ones', () => {
    const result = resolveProviderSelection({ agentId: 'gpt-luna' }, parent, providers)
    expect(isSelectionError(result)).toBe(true)
    const error = (result as { error: string }).error
    expect(error).toContain('unknown provider "gpt-luna"')
    expect(error).toContain('claude')
    expect(error).toContain('codex')
    // Unavailable providers must not be offered as alternatives.
    expect(error).not.toContain('openrouter')
  })

  it('rejects a provider that exists but cannot run, with the reason', () => {
    const result = resolveProviderSelection({ agentId: 'openrouter' }, parent, providers)
    expect(isSelectionError(result)).toBe(true)
    expect((result as { error: string }).error).toContain('no API key configured')
  })

  it('rejects an unknown model and names known ones', () => {
    const result = resolveProviderSelection({ agentId: 'claude', model: 'haiku-9' }, parent, providers)
    expect(isSelectionError(result)).toBe(true)
    const error = (result as { error: string }).error
    expect(error).toContain('unknown model "haiku-9"')
    expect(error).toContain('sonnet')
  })

  // Rejecting here would refuse a model that would actually have worked.
  it('passes a model through when the provider reports no catalogue', () => {
    expect(resolveProviderSelection({ agentId: 'pi', model: 'anything/at-all' }, parent, providers))
      .toEqual({ agentId: 'pi', model: 'anything/at-all' })
  })

  it('treats blank strings as absent rather than invalid', () => {
    expect(resolveProviderSelection({ agentId: '  ', model: '  ' }, parent, providers))
      .toEqual({ agentId: 'claude', model: 'sonnet' })
  })

  it('reports no options when nothing is configured', () => {
    const result = resolveProviderSelection({ agentId: 'claude' }, parent, [provider({ id: 'claude', available: false })])
    expect((result as { error: string }).error).toContain('(none configured)')
  })
})

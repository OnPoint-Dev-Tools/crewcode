import { describe, expect, it } from 'vitest'
import { dockUsageProviderId } from './dock-usage-provider'

describe('dockUsageProviderId', () => {
  it('uses direct rate-limit providers unchanged', () => {
    expect(dockUsageProviderId('codex', 'gpt-5.4')).toBe('codex')
    expect(dockUsageProviderId('claude', 'claude-sonnet-4-6')).toBe('claude')
    expect(dockUsageProviderId('opencode', '')).toBe('opencode')
  })

  it('uses a CrewCoder colon-prefixed upstream provider', () => {
    expect(dockUsageProviderId('crewcoder', 'codex:gpt-5.4')).toBe('codex')
    expect(dockUsageProviderId('crewcoder', 'claude:claude-sonnet-4-6')).toBe('claude')
    expect(dockUsageProviderId('crewcoder', 'opencode:anthropic/claude-sonnet-4-6')).toBe('opencode')
  })

  it('normalizes upstream aliases used by detected models', () => {
    expect(dockUsageProviderId('crewcoder', 'anthropic:claude-opus-4-8')).toBe('claude')
    expect(dockUsageProviderId('crewcoder', 'openai-codex:gpt-5.4')).toBe('codex')
    expect(dockUsageProviderId('pi', 'opencode-go/kimi-2.6')).toBe('opencode')
  })

  it('supports slash-prefixed providers for other wrapper agents', () => {
    expect(dockUsageProviderId('pi', 'codex/gpt-5.4')).toBe('codex')
    expect(dockUsageProviderId('custom-agent', 'anthropic/claude-sonnet-4-6')).toBe('claude')
  })

  it('falls back to the agent when the model has no supported provider prefix', () => {
    expect(dockUsageProviderId('crewcoder', '')).toBe('crewcoder')
    expect(dockUsageProviderId('crewcoder', 'gpt-5.4')).toBe('crewcoder')
    expect(dockUsageProviderId('custom-agent', 'google/gemini-2.5-pro')).toBe('custom-agent')
    expect(dockUsageProviderId('pi', 'openai/gpt-5.4')).toBe('pi')
  })
})

import { describe, expect, it } from 'vitest'
import { contextWindowFor, registerContextWindow, registeredContextWindowFor } from './model-context'

describe('contextWindowFor', () => {
  it('uses CrewCode provider context windows for GPT-5.5 and GPT-5.4 fallbacks', () => {
    expect(contextWindowFor('openai/gpt-5.5')).toBe(400_000)
    expect(contextWindowFor('gpt-5.5')).toBe(400_000)
    expect(contextWindowFor('openai/gpt-5.4')).toBe(400_000)
    expect(contextWindowFor('gpt-5.4')).toBe(400_000)
    // Only the 5.6 family carries the 1.05M window.
    expect(contextWindowFor('gpt-5.6-sol')).toBe(1_050_000)
    expect(contextWindowFor('gpt-5.6-terra')).toBe(1_050_000)
    // The mini variant is smaller than its 5.4 parent.
    expect(contextWindowFor('gpt-5.4-mini')).toBe(200_000)
  })

  it('uses provider catalog metadata when it is registered', () => {
    registerContextWindow('openai/gpt-test-1m', 1_000_000)

    expect(registeredContextWindowFor('openai/gpt-test-1m')).toBe(1_000_000)
    expect(contextWindowFor('openai/gpt-test-1m')).toBe(1_000_000)
    expect(contextWindowFor('gpt-test-1m')).toBe(1_000_000)
  })

  it('keeps exact CrewCode provider windows ahead of catalog aliases', () => {
    // Register a value that differs from the exact rule, otherwise this asserts
    // nothing about precedence.
    registerContextWindow('openai/gpt-5.5', 1_050_000)

    expect(registeredContextWindowFor('openai/gpt-5.5')).toBe(1_050_000)
    expect(contextWindowFor('openai/gpt-5.5')).toBe(400_000)
    expect(contextWindowFor('gpt-5.5')).toBe(400_000)
  })

  it('matches display names to provider catalog ids without guessing by family', () => {
    registerContextWindow('deepseek/deepseek-v4-flash', 1_050_000)

    expect(contextWindowFor('DeepSeek V4 Flash')).toBe(1_050_000)
  })

  it('prefers registered metadata over static family fallbacks', () => {
    registerContextWindow('metadata/claude-sonnet-custom', 750_000)

    expect(contextWindowFor('claude-sonnet-custom')).toBe(750_000)
  })

  it('uses model-specific Claude Code context windows', () => {
    expect(contextWindowFor('claude-opus-4-8')).toBe(500_000)
    expect(contextWindowFor('Claude Opus 4.8 (latest)')).toBe(500_000)
    expect(contextWindowFor('anthropic/claude-opus-4.8')).toBe(500_000)
    expect(contextWindowFor('claude-sonnet-4-6')).toBe(500_000)
  })

  it('does not invent a window for unknown models', () => {
    expect(contextWindowFor('unknown/provider-model')).toBeUndefined()
  })
})

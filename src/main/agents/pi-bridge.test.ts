import { describe, expect, it } from 'vitest'

import { usageFromPiEvent, userVisiblePiStderr } from './pi-bridge'

describe('pi bridge stderr filtering', () => {
  it('suppresses stale scoped-model warnings', () => {
    expect(userVisiblePiStderr('Warning: No models match pattern "opencode-go/deepseek-v4-pro"\n')).toBe('')
  })

  it('keeps non-model-warning stderr visible', () => {
    expect(userVisiblePiStderr('Warning: No models match pattern "opencode-go/kimi-k2.6" Warning: auth failed\n')).toBe('Warning: auth failed')
  })
})

describe('pi bridge usage accounting', () => {
  it('does not treat aggregate totalTokens as live context usage', () => {
    const usage = usageFromPiEvent({
      message: {
        model: 'openai/gpt-5.5',
        usage: {
          input: 15_000,
          output: 500,
          cacheRead: 4_000_000,
          cacheWrite: 20_000,
          totalTokens: 4_035_500,
        },
      },
    }, undefined)

    expect(usage).toMatchObject({
      inputTokens: 15_000,
      outputTokens: 500,
      totalTokens: 15_500,
      contextTokens: 15_500,
      contextWindow: 400_000,
      model: 'openai/gpt-5.5',
    })
  })

  it('uses explicit provider context fields when present', () => {
    const usage = usageFromPiEvent({
      usage: {
        inputTokens: 15_000,
        outputTokens: 500,
        contextTokens: 120_000,
        contextWindow: 1_000_000,
      },
    }, 'model-with-context')

    expect(usage).toMatchObject({
      inputTokens: 15_000,
      outputTokens: 500,
      totalTokens: 15_500,
      contextTokens: 120_000,
      contextWindow: 1_000_000,
      model: 'model-with-context',
    })
  })
})

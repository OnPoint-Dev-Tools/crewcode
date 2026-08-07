import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  net: {
    fetch: vi.fn(),
  },
}))

import { net } from 'electron'
import { registerContextWindow } from './model-context'
import { enrichUsageContextWindow, openRouterContextWindowFor } from './openrouter-model-context'

describe('openRouterContextWindowFor', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('loads context_length from the OpenRouter model catalog', async () => {
    vi.mocked(net.fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: 'test/ctx-model-1m', name: 'Context Model 1M', context_length: 1_000_000 },
        ],
      }),
    } as Response)

    await expect(openRouterContextWindowFor('test/ctx-model-1m')).resolves.toBe(1_000_000)
    await expect(openRouterContextWindowFor('ctx-model-1m')).resolves.toBe(1_000_000)
    await expect(openRouterContextWindowFor('Context Model 1M')).resolves.toBe(1_000_000)
  })

  it('does not overwrite an existing usage context window', async () => {
    registerContextWindow('openai/gpt-5.5', 1_050_000)

    await expect(enrichUsageContextWindow({
      inputTokens: 59_000,
      outputTokens: 304,
      totalTokens: 59_304,
      contextTokens: 59_304,
      contextWindow: 400_000,
      model: 'openai/gpt-5.5',
    })).resolves.toMatchObject({ contextWindow: 400_000 })
  })
})

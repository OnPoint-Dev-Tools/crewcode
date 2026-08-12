import { describe, expect, it, vi } from 'vitest'

import { promptCrewBridgeWithRecovery } from './crew-bridge-recovery'

describe('promptCrewBridgeWithRecovery', () => {
  it('restarts and retries once when a stopped lane bridge is no longer registered', async () => {
    const prompt = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'bridge not found' })
      .mockResolvedValueOnce({ ok: true })
    const restart = vi.fn(async () => ({ bridgeId: 'bridge-new', prompt: 'worker preamble\n\nsecond prompt' }))

    await expect(promptCrewBridgeWithRecovery(
      { bridgeId: 'bridge-old', prompt: 'second prompt' },
      prompt,
      restart,
    )).resolves.toEqual({ ok: true })

    expect(restart).toHaveBeenCalledOnce()
    expect(prompt).toHaveBeenNthCalledWith(1, 'bridge-old', 'second prompt')
    expect(prompt).toHaveBeenNthCalledWith(2, 'bridge-new', 'worker preamble\n\nsecond prompt')
  })

  it('does not restart for provider errors other than a missing bridge', async () => {
    const prompt = vi.fn(async () => ({ ok: false, error: 'provider unavailable' }))
    const restart = vi.fn()

    await expect(promptCrewBridgeWithRecovery(
      { bridgeId: 'bridge-old', prompt: 'hello' },
      prompt,
      restart,
    )).resolves.toEqual({ ok: false, error: 'provider unavailable' })
    expect(restart).not.toHaveBeenCalled()
  })
})

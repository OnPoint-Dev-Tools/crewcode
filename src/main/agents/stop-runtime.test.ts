import { describe, expect, it, vi } from 'vitest'
import { stopRuntime } from './stop-runtime'

describe('runtime Stop', () => {
  it('tears down without waiting for an unresponsive abort acknowledgement', async () => {
    const abort = vi.fn(() => new Promise<void>(() => {}))
    const stop = vi.fn(async () => {})
    await stopRuntime({ abort, stop })
    expect(abort).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('still tears down after cancellation throws', async () => {
    const stop = vi.fn(async () => {})
    await stopRuntime({ abort: () => { throw new Error('closed pipe') }, stop })
    expect(stop).toHaveBeenCalledOnce()
  })
})

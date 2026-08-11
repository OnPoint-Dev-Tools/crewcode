import { afterEach, describe, expect, it, vi } from 'vitest'

import { createAudioInputWorklet } from './audio-input-worklet'

class FakePort {
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
  start = vi.fn()
  close = vi.fn()
}

class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = []
  readonly port = new FakePort()
  readonly disconnect = vi.fn()

  constructor(
    readonly context: AudioContext,
    readonly name: string,
    readonly options: AudioWorkletNodeOptions,
  ) {
    FakeAudioWorkletNode.instances.push(this)
  }
}

afterEach(() => {
  FakeAudioWorkletNode.instances = []
  vi.unstubAllGlobals()
})

describe('createAudioInputWorklet', () => {
  it('loads a bundled same-origin module instead of a CSP-blocked blob URL', async () => {
    const addModule = vi.fn().mockResolvedValue(undefined)
    const context = { audioWorklet: { addModule } } as unknown as AudioContext
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode)

    const capture = await createAudioInputWorklet(context, vi.fn(), 4096)

    expect(addModule).toHaveBeenCalledOnce()
    const moduleUrl = String(addModule.mock.calls[0][0])
    expect(moduleUrl).not.toMatch(/^(blob|data):/)
    expect(moduleUrl).toContain('audio-input-worklet-processor')
    expect(FakeAudioWorkletNode.instances[0]).toMatchObject({
      name: 'crewcode-pcm-capture',
      options: { processorOptions: { frameSize: 4096 } },
    })

    capture.dispose()
    expect(FakeAudioWorkletNode.instances[0].port.close).toHaveBeenCalledOnce()
    expect(FakeAudioWorkletNode.instances[0].disconnect).toHaveBeenCalledOnce()
  })
})

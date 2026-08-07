import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getSelectionSpeechState,
  playSelectionSpeech,
  stopSelectionSpeech,
  subscribeSelectionSpeech,
} from './selection-speech-playback'
import { initializeCrewCodeRuntime } from '../runtime/crewcode-client'

const synthesize = vi.fn()
const createObjectURL = vi.fn(() => 'blob:selection-speech')
const revokeObjectURL = vi.fn()
const audioInstances: FakeAudio[] = []

class FakeAudio {
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  pause = vi.fn()
  play = vi.fn(async () => undefined)

  constructor(readonly src: string) {
    audioInstances.push(this)
  }
}

beforeEach(() => {
  synthesize.mockReset().mockResolvedValue({
    ok: true,
    audio: new Uint8Array([82, 73, 70, 70]),
    contentType: 'audio/wav',
  })
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  audioInstances.length = 0
  vi.stubGlobal('window', { electronAPI: { voiceSynthesize: synthesize } })
  initializeCrewCodeRuntime()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  vi.stubGlobal('Audio', FakeAudio)
})

afterEach(() => {
  stopSelectionSpeech()
  vi.unstubAllGlobals()
})

describe('selection speech playback', () => {
  it('requests speech using the selected provider and voice', async () => {
    const error = await playSelectionSpeech({
      provider: 'local',
      text: 'Read this selection.',
      voice: 'am_michael',
      localPythonPath: '/voice/python',
    })

    expect(error).toBeNull()
    expect(synthesize).toHaveBeenCalledWith({
      provider: 'local',
      text: 'Read this selection.',
      voice: 'am_michael',
      localPythonPath: '/voice/python',
    })
    expect(audioInstances[0].play).toHaveBeenCalledOnce()
  })

  it('stops current selection speech before starting another request', async () => {
    await playSelectionSpeech({ provider: 'xai', text: 'First.', voice: 'rex' })
    const first = audioInstances[0]

    await playSelectionSpeech({ provider: 'xai', text: 'Second.', voice: 'rex' })

    expect(first.pause).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:selection-speech')
    expect(audioInstances).toHaveLength(2)
  })

  it('clears loading when the synthesis request throws', async () => {
    synthesize.mockRejectedValueOnce(new Error('provider unavailable'))

    const error = await playSelectionSpeech({ provider: 'xai', text: 'Fail cleanly.', voice: 'rex' })

    expect(error).toBe('provider unavailable')
    expect(getSelectionSpeechState()).toEqual({ phase: 'idle', text: '' })
  })

  it('publishes loading until synthesized audio starts playing', async () => {
    let resolveSynthesis!: (value: { ok: boolean; audio: Uint8Array; contentType: string }) => void
    synthesize.mockImplementationOnce(() => new Promise(resolve => { resolveSynthesis = resolve }))
    const phases: string[] = []
    const unsubscribe = subscribeSelectionSpeech(() => phases.push(getSelectionSpeechState().phase))

    const playback = playSelectionSpeech({ provider: 'local', text: 'Loading speech.', voice: 'am_michael' })
    expect(getSelectionSpeechState()).toEqual({ phase: 'loading', text: 'Loading speech.' })

    resolveSynthesis({ ok: true, audio: new Uint8Array([82, 73, 70, 70]), contentType: 'audio/wav' })
    await playback

    expect(getSelectionSpeechState()).toEqual({ phase: 'playing', text: 'Loading speech.' })
    expect(phases).toContain('loading')
    expect(phases.at(-1)).toBe('playing')
    unsubscribe()
  })
})

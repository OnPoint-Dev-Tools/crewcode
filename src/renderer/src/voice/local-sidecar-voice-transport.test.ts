import { afterEach, describe, expect, it, vi } from 'vitest'

import { createVoiceTransport } from './create-voice-transport'
import { initializeCrewCodeRuntime } from '../runtime/crewcode-client'
import {
  chunkSpokenText,
  encodeMonoWav,
  LocalSidecarVoiceTransport,
} from './local-sidecar-voice-transport'

describe('local sidecar voice transport', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is selected by the provider-neutral transport factory', () => {
    expect(createVoiceTransport('local')).toBeInstanceOf(LocalSidecarVoiceTransport)
  })

  it('encodes 16 kHz mono PCM as a valid 16-bit WAV', () => {
    const wav = encodeMonoWav(new Float32Array([-1, 0, 1]))
    const view = new DataView(wav.buffer)
    const ascii = (start: number, length: number) =>
      String.fromCharCode(...wav.slice(start, start + length))

    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(ascii(36, 4)).toBe('data')
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getInt16(44, true)).toBe(-32_768)
    expect(view.getInt16(48, true)).toBe(32_767)
  })

  it('chunks complete prose below the local speech security limit', () => {
    const text = Array.from({ length: 20 }, (_, index) =>
      `Sentence ${index + 1} includes enough detail for the spoken result.`,
    ).join(' ')
    const chunks = chunkSpokenText(text, 180)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.length <= 180)).toBe(true)
    expect(chunks.join(' ')).toBe(text)
  })

  it('warms Kokoro only after the orb dispatches agent work', () => {
    const prewarm = vi.fn().mockResolvedValue({ running: true, ready: true, endpoint: '' })
    vi.stubGlobal('window', {
      electronAPI: { voiceLocalPrewarm: prewarm },
    })
    initializeCrewCodeRuntime()
    const transport = new LocalSidecarVoiceTransport()

    transport.sendToolResult('call-1', { status: 'started' })

    expect(prewarm).toHaveBeenCalledWith({ pythonPath: '', device: 'auto' }, 'speech')
  })
})

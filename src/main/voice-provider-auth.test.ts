import { beforeEach, describe, expect, it, vi } from 'vitest'

const keyStore = vi.hoisted(() => ({
  getAgentKey: vi.fn<(provider: string) => string | null>(),
  hasAgentKey: vi.fn<(provider: string) => boolean>(),
  setAgentKey: vi.fn(),
}))

vi.mock('./agents/agent-keys', () => keyStore)

import {
  createVoiceClientSecret,
  setVoiceProviderKey,
  synthesizeRemoteVoiceText,
  transcribeRemoteVoiceAudio,
  voiceProviderAvailability,
} from './voice-provider-auth'

beforeEach(() => {
  vi.clearAllMocks()
  keyStore.getAgentKey.mockReturnValue('stored-key')
  keyStore.hasAgentKey.mockReturnValue(false)
})

describe('voice provider configuration', () => {
  it('keeps paid adapters unavailable until their keys are configured', () => {
    const availability = voiceProviderAvailability()
    expect(availability.openai.available).toBe(false)
    expect(availability.xai.available).toBe(false)
    expect(availability.local).toMatchObject({ configured: true, available: true })
  })

  it('stores keys under voice-specific provider ids', () => {
    setVoiceProviderKey('openai', 'secret')
    setVoiceProviderKey('xai', null)
    expect(keyStore.setAgentKey).toHaveBeenCalledWith('voice:openai', 'secret')
    expect(keyStore.setAgentKey).toHaveBeenCalledWith('voice:xai', null)
  })
})

describe('ephemeral client secrets', () => {
  it('creates an OpenAI realtime client secret using the main-side key', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      value: 'ephemeral-openai',
      expires_at: 123,
    }), { status: 200 }))

    const result = await createVoiceClientSecret({
      provider: 'openai',
      model: 'gpt-realtime-2.1',
      voice: 'marin',
      instructions: 'Speak naturally.',
    }, fetcher as typeof fetch)

    expect(result).toEqual({
      ok: true,
      provider: 'openai',
      value: 'ephemeral-openai',
      expiresAt: 123,
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.com/v1/realtime/client_secrets',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer stored-key' }),
      }),
    )
  })

  it('creates an xAI secret without sending unsupported session fields', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ expires_after: { seconds: 300 } })
      return new Response(JSON.stringify({
        client_secret: { value: 'ephemeral-xai', expires_at: 456 },
      }), { status: 200 })
    })

    const result = await createVoiceClientSecret({
      provider: 'xai',
      model: 'grok-voice-latest',
      voice: 'eve',
      instructions: 'Speak naturally.',
    }, fetcher as typeof fetch)

    expect(result).toEqual({
      ok: true,
      provider: 'xai',
      value: 'ephemeral-xai',
      expiresAt: 456,
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.x.ai/v1/realtime/client_secrets',
      expect.any(Object),
    )
  })

  it('returns a configuration error without attempting a request', async () => {
    keyStore.getAgentKey.mockReturnValue(null)
    const fetcher = vi.fn()

    const result = await createVoiceClientSecret({
      provider: 'openai',
      model: 'gpt-realtime-2.1',
      voice: 'marin',
      instructions: 'Speak naturally.',
    }, fetcher as typeof fetch)

    expect(result).toEqual({
      ok: false,
      provider: 'openai',
      error: 'openai voice is not configured',
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('dictation transcription', () => {
  it('sends OpenAI a WAV with the transcription-only model', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as FormData
      expect(body.get('model')).toBe('gpt-4o-mini-transcribe')
      expect(body.get('file')).toBeInstanceOf(Blob)
      return new Response(JSON.stringify({ text: 'Fix the failing test.' }), { status: 200 })
    })

    const result = await transcribeRemoteVoiceAudio(
      'openai',
      new Uint8Array([82, 73, 70, 70]),
      fetcher as typeof fetch,
    )

    expect(result).toEqual({ ok: true, text: 'Fix the failing test.' })
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.objectContaining({
        headers: { Authorization: 'Bearer stored-key' },
      }),
    )
  })

  it('uses xAI speech-to-text without a voice-agent session', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ text: 'Explain this function.' }), { status: 200 }))

    const result = await transcribeRemoteVoiceAudio(
      'xai',
      new Uint8Array([82, 73, 70, 70]),
      fetcher as typeof fetch,
    )

    expect(result).toEqual({ ok: true, text: 'Explain this function.' })
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.x.ai/v1/stt',
      expect.any(Object),
    )
  })

  it('returns the provider error without exposing the stored key', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'insufficient_quota' } }), { status: 429 }))

    const result = await transcribeRemoteVoiceAudio(
      'openai',
      new Uint8Array([82, 73, 70, 70]),
      fetcher as typeof fetch,
    )

    expect(result).toEqual({ ok: false, error: 'insufficient_quota' })
    expect(JSON.stringify(result)).not.toContain('stored-key')
  })
})

describe('text to speech', () => {
  it('uses the configured OpenAI voice with the speech endpoint', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'gpt-4o-mini-tts',
        input: 'Read this.',
        voice: 'marin',
        response_format: 'wav',
      })
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      })
    })

    const result = await synthesizeRemoteVoiceText(
      'openai',
      'Read this.',
      'marin',
      fetcher as typeof fetch,
    )

    expect(result).toMatchObject({ ok: true, contentType: 'audio/wav' })
    expect(result.audio).toEqual(new Uint8Array([82, 73, 70, 70]))
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/speech',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer stored-key' }),
      }),
    )
  })

  it('uses xAI batch TTS with the configured voice', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        text: 'Read this.',
        voice_id: 'rex',
        language: 'auto',
        output_format: { codec: 'wav', sample_rate: 24_000 },
      })
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    })

    const result = await synthesizeRemoteVoiceText(
      'xai',
      'Read this.',
      'rex',
      fetcher as typeof fetch,
    )

    expect(result.ok).toBe(true)
    expect(fetcher).toHaveBeenCalledWith('https://api.x.ai/v1/tts', expect.any(Object))
  })

  it('rejects oversized selections before making a paid request', async () => {
    const fetcher = vi.fn()

    const result = await synthesizeRemoteVoiceText(
      'openai',
      'x'.repeat(4_001),
      'marin',
      fetcher as typeof fetch,
    )

    expect(result).toEqual({ ok: false, error: 'speech text is too long' })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

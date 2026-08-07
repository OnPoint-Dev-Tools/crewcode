import { getAgentKey, hasAgentKey, setAgentKey } from './agents/agent-keys'
import type {
  RemoteVoiceProviderId,
  VoiceClientSecretRequest,
  VoiceClientSecretResult,
  VoiceProviderAvailabilityMap,
  VoiceSpeechResult,
  VoiceTranscriptionResult,
} from '../shared/voice-types'

const KEY_IDS: Record<RemoteVoiceProviderId, string> = {
  openai: 'voice:openai',
  xai: 'voice:xai',
}

const MODEL_LIMIT = 120
const VOICE_LIMIT = 80
const INSTRUCTIONS_LIMIT = 12_000
const MAX_TRANSCRIPTION_BYTES = 32 * 1024 * 1024
const MAX_SPEECH_CHARS = 4_000

function bounded(value: string, limit: number, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${field} is required`)
  if (trimmed.length > limit) throw new Error(`${field} is too long`)
  return trimmed
}

export function voiceProviderAvailability(): VoiceProviderAvailabilityMap {
  return {
    off: { configured: true, available: false, reason: 'Voice is turned off.' },
    fake: { configured: true, available: process.env.NODE_ENV !== 'production', reason: 'Development and automated tests only.' },
    openai: { configured: hasAgentKey(KEY_IDS.openai), available: hasAgentKey(KEY_IDS.openai), reason: 'Add an OpenAI API key in Voice settings.' },
    xai: { configured: hasAgentKey(KEY_IDS.xai), available: hasAgentKey(KEY_IDS.xai), reason: 'Add an xAI API key in Voice settings.' },
    local: { configured: true, available: true, reason: 'Starts the native Parakeet and Kokoro sidecar on demand.' },
  }
}

export function setVoiceProviderKey(provider: RemoteVoiceProviderId, key: string | null): void {
  setAgentKey(KEY_IDS[provider], key)
}

export async function transcribeRemoteVoiceAudio(
  provider: RemoteVoiceProviderId,
  audio: Uint8Array,
  fetcher: typeof fetch = fetch,
): Promise<VoiceTranscriptionResult> {
  const apiKey = getAgentKey(KEY_IDS[provider])
  if (!apiKey) return { ok: false, error: `${provider} voice is not configured` }
  if (!(audio instanceof Uint8Array) || audio.byteLength === 0) return { ok: false, error: 'Audio is required.' }
  if (audio.byteLength > MAX_TRANSCRIPTION_BYTES) return { ok: false, error: 'Dictation audio is too large.' }

  try {
    const form = new FormData()
    if (provider === 'openai') form.append('model', 'gpt-4o-mini-transcribe')
    // Keep the file last because xAI may ignore multipart fields after it.
    form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'dictation.wav')
    const response = await fetcher(
      provider === 'openai'
        ? 'https://api.openai.com/v1/audio/transcriptions'
        : 'https://api.x.ai/v1/stt',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      },
    )
    const payload = await response.json().catch(() => null) as {
      text?: unknown
      error?: { message?: unknown } | string
      message?: unknown
    } | null
    if (!response.ok) {
      const providerMessage = typeof payload?.error === 'string'
        ? payload.error
        : typeof payload?.error?.message === 'string'
          ? payload.error.message
          : typeof payload?.message === 'string'
            ? payload.message
            : `HTTP ${response.status}`
      return { ok: false, error: providerMessage }
    }
    const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
    return text ? { ok: true, text } : { ok: false, error: 'Provider returned an empty transcription.' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function synthesizeRemoteVoiceText(
  provider: RemoteVoiceProviderId,
  text: string,
  voice: string,
  fetcher: typeof fetch = fetch,
): Promise<VoiceSpeechResult> {
  const apiKey = getAgentKey(KEY_IDS[provider])
  if (!apiKey) return { ok: false, error: `${provider} voice is not configured` }

  try {
    const input = bounded(text, MAX_SPEECH_CHARS, 'speech text')
    const selectedVoice = bounded(voice, VOICE_LIMIT, 'voice')
    const response = await fetcher(
      provider === 'openai'
        ? 'https://api.openai.com/v1/audio/speech'
        : 'https://api.x.ai/v1/tts',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(provider === 'openai'
          ? {
              model: 'gpt-4o-mini-tts',
              input,
              voice: selectedVoice,
              instructions: 'Read the provided text clearly and naturally.',
              response_format: 'wav',
            }
          : {
              text: input,
              voice_id: selectedVoice,
              language: 'auto',
              output_format: { codec: 'wav', sample_rate: 24_000 },
            }),
      },
    )
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as {
        error?: { message?: unknown } | string
        message?: unknown
      } | null
      const providerMessage = typeof payload?.error === 'string'
        ? payload.error
        : typeof payload?.error?.message === 'string'
          ? payload.error.message
          : typeof payload?.message === 'string'
            ? payload.message
            : `HTTP ${response.status}`
      return { ok: false, error: providerMessage }
    }
    const audio = new Uint8Array(await response.arrayBuffer())
    return audio.byteLength > 0
      ? { ok: true, audio, contentType: response.headers.get('content-type') || 'audio/wav' }
      : { ok: false, error: 'Provider returned empty speech audio.' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function createVoiceClientSecret(
  request: VoiceClientSecretRequest,
  fetcher: typeof fetch = fetch,
): Promise<VoiceClientSecretResult> {
  const provider = request.provider
  const apiKey = getAgentKey(KEY_IDS[provider])
  if (!apiKey) return { ok: false, provider, error: `${provider} voice is not configured` }

  try {
    const model = bounded(request.model, MODEL_LIMIT, 'model')
    const voice = bounded(request.voice, VOICE_LIMIT, 'voice')
    const instructions = bounded(request.instructions, INSTRUCTIONS_LIMIT, 'instructions')
    const url = provider === 'openai'
      ? 'https://api.openai.com/v1/realtime/client_secrets'
      : 'https://api.x.ai/v1/realtime/client_secrets'
    const body = provider === 'openai'
      ? {
          session: {
            type: 'realtime',
            model,
            instructions,
            audio: { output: { voice } },
          },
        }
      : { expires_after: { seconds: 300 } }

    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const payload = await response.json() as {
      value?: unknown
      client_secret?: { value?: unknown; expires_at?: unknown }
      expires_at?: unknown
      error?: { message?: unknown }
    }
    if (!response.ok) {
      const message = typeof payload.error?.message === 'string' ? payload.error.message : `HTTP ${response.status}`
      return { ok: false, provider, error: message }
    }
    const value = typeof payload.value === 'string'
      ? payload.value
      : typeof payload.client_secret?.value === 'string'
        ? payload.client_secret.value
        : null
    if (!value) return { ok: false, provider, error: 'provider did not return a client secret' }
    const rawExpiry = payload.expires_at ?? payload.client_secret?.expires_at
    return {
      ok: true,
      provider,
      value,
      expiresAt: typeof rawExpiry === 'number' ? rawExpiry : undefined,
    }
  } catch (error) {
    return { ok: false, provider, error: error instanceof Error ? error.message : String(error) }
  }
}

import type { VoiceProviderId } from '../../../shared/voice-types'
import type { VoiceTransport } from './voice-agent-contract'
import { FakeVoiceTransport } from './fake-voice-transport'
import { OpenAIRealtimeVoiceTransport } from './openai-realtime-voice-transport'
import { XaiRealtimeVoiceTransport } from './xai-realtime-voice-transport'
import { LocalSidecarVoiceTransport } from './local-sidecar-voice-transport'

export function createVoiceTransport(provider: VoiceProviderId): VoiceTransport {
  if (provider === 'fake') return new FakeVoiceTransport()
  if (provider === 'openai') return new OpenAIRealtimeVoiceTransport()
  if (provider === 'xai') return new XaiRealtimeVoiceTransport()
  if (provider === 'local') return new LocalSidecarVoiceTransport()
  throw new Error('Choose a voice provider in Settings.')
}

export type VoiceProviderId = 'off' | 'fake' | 'openai' | 'xai' | 'local'
export type RemoteVoiceProviderId = 'openai' | 'xai'
export type LocalVoiceDevice = 'auto' | 'gpu' | 'cpu'

export const LOCAL_VOICE_SPEED_MIN = 0.5
export const LOCAL_VOICE_SPEED_MAX = 2
export const LOCAL_VOICE_SPEED_DEFAULT = 1

export function normalizeLocalVoiceSpeed(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return LOCAL_VOICE_SPEED_DEFAULT
  const clamped = Math.min(LOCAL_VOICE_SPEED_MAX, Math.max(LOCAL_VOICE_SPEED_MIN, value))
  return Math.round(clamped * 100) / 100
}

export type VoiceSessionPhase =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'processing'
  | 'confirming'
  | 'waiting'
  | 'speaking'
  | 'error'

export interface VoiceProviderAvailability {
  configured: boolean
  available: boolean
  reason?: string
}

export type VoiceProviderAvailabilityMap = Record<VoiceProviderId, VoiceProviderAvailability>

export interface VoiceClientSecretRequest {
  provider: RemoteVoiceProviderId
  model: string
  voice: string
  instructions: string
}

export interface VoiceClientSecretResult {
  ok: boolean
  provider: RemoteVoiceProviderId
  value?: string
  expiresAt?: number
  error?: string
}

export interface LocalVoiceStartRequest {
  pythonPath: string
  device: LocalVoiceDevice
}

export type LocalVoiceWarmupCapability = 'transcription' | 'speech' | 'all'

export interface LocalVoiceServiceStatus {
  running: boolean
  ready: boolean
  endpoint: string
  parakeetLoaded?: boolean
  kokoroLoaded?: boolean
  configuredDevice?: LocalVoiceDevice
  resolvedDevice?: 'cuda' | 'cpu'
  cudaReservedBytes?: number
  error?: string
}

export interface LocalVoiceTranscriptionResult {
  ok: boolean
  text?: string
  error?: string
}

export interface VoiceTranscriptionRequest {
  provider: VoiceProviderId
  audio: Uint8Array
  localPythonPath?: string
  localDevice?: LocalVoiceDevice
}

export interface VoiceTranscriptionResult {
  ok: boolean
  text?: string
  error?: string
}

export interface VoiceSpeechRequest {
  provider: VoiceProviderId
  text: string
  voice: string
  localPythonPath?: string
  localDevice?: LocalVoiceDevice
  localSpeed?: number
}

export interface VoiceSpeechResult {
  ok: boolean
  audio?: Uint8Array
  contentType?: string
  error?: string
}

export interface LocalVoiceSpeechResult {
  ok: boolean
  audio?: Uint8Array
  error?: string
}

export interface VoiceToolCall {
  callId: string
  name: 'send_prompt_to_agent' | 'get_agent_status'
  arguments: Record<string, unknown>
}

export interface VoiceControlSurface {
  phase: VoiceSessionPhase
  status: string
  active: boolean
  disabled: boolean
  disabledReason?: string
  confirmationText: string
  start: () => void
  stop: () => void
  setConfirmationText: (text: string) => void
  confirmPrompt: () => void
  cancelPrompt: () => void
}

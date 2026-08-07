import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChatPromptOptions } from '../types'
import type {
  VoiceControlSurface,
  VoiceProviderAvailabilityMap,
  VoiceProviderId,
} from '../../../shared/voice-types'
import { useSettings } from './useSettings'
import { useVoiceSessionStore, voiceSession } from '../stores/voice-session-store'
import { createVoiceTransport } from '../voice/create-voice-transport'
import { voiceRuntime } from '../voice/voice-session-runtime'

interface UseVoiceSessionControllerArgs {
  scopeId: string
  agentLabel: string
  agentRunning: boolean
  sendText: (text: string, attachments: [], options?: ChatPromptOptions) => Promise<void>
}

function transportConfig(
  provider: VoiceProviderId,
  settings: ReturnType<typeof useSettings>['state'],
): {
  model: string
  voice: string
  pythonPath?: string
  localDevice?: ReturnType<typeof useSettings>['state']['voiceLocalDevice']
  localSpeechSpeed?: number
} {
  if (provider === 'local') {
    return {
      model: 'nvidia/parakeet-tdt-0.6b-v2',
      voice: settings.voiceLocalVoice,
      pythonPath: settings.voiceLocalPythonPath,
      localDevice: settings.voiceLocalDevice,
      localSpeechSpeed: settings.voiceLocalSpeed,
    }
  }
  return provider === 'xai'
    ? { model: settings.voiceXaiModel, voice: settings.voiceXaiVoice }
    : { model: settings.voiceOpenAIModel, voice: settings.voiceOpenAIVoice }
}

export function useVoiceSessionController({
  scopeId,
  agentLabel,
  agentRunning,
  sendText,
}: UseVoiceSessionControllerArgs): VoiceControlSurface {
  const { state: settings } = useSettings()
  const globalVoice = useVoiceSessionStore()
  const [availability, setAvailability] = useState<VoiceProviderAvailabilityMap | null>(null)

  const provider = settings.voiceProvider
  const active = globalVoice.presenterScopeId === scopeId && globalVoice.ownerKind === 'voice'
  const microphoneBusy = globalVoice.activeScopeId !== null && !active

  const refreshAvailability = useCallback(async () => {
    const value = await window.electronAPI?.voiceProviderAvailability()
    if (value) setAvailability(value)
    return value ?? null
  }, [])

  useEffect(() => { void refreshAvailability() }, [refreshAvailability, provider])

  const stop = useCallback(() => voiceRuntime.stop(), [])

  // A chat pane presents the global voice runtime; it never owns its lifetime.
  useEffect(() => {
    voiceSession.attachPresenter(scopeId)
  }, [globalVoice.activeScopeId, globalVoice.ownerKind, globalVoice.presenterScopeId, scopeId])

  useEffect(() => () => voiceSession.detachPresenter(scopeId), [scopeId])

  useEffect(() => {
    voiceRuntime.updateTarget({ scopeId, agentLabel, agentRunning, sendText })
  }, [agentLabel, agentRunning, scopeId, sendText])

  const setConfirmationText = useCallback((text: string) => voiceRuntime.setConfirmationText(text), [])
  const confirmPrompt = useCallback(() => voiceRuntime.confirmPrompt(), [])
  const cancelPrompt = useCallback(() => voiceRuntime.cancelPrompt(), [])

  const start = useCallback(() => {
    void (async () => {
      if (microphoneBusy) return
      const current = await refreshAvailability()
      const status = current?.[provider]
      if (!status?.available) {
        voiceSession.claim(scopeId)
        voiceSession.fail(scopeId, status?.reason ?? 'Choose and configure a voice provider in Settings.')
        return
      }

      const transport = createVoiceTransport(provider)
      voiceRuntime.begin({ scopeId, agentLabel, agentRunning, sendText }, transport)
      try {
        const config = transportConfig(provider, settings)
        await transport.start({ agentLabel, ...config })
      } catch (error) {
        voiceRuntime.failStart(transport, error instanceof Error ? error.message : String(error))
      }
    })()
  }, [agentLabel, agentRunning, microphoneBusy, provider, refreshAvailability, scopeId, sendText, settings])

  const selectedAvailability = availability?.[provider]
  const disabledReason = microphoneBusy
    ? 'Composer dictation is using the microphone.'
    : provider === 'off'
      ? 'Choose a voice provider in Settings.'
    : selectedAvailability && !selectedAvailability.available
      ? selectedAvailability.reason
      : undefined
  const disabled = microphoneBusy || provider === 'off' || (selectedAvailability ? !selectedAvailability.available : true)

  return useMemo(() => ({
    phase: active ? globalVoice.phase : 'idle',
    status: active ? globalVoice.status : 'voice off',
    active,
    disabled,
    disabledReason,
    confirmationText: active && globalVoice.phase === 'confirming' ? globalVoice.transcript : '',
    start,
    stop,
    setConfirmationText,
    confirmPrompt,
    cancelPrompt,
  }), [
    active,
    disabled,
    disabledReason,
    globalVoice.phase,
    globalVoice.status,
    globalVoice.transcript,
    start,
    stop,
    setConfirmationText,
    confirmPrompt,
    cancelPrompt,
  ])
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { useSettings } from '../../hooks/useSettings'
import { useVoiceSessionStore, voiceSession } from '../../stores/voice-session-store'
import { OneShotAudioCapture } from '../../voice/one-shot-audio-capture'
import { getCrewCodeClient } from '../../runtime/crewcode-client'

type DictationPhase = 'idle' | 'listening' | 'processing' | 'error'

interface ComposerDictationButtonProps {
  scopeId: string
  onTranscript: (text: string) => void
}

export function ComposerDictationButton({
  scopeId,
  onTranscript,
}: ComposerDictationButtonProps) {
  const { state: settings } = useSettings()
  const microphone = useVoiceSessionStore()
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [message, setMessage] = useState('Dictate into composer')
  const captureRef = useRef<OneShotAudioCapture | null>(null)
  const owner = microphone.activeScopeId === scopeId && microphone.ownerKind === 'dictation'
  const busyElsewhere = microphone.activeScopeId !== null && !owner
  const provider = settings.voiceProvider

  const stop = useCallback((cancel = true) => {
    const capture = captureRef.current
    captureRef.current = null
    if (capture && cancel) capture.cancel()
    voiceSession.release(scopeId, 'dictation')
    setPhase('idle')
    setMessage('Dictate into composer')
  }, [scopeId])

  useEffect(() => {
    if (captureRef.current && !owner) stop()
  }, [owner, stop])

  useEffect(() => () => stop(), [stop])

  const start = useCallback(() => {
    void (async () => {
      if (phase === 'listening') {
        captureRef.current?.finish()
        return
      }
      if (provider === 'off' || busyElsewhere) return

      const client = getCrewCodeClient()
      const availability = await client.voiceProviderAvailability()
      const selected = availability?.[provider]
      if (!selected?.available) {
        setPhase('error')
        setMessage(selected?.reason ?? 'Choose and configure a voice provider in Settings.')
        return
      }

      voiceSession.claim(scopeId, 'dictation')
      setPhase('listening')
      setMessage(`Listening · ${provider === 'local' ? 'Parakeet' : provider === 'openai' ? 'GPT' : provider === 'xai' ? 'xAI' : 'fake'}`)

      if (provider === 'local') {
        // Hide Parakeet reload latency behind the user's recording instead of
        // waiting until the completed WAV reaches main.
        void client.voiceLocalPrewarm({
          pythonPath: settings.voiceLocalPythonPath,
          device: settings.voiceLocalDevice,
        }, 'transcription').catch(() => {})
      }

      try {
        const capture = await OneShotAudioCapture.start()
        captureRef.current = capture
        const audio = await capture.result
        captureRef.current = null
        setPhase('processing')
        setMessage('Transcribing…')
        voiceSession.setPhase(scopeId, 'processing', 'transcribing', 'dictation')
        const result = await client.voiceTranscribe({
          provider,
          audio,
          localPythonPath: settings.voiceLocalPythonPath,
          localDevice: settings.voiceLocalDevice,
        })
        if (!result?.ok || !result.text?.trim()) {
          throw new Error(result?.error ?? 'Dictation transcription failed.')
        }
        onTranscript(result.text)
        stop(false)
      } catch (error) {
        captureRef.current = null
        voiceSession.release(scopeId, 'dictation')
        const text = error instanceof Error ? error.message : String(error)
        if (text === 'Dictation cancelled.') {
          setPhase('idle')
          setMessage('Dictate into composer')
          return
        }
        setPhase('error')
        setMessage(text)
      }
    })()
  }, [busyElsewhere, onTranscript, phase, provider, scopeId, settings.voiceLocalDevice, settings.voiceLocalPythonPath, stop])

  const disabled = provider === 'off' || busyElsewhere || phase === 'processing'
  const title = provider === 'off'
    ? 'Choose a voice provider in Settings to use dictation.'
    : busyElsewhere
      ? 'Another voice session is using the microphone.'
      : message

  return (
    <button
      type="button"
      className={`ibtn composer-dictation${phase === 'listening' ? ' is-listening' : ''}${phase === 'processing' ? ' is-processing' : ''}${phase === 'error' ? ' is-error' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={phase === 'listening'}
      disabled={disabled}
      onClick={start}
    >
      <Icon name="mic" />
    </button>
  )
}

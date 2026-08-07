import { useEffect, useRef, useState } from 'react'
import type { VoiceControlSurface } from '../../../../shared/voice-types'
import { effectiveChord, matchesChord, type ShortcutOverrides } from '../../shortcuts'
import { Icon } from '../ui/Icon'

function phaseLabel(control: VoiceControlSurface): string {
  switch (control.phase) {
    case 'connecting': return 'Starting voice'
    case 'listening': return 'Listening'
    case 'processing': return 'Transcribing'
    case 'confirming': return 'Review request'
    case 'waiting': return 'Agent working'
    case 'speaking': return 'Speaking'
    case 'error': return 'Voice error'
    default: return 'Voice ready'
  }
}

function PhaseIcon({ phase }: Pick<VoiceControlSurface, 'phase'>) {
  if (phase === 'speaking') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M5 9h4l5-4v14l-5-4H5z" fill="currentColor" />
        <path d="M17 8.5c2 2 2 5 0 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    )
  }
  if (phase === 'processing' || phase === 'connecting') {
    return <span className="voice-orb-spinner" aria-hidden />
  }
  if (phase === 'confirming') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M6 17.5V20h2.5L18.8 9.7l-2.5-2.5L6 17.5Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <path d="m14.8 8.7 2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      </svg>
    )
  }
  if (phase === 'waiting') return <Icon name="brain" size={28} />
  if (phase === 'error') return <Icon name="alert" size={28} />
  return <Icon name="mic" size={28} />
}

type VoiceOrbPlacement = 'header' | 'composer'

export function VoiceOrb({
  control,
  placement = 'header',
  shortcutOverrides = {},
}: {
  control: VoiceControlSurface
  placement?: VoiceOrbPlacement
  shortcutOverrides?: ShortcutOverrides
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const confirmationRef = useRef<HTMLTextAreaElement>(null)
  const [editingConfirmation, setEditingConfirmation] = useState(false)
  const [overlayDismissed, setOverlayDismissed] = useState(false)
  const title = control.disabled
    ? control.disabledReason ?? 'Configure voice in Settings'
    : control.active
      ? 'End voice chat'
      : 'Start voice chat'

  useEffect(() => {
    if (!control.active) return
    const stopOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') control.stop()
    }
    window.addEventListener('keydown', stopOnEscape)
    return () => window.removeEventListener('keydown', stopOnEscape)
  }, [control.active, control.stop])

  useEffect(() => {
    setEditingConfirmation(false)
  }, [control.phase])

  useEffect(() => {
    if (!control.active) setOverlayDismissed(false)
  }, [control.active])

  useEffect(() => {
    if (editingConfirmation) confirmationRef.current?.focus()
  }, [editingConfirmation])

  useEffect(() => {
    if (placement !== 'composer') return

    const handleVoiceShortcut = (event: KeyboardEvent): void => {
      if (event.repeat || event.isComposing) return
      const action = control.active ? 'end-voice' : 'start-voice'
      if (!matchesChord(event, effectiveChord(action, shortcutOverrides))) return

      if (!control.active) {
        const trigger = triggerRef.current
        if (!trigger || control.disabled || trigger.getClientRects().length === 0) return

        const composer = trigger.closest('.composer-wrap')
        const eventTarget = event.target instanceof Node ? event.target : null
        const ownsFocus = !!composer && (
          composer.contains(document.activeElement)
          || (eventTarget !== null && composer.contains(eventTarget))
        )
        const visibleTriggers = [...document.querySelectorAll<HTMLButtonElement>('.voice-orb-trigger')]
          .filter(button => !button.disabled && button.getClientRects().length > 0)

        // A single visible chat is unambiguous. Split layouts require focus in
        // the owning composer so one shortcut cannot start multiple sessions.
        if (visibleTriggers.length > 1 && !ownsFocus) return
      }

      event.preventDefault()
      control.active ? control.stop() : control.start()
    }

    window.addEventListener('keydown', handleVoiceShortcut)
    return () => window.removeEventListener('keydown', handleVoiceShortcut)
  }, [control.active, control.disabled, control.start, control.stop, placement, shortcutOverrides])

  if (control.active && placement === 'header') {
    if (overlayDismissed) {
      return (
        <div className={`voice-orb-wrap is-active phase-${control.phase}`}>
          <button
            type="button"
            className="voice-orb-trigger voice-orb-restore"
            onClick={() => setOverlayDismissed(false)}
            aria-label={`Show voice overlay. ${phaseLabel(control)}`}
            aria-pressed="true"
            title={`Show voice overlay · ${phaseLabel(control)}`}
          >
            <span className="voice-trigger-core" aria-hidden />
            <span className="voice-trigger-ring" aria-hidden />
            <span className="voice-restore-phase"><PhaseIcon phase={control.phase} /></span>
          </button>
        </div>
      )
    }

    return (
      <div className={`voice-orb-wrap is-active phase-${control.phase}`}>
        <section className="voice-orb-overlay" aria-live="polite" aria-label={`${phaseLabel(control)}. ${control.status}`}>
          <button
            type="button"
            className="voice-overlay-close"
            onClick={() => setOverlayDismissed(true)}
            aria-label="Hide voice overlay"
            title="Hide voice overlay"
            autoFocus={control.phase !== 'confirming'}
          >
            <Icon name="x" size={15} />
          </button>

          <button type="button" className="voice-orb-stage" onClick={control.stop} aria-label="Stop voice">
            <span className="voice-orb-visual" aria-hidden>
              <span className="voice-orb-core" />
              <span className="voice-orb-glow" />
              <span className="voice-orb-glow-secondary" />
              <span className="voice-orb-rings" />
              <span className="voice-orb-rings voice-orb-rings-secondary" />
              <span className="voice-orb-wave voice-orb-wave-one" />
              <span className="voice-orb-wave voice-orb-wave-two" />
              <span className="voice-orb-wave voice-orb-wave-three" />
              <span className="voice-orb-mesh" />
              <span className="voice-orb-particles" />
              <span className="voice-orb-phase-icon"><PhaseIcon phase={control.phase} /></span>
            </span>
          </button>

          {control.phase === 'confirming' ? (
            <div className="voice-confirmation">
              <label htmlFor="voice-confirmation-text">Review before sending</label>
              <textarea
                ref={confirmationRef}
                id="voice-confirmation-text"
                value={control.confirmationText}
                readOnly={!editingConfirmation}
                onChange={event => control.setConfirmationText(event.target.value)}
                aria-label="Voice request"
              />
              <div className="voice-confirmation-actions">
                <button type="button" className="voice-confirmation-button" onClick={control.cancelPrompt}>Cancel</button>
                <button
                  type="button"
                  className="voice-confirmation-button"
                  onClick={() => setEditingConfirmation(value => !value)}
                >
                  {editingConfirmation ? 'Done editing' : 'Edit'}
                </button>
                <button
                  type="button"
                  className="voice-confirmation-button is-primary"
                  disabled={!control.confirmationText.trim()}
                  onClick={control.confirmPrompt}
                >
                  Send
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="voice-overlay-copy">
                <strong>{phaseLabel(control)}</strong>
                <span>{control.status}</span>
              </div>
              <span className="voice-overlay-hint">X hides · Click orb or press Esc to stop</span>
            </>
          )}
        </section>
      </div>
    )
  }

  if (control.active || placement !== 'composer') return null

  return (
    <div className="voice-orb-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="voice-orb-trigger"
        aria-label={title}
        aria-pressed="false"
        title={title}
        disabled={control.disabled}
        onClick={control.start}
      >
        <span className="voice-trigger-core" aria-hidden />
        <span className="voice-trigger-ring" aria-hidden />
        <Icon name="mic" size={13} />
      </button>
    </div>
  )
}

import React, { useEffect } from 'react'

import { Icon } from '../ui/Icon'
import type { IconName } from '../ui/Icon'

interface CrewConfirmDialogProps {
  open:        boolean
  title:       string
  body:        React.ReactNode
  confirmText: string
  /** When true, render confirm button in destructive tone. */
  destructive?:  boolean
  /** Icon shown next to the title — defaults to a warning glyph for destructive ops. */
  icon?:       IconName
  onConfirm:   () => void
  onCancel:    () => void
}

/**
 * Modal confirmation for destructive operations like crew rebuild. Esc cancels,
 * click outside the body cancels. The body is rendered as a child so callers
 * can include a summary (e.g. a list of lanes about to be torn down).
 */
export function CrewConfirmDialog({
  open, title, body, confirmText, destructive, icon, onConfirm, onCancel,
}: CrewConfirmDialogProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div className="crew-modal-backdrop" onClick={onCancel}>
      <div
        className={`crew-modal ${destructive ? 'is-destructive' : ''}`}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="crew-modal-head">
          <span className="crew-modal-icon">
            <Icon name={icon ?? 'alert'} size={14} />
          </span>
          <h2 className="crew-modal-title">{title}</h2>
        </header>
        <div className="crew-modal-body">{body}</div>
        <footer className="crew-modal-foot">
          <button type="button" className="crew-btn-ghost" onClick={onCancel}>cancel</button>
          <button
            type="button"
            className={destructive ? 'crew-btn-go crew-btn-destructive' : 'crew-btn-go'}
            onClick={onConfirm}
            autoFocus
          >
            {confirmText}
          </button>
        </footer>
      </div>
    </div>
  )
}

import React, { useEffect } from 'react'
import { Icon } from './Icon'

export interface ConfirmModalRequest {
  title:        string
  body?:        string
  confirmText?: string
  cancelText?:  string
  danger?:      boolean
  onConfirm:    () => void
}

interface ConfirmModalProps {
  request: ConfirmModalRequest | null
  onClose: () => void
}

// In-app confirmation dialog. Deliberately replaces native window.confirm, which
// under Electron on Wayland can leave the frameless window without keyboard
// focus after it closes — freezing text inputs (e.g. the composer) until reload.
export function ConfirmModal({ request, onClose }: ConfirmModalProps) {
  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      if (e.key === 'Enter')  { e.preventDefault(); request.onConfirm(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, onClose])

  if (!request) return null

  function confirm() {
    request!.onConfirm()
    onClose()
  }

  return (
    <div className="im-backdrop" onClick={onClose}>
      <div className="im-modal" onClick={e => e.stopPropagation()}>
        <div className="im-head">
          <span className="im-title">{request.title}</span>
          <button className="im-close" onClick={onClose}><Icon name="close" size={12} /></button>
        </div>
        {request.body && <div className="im-label">{request.body}</div>}
        <div className="im-actions">
          <button className="im-btn" onClick={onClose}>{request.cancelText ?? 'Cancel'}</button>
          <button
            className={`im-btn ${request.danger ? 'danger' : 'primary'}`}
            autoFocus
            onClick={confirm}
          >
            {request.confirmText ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

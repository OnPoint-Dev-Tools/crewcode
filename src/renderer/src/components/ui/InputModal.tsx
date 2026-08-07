import React, { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

export interface InputModalRequest {
  title:        string
  label?:       string
  placeholder?: string
  initial?:     string
  confirmText?: string
  onConfirm:    (value: string) => void
}

interface InputModalProps {
  request: InputModalRequest | null
  onClose: () => void
}

export function InputModal({ request, onClose }: InputModalProps) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (request) {
      setValue(request.initial ?? '')
      // Defer focus until after the modal mounts so autoFocus + select work cleanly.
      const t = setTimeout(() => inputRef.current?.select(), 30)
      return () => clearTimeout(t)
    }
    return
  }, [request])

  useEffect(() => {
    if (!request) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, onClose])

  if (!request) return null

  function commit() {
    const v = value.trim()
    if (!v) return
    request!.onConfirm(v)
    onClose()
  }

  return (
    <div className="im-backdrop" onClick={onClose}>
      <div className="im-modal" onClick={e => e.stopPropagation()}>
        <div className="im-head">
          <span className="im-title">{request.title}</span>
          <button className="im-close" onClick={onClose}><Icon name="close" size={12} /></button>
        </div>
        {request.label && <div className="im-label">{request.label}</div>}
        <input
          ref={inputRef}
          className="im-input"
          autoFocus
          value={value}
          placeholder={request.placeholder}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter')  { e.preventDefault(); commit() }
            if (e.key === 'Escape') { e.preventDefault(); onClose() }
          }}
        />
        <div className="im-actions">
          <button className="im-btn" onClick={onClose}>Cancel</button>
          <button className="im-btn primary" onClick={commit} disabled={!value.trim()}>
            {request.confirmText ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}

import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserGrabSelectionPayload } from '../../../../shared/browser-grab-types'
import { Icon } from '../ui/Icon'

export interface BrowserGrabChatTarget {
  key: string
  tabId: string
  sessionId: string
  tabLabel: string
  sessionLabel: string
}

interface BrowserGrabSendModalProps {
  open: boolean
  selection: BrowserGrabSelectionPayload | null
  targets: BrowserGrabChatTarget[]
  onClose: () => void
  onSendExisting: (target: BrowserGrabChatTarget, comment: string) => void
  onSendNewChat: (comment: string) => void
}

export function BrowserGrabSendModal({
  open,
  selection,
  targets,
  onClose,
  onSendExisting,
  onSendNewChat,
}: BrowserGrabSendModalProps) {
  const [comment, setComment] = useState('')
  const [selectedKey, setSelectedKey] = useState<string>('__new__')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    setComment('')
    setSelectedKey(targets[0]?.key ?? '__new__')
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [open, targets])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        commit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const selectedTarget = useMemo(
    () => targets.find(target => target.key === selectedKey) ?? null,
    [selectedKey, targets],
  )

  if (!open || !selection) return null

  function commit() {
    if (selectedTarget) onSendExisting(selectedTarget, comment)
    else onSendNewChat(comment)
    onClose()
  }

  return (
    <div className="im-backdrop" onClick={onClose}>
      <div className="im-modal browser-grab-send-modal" onClick={event => event.stopPropagation()}>
        <div className="im-head">
          <span className="im-title">send grabbed element to chat</span>
          <button className="im-close" onClick={onClose}><Icon name="close" size={12} /></button>
        </div>

        <div className="browser-grab-send-summary">
          <div className="browser-grab-send-label">selected element</div>
          <div className="browser-grab-send-selector">{selection.target.selector || selection.target.tagName}</div>
          {selection.target.textSnippet && (
            <div className="browser-grab-send-snippet">{selection.target.textSnippet}</div>
          )}
        </div>

        <label className="browser-grab-send-label" htmlFor="browser-grab-comment">comment</label>
        <textarea
          id="browser-grab-comment"
          ref={textareaRef}
          className="browser-grab-send-comment"
          value={comment}
          onChange={event => setComment(event.target.value)}
          placeholder="add context or tell the agent what to look at"
          rows={5}
        />

        <div className="browser-grab-send-label">destination chat</div>
        <div className="browser-grab-send-targets">
          {targets.map(target => (
            <label key={target.key} className={`browser-grab-send-target ${selectedKey === target.key ? 'on' : ''}`}>
              <input
                type="radio"
                name="browser-grab-target"
                checked={selectedKey === target.key}
                onChange={() => setSelectedKey(target.key)}
              />
              <span className="browser-grab-send-target-main">{target.tabLabel}</span>
              <span className="browser-grab-send-target-sub">{target.sessionLabel}</span>
            </label>
          ))}
          <label className={`browser-grab-send-target ${selectedTarget ? '' : 'on'}`}>
            <input
              type="radio"
              name="browser-grab-target"
              checked={!selectedTarget}
              onChange={() => setSelectedKey('__new__')}
            />
            <span className="browser-grab-send-target-main">new chat</span>
            <span className="browser-grab-send-target-sub">create a fresh chat tab and send immediately</span>
          </label>
        </div>

        <div className="im-actions">
          <button className="im-btn" onClick={onClose}>Cancel</button>
          <button className="im-btn primary" onClick={commit}>send to agent</button>
        </div>
      </div>
    </div>
  )
}

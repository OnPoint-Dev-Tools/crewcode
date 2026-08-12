import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { MentionPopover } from '../composer/MentionPopover'
import { findFileMentionAt, insertFileMention, type FileMentionState } from '../composer/file-mention'
import { Icon } from '../ui/Icon'

interface LaneComposerProps {
  placeholder:   string
  workspacePath: string
  disabled?:     boolean
  running?:      boolean
  onSend:        (text: string) => void
  onStop?:       () => void
}

const workspaceFileCache = new Map<string, string[]>()
const workspaceFileLoads = new Map<string, Promise<string[]>>()
const MIN_HEIGHT = 36
const MAX_HEIGHT = 220

/**
 * Per-lane composer with lazy @file discovery. The textarea grows with its
 * draft until a bounded maximum, then scrolls so long assignments do not take
 * over the entire lane.
 */
export function LaneComposer({ placeholder, workspacePath, disabled, running = false, onSend, onStop }: LaneComposerProps) {
  const [value, setValue] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [mention, setMention] = useState<FileMentionState | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!workspacePath) { setFiles([]); return }
    setFiles(workspaceFileCache.get(workspacePath) ?? [])
  }, [workspacePath])

  // File walking can be expensive over SSH, so load only after @ opens and
  // share the result between composers that point at the same worktree.
  useEffect(() => {
    if (!mention || !workspacePath || workspaceFileCache.has(workspacePath)) return
    let cancelled = false
    const api = window.electronAPI
    if (!api) return
    const load = workspaceFileLoads.get(workspacePath) ?? api.fsListFiles(workspacePath)
      .then(result => {
        const next = result.files ?? []
        workspaceFileCache.set(workspacePath, next)
        workspaceFileLoads.delete(workspacePath)
        return next
      })
      .catch(() => {
        workspaceFileLoads.delete(workspacePath)
        return []
      })
    workspaceFileLoads.set(workspacePath, load)
    load.then(next => { if (!cancelled) setFiles(next) })
    return () => { cancelled = true }
  }, [mention, workspacePath])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    const height = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, textarea.scrollHeight))
    textarea.style.height = `${height}px`
    textarea.style.overflowY = textarea.scrollHeight > MAX_HEIGHT ? 'auto' : 'hidden'
  }, [value])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    setMention(findFileMentionAt(value, textarea.selectionStart ?? value.length))
  }, [value])

  const updateMentionFromCaret = () => {
    const textarea = textareaRef.current
    if (!textarea) return
    setMention(findFileMentionAt(value, textarea.selectionStart ?? value.length))
  }

  const pickMention = (relativePath: string) => {
    const textarea = textareaRef.current
    if (!textarea || !mention) return
    const inserted = insertFileMention(
      value,
      mention,
      textarea.selectionStart ?? value.length,
      relativePath,
    )
    setValue(inserted.value)
    setMention(null)
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(inserted.caret, inserted.caret)
    })
  }

  const submit = () => {
    const text = value.trim()
    if (!text || disabled) return
    onSend(text)
    setValue('')
    setMention(null)
  }

  return (
    <div className="lane-composer">
      <div className="lane-composer-ta-wrap">
        <textarea
          ref={textareaRef}
          className="lane-composer-input"
          value={value}
          rows={1}
          placeholder={placeholder}
          disabled={disabled}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (mention && ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(event.key)) return
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          onKeyUp={updateMentionFromCaret}
          onClick={updateMentionFromCaret}
          onBlur={() => setTimeout(() => setMention(null), 120)}
        />
        {mention && (
          <MentionPopover
            files={files}
            query={mention.query}
            onPick={pickMention}
            onClose={() => setMention(null)}
          />
        )}
      </div>
      {running && onStop && (
        <button
          type="button"
          className="lane-composer-stop"
          onClick={onStop}
          title="stop this agent only"
        >
          <Icon name="square" size={11} />
        </button>
      )}
      <button
        type="button"
        className="lane-composer-send"
        onClick={submit}
        disabled={disabled || !value.trim()}
      >
        <Icon name="send" size={11} />
      </button>
    </div>
  )
}

import React, { useState } from 'react'

import { Icon } from '../ui/Icon'

interface LaneComposerProps {
  placeholder: string
  disabled?:   boolean
  running?:    boolean
  onSend:      (text: string) => void
  onStop?:     () => void
}

/**
 * Compact composer for a single crew lane — Enter sends, Shift+Enter adds a
 * newline. Holds its own draft so each lane's input is independent.
 */
export function LaneComposer({ placeholder, disabled, running = false, onSend, onStop }: LaneComposerProps) {
  const [value, setValue] = useState('')

  const submit = () => {
    const text = value.trim()
    if (!text || disabled) return
    onSend(text)
    setValue('')
  }

  return (
    <div className="lane-composer">
      <textarea
        className="lane-composer-input"
        value={value}
        rows={1}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
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

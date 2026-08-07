import React, { useMemo, useState } from 'react'
import { Icon } from '../ui/Icon'
import { chronologicalStreamSegments } from '../../streaming/stream-chunks'

interface ThinkingBlockProps {
  text:      string
  streaming: boolean
  chunks?:   string[]
}

export function ThinkingBlock({ text, streaming, chunks }: ThinkingBlockProps) {
  const [open, setOpen] = useState(streaming)
  const segments = useMemo(() => chronologicalStreamSegments(chunks, text), [chunks, text])

  return (
    <div className={`thinking ${streaming ? 'streaming' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen(o => !o)}>
        <Icon name="message" size={14} />
        <span className="thinking-label">THOUGHTS</span>
        {streaming && <span className="thinking-pulse" />}
        <span className="thinking-chev" style={{ transform: open ? 'rotate(90deg)' : 'rotate(0)' }}>
          <Icon name="chevRight" size={10} />
        </span>
      </button>
      {open && (
        <div className="thinking-body">
          <div className="thinking-stream" aria-live={streaming ? 'polite' : undefined}>
            {segments.map((segment, i) => (
              <div className="thinking-segment" key={`${i}-${segment.slice(0, 16)}`}>{segment}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

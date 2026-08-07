import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'

interface MentionPopoverProps {
  files:    string[]
  query:    string
  onPick:   (rel: string) => void
  onClose:  () => void
}

const MAX_ROWS = 10

function scoreMatch(rel: string, q: string): number {
  if (!q) return 1
  const lower = rel.toLowerCase()
  const ql = q.toLowerCase()
  const base = rel.split('/').pop()!.toLowerCase()
  if (base.startsWith(ql)) return 100 - rel.length * 0.01
  const baseIdx = base.indexOf(ql)
  if (baseIdx >= 0) return 80 - baseIdx - rel.length * 0.01
  const idx = lower.indexOf(ql)
  if (idx >= 0) return 50 - idx * 0.1 - rel.length * 0.01
  // subsequence fuzzy
  let j = 0
  for (let i = 0; i < lower.length && j < ql.length; i++) {
    if (lower[i] === ql[j]) j++
  }
  return j === ql.length ? 10 - rel.length * 0.001 : -1
}

export function MentionPopover({ files, query, onPick, onClose }: MentionPopoverProps) {
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const scored: Array<{ rel: string; score: number }> = []
    for (const rel of files) {
      const score = scoreMatch(rel, query)
      if (score > 0) scored.push({ rel, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 50).map(s => s.rel)
  }, [files, query])

  useEffect(() => { setActive(0) }, [query])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive(a => Math.min(a + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive(a => Math.max(a - 1, 0))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (filtered[active]) {
          e.preventDefault()
          onPick(filtered[active])
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [filtered, active, onPick, onClose])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLDivElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (filtered.length === 0) {
    return (
      <div className="mention-pop">
        <div className="mention-empty">no files match "{query}"</div>
      </div>
    )
  }

  return (
    <div className="mention-pop" ref={listRef}>
      {filtered.slice(0, MAX_ROWS * 3).map((rel, i) => {
        const name = rel.split('/').pop()!
        const dir  = rel.length > name.length ? rel.slice(0, rel.length - name.length - 1) : ''
        return (
          <div
            key={rel}
            data-idx={i}
            className={`mention-row${i === active ? ' active' : ''}`}
            onMouseDown={e => { e.preventDefault(); onPick(rel) }}
            onMouseEnter={() => setActive(i)}
          >
            <Icon name="paperclip" size={12} />
            <span className="mention-name">{name}</span>
            {dir && <span className="mention-dir">{dir}</span>}
          </div>
        )
      })}
    </div>
  )
}

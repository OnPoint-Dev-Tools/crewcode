import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import {
  CATEGORIES, getCategoryColor, extractVars, fillVars,
  type Prompt,
} from '../../types/prompts'

interface PromptPickerProps {
  open:     boolean
  onClose:  () => void
  prompts:  Prompt[]
  onInsert: (body: string, p: Prompt) => void
  /** Seed values to pre-fill common context vars (`repo`, `branch`). */
  seed?:    Record<string, string>
  anchor?:  { left: number; bottom: number } | null
}

export function PromptPicker({ open, onClose, prompts, onInsert, seed, anchor }: PromptPickerProps) {
  const [q,          setQ]          = useState('')
  const [cat,        setCat]        = useState<string>('all')
  const [highlight,  setHighlight]  = useState<number>(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [vars,       setVars]       = useState<Record<string, string>>({})
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQ(''); setCat('all'); setHighlight(0); setSelectedId(null); setVars({})
    setTimeout(() => searchRef.current?.focus(), 20)
  }, [open])

  const filtered = useMemo(() => prompts.filter(p => {
    if (cat !== 'all' && p.category !== cat) return false
    if (q) {
      const h = (p.title + ' ' + p.description).toLowerCase()
      if (!h.includes(q.toLowerCase())) return false
    }
    return true
  }), [prompts, q, cat])

  const selected = prompts.find(p => p.id === selectedId) ?? null
  const selVars  = selected ? extractVars(selected.body) : []

  const pick = (p: Prompt): void => {
    const v = extractVars(p.body)
    if (v.length === 0) {
      onInsert(p.body, p)
      onClose()
      return
    }
    setSelectedId(p.id)
    const seeded: Record<string, string> = {}
    v.forEach(k => { seeded[k] = seed?.[k] ?? '' })
    setVars(seeded)
  }

  const handleInsert = (): void => {
    if (!selected) return
    onInsert(fillVars(selected.body, vars), selected)
    onClose()
  }

  useEffect(() => {
    if (!open) return
    const fn = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { onClose(); return }
      if (selected) return  // arrow nav only applies to the list view
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight(h => Math.min(h + 1, filtered.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight(h => Math.max(h - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const p = filtered[highlight]
        if (p) pick(p)
      }
    }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filtered, highlight, selected, onClose])

  if (!open) return null

  const positionStyle: React.CSSProperties = anchor
    ? { left: anchor.left, bottom: anchor.bottom }
    : {}

  return (
    <div className="ppicker-backdrop" onClick={onClose}>
      <div className="ppicker" onClick={e => e.stopPropagation()} style={positionStyle}>
        <div className="ppicker-search">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
            strokeWidth={1.75} strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input ref={searchRef}
            value={q} onChange={e => { setQ(e.target.value); setHighlight(0) }}
            placeholder="search prompts… (esc to close)" />
          <span className="ppicker-kbd">esc</span>
        </div>

        <div className="ppicker-body">
          <div className="ppicker-list">
            <div className="ppicker-cats">
              {CATEGORIES.map(c => (
                <button key={c.id} type="button"
                  className={`ppicker-cat ${cat === c.id ? 'on' : ''}`}
                  onClick={() => { setCat(c.id); setHighlight(0) }}>
                  <span className="ppicker-cat-dot" style={{
                    background: c.id === 'all'
                      ? 'var(--muted-foreground)'
                      : getCategoryColor(c.id),
                  }} />
                  {c.label.toLowerCase()}
                </button>
              ))}
            </div>
            <div className="ppicker-items">
              {filtered.length === 0 && (
                <div className="ppicker-empty">no prompts match "{q}"</div>
              )}
              {filtered.map((p, idx) => {
                const v = extractVars(p.body)
                const accent = getCategoryColor(p.category)
                const on = idx === highlight || selectedId === p.id
                return (
                  <button key={p.id} type="button"
                    className={`ppicker-item ${on ? 'on' : ''}`}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => pick(p)}>
                    <span className="ppicker-bar" style={{ background: accent }} />
                    <span className="ppicker-main">
                      <span className="ppicker-t">{p.title}</span>
                      <span className="ppicker-d">{p.description}</span>
                    </span>
                    <span className="ppicker-meta">
                      {v.length > 0 && <span className="ppicker-vars">{v.length} {'{}'}</span>}
                      <span className="ppicker-cat-pill" style={{ color: accent }}>{p.category}</span>
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="ppicker-foot">
              <span><span className="ppicker-kbd">↑↓</span> nav</span>
              <span><span className="ppicker-kbd">⏎</span> insert</span>
              <span className="ppicker-spacer" />
              <span>{filtered.length} prompts</span>
            </div>
          </div>

          {selected && selVars.length > 0 && (
            <div className="ppicker-fill">
              <div className="ppicker-fill-h">
                <span className="ppicker-fill-t">fill variables</span>
                <span className="ppicker-fill-s">{selected.title}</span>
              </div>
              <div className="ppicker-fill-body">
                {selVars.map(v => (
                  <label key={v} className="ppicker-fill-row">
                    <span className="ppicker-fill-k">{`{{${v}}}`}</span>
                    <input value={vars[v] ?? ''}
                      onChange={e => setVars(o => ({ ...o, [v]: e.target.value }))}
                      placeholder={v === 'diff' || v === 'trace' ? 'paste here…' : v} />
                  </label>
                ))}
              </div>
              <div className="ppicker-fill-foot">
                <button type="button" className="ppicker-skip" onClick={() => {
                  onInsert(selected.body, selected)
                  onClose()
                }}>
                  skip — insert raw
                </button>
                <button type="button" className="ppicker-insert" onClick={handleInsert}>
                  <Icon name="send" size={11} />
                  Insert <span className="ppicker-kbd">⏎</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

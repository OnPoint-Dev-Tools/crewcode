import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui/Icon'

export interface PickerItem {
  id:        string
  label:     string                     // bold name shown on first line
  sub?:      string                     // muted second line
  badge?:    string                     // small right-side pill (e.g. "BETA")
  disabled?: boolean
  icon?:     React.ReactNode            // custom avatar; falls back to a default glyph
}

interface PickerSheetProps {
  open:      boolean
  onClose:   () => void
  anchor?:   HTMLElement | null         // element to position the sheet next to
  header?:   string                     // uppercase muted section label
  searchPlaceholder?: string            // when present, renders a search input
  query?:    string
  onQuery?:  (q: string) => void
  items:     PickerItem[]
  activeId?: string
  onPick:    (id: string) => void
  defaultIcon?: React.ReactNode         // shown when item.icon is unset
  width?:    number
  placement?: 'auto' | 'down'
  // Multi-select mode: highlight every id in `selectedIds`, toggle on pick, and
  // keep the sheet open so several can be checked in one pass.
  multiSelect?: boolean
  selectedIds?: string[]
  emptyLabel?: string                   // shown in place of "no matches"
  className?: string                    // optional picker-specific sizing/styling
  /** Keep the sheet mounted after a row pick (used by navigable mobile menus). */
  closeOnPick?: boolean
}

export function PickerSheet({
  open, onClose, anchor, header, searchPlaceholder, query, onQuery,
  items, activeId, onPick, defaultIcon, width = 260, placement = 'auto',
  multiSelect = false, selectedIds, emptyLabel, className, closeOnPick = !multiSelect,
}: PickerSheetProps) {
  const ref = useRef<HTMLDivElement>(null)

  // Click-outside + Esc to close
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current && !ref.current.contains(t) && anchor && !anchor.contains(t)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose, anchor])

  const style: React.CSSProperties = { width }
  if (anchor) {
    const r = anchor.getBoundingClientRect()
    const gap = 6
    const margin = 16
    const minHeight = 160
    const spaceBelow = window.innerHeight - r.bottom - margin
    const spaceAbove = r.top - margin
    // Crew config can opt into downward-only because upward sheets collide with
    // its top chrome; normal pickers keep viewport-aware placement.
    const openDown = placement === 'down' || spaceBelow >= minHeight || spaceBelow >= spaceAbove
    style.position = 'fixed'
    style.left     = Math.max(8, r.right - width)
    if (openDown) {
      style.top = r.bottom + gap
      style.maxHeight = Math.max(minHeight, spaceBelow)
    } else {
      style.bottom = window.innerHeight - r.top + gap
      style.maxHeight = Math.max(minHeight, spaceAbove)
    }
  }

  if (!open) return null

  // Portal to <body>: the sheet is position:fixed with viewport coordinates, so
  // it must escape any ancestor that establishes a containing block (transform,
  // filter, contain) or clips with overflow — e.g. the crew config panel's
  // animated lane cards and overflow:hidden frame.
  return createPortal(
    <>
      <button
        type="button"
        className="picker-sheet-backdrop"
        aria-label="Close picker"
        onClick={onClose}
      />
      <div className={`picker-sheet${className ? ` ${className}` : ''}`} ref={ref} style={style} role="listbox">
      {searchPlaceholder !== undefined && (
        <div className="picker-search">
          <Icon name="x" size={11} style={{ transform: 'rotate(45deg)', opacity: 0.4 }} />
          <input
            autoFocus
            value={query ?? ''}
            placeholder={searchPlaceholder}
            onChange={e => onQuery?.(e.target.value)}
          />
        </div>
      )}
      {header && <div className="picker-header">{header}</div>}
      <div className="picker-list">
        {items.length === 0 && <div className="picker-empty">{emptyLabel ?? 'no matches'}</div>}
        {items.map(item => {
          const active = multiSelect ? (selectedIds?.includes(item.id) ?? false) : activeId === item.id
          return (
            <button
              key={item.id}
              className={`picker-row ${active ? 'on' : ''} ${item.disabled ? 'disabled' : ''}`}
              onClick={() => { if (!item.disabled) { onPick(item.id); if (closeOnPick) onClose() } }}
              disabled={item.disabled}
              role="option"
              aria-selected={active}
            >
              <span className="picker-avatar">
                {item.icon ?? defaultIcon ?? <Icon name="box" size={13} />}
              </span>
              <span className="picker-text">
                <span className="picker-label">{item.label}</span>
                {item.sub && <span className="picker-sub">{item.sub}</span>}
              </span>
              {item.badge && <span className="picker-badge">{item.badge}</span>}
              {active && (
                <span className="picker-check" aria-hidden>
                  <Icon name="check" size={11} />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
    </>,
    document.body,
  )
}

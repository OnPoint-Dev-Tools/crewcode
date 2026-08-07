import React, { useEffect, useMemo, useRef, useState } from 'react'

import { TAB_COLOR_PALETTE } from '../../types'
import { Icon } from './Icon'

type Screen = 'main' | 'rename' | 'color'

interface TabContextMenuProps {
  x: number
  y: number
  tabId: string
  label: string
  pinned: boolean
  color?: string
  canSplit: boolean
  onRename: (tabId: string, label: string) => void
  onColor:  (tabId: string, color: string | undefined) => void
  onPin:    (tabId: string) => void
  onUnpin:  (tabId: string) => void
  onSplit:  (tabId: string) => void
  onClose:  (tabId: string) => void
  onCloseMenu: () => void
}

export function TabContextMenu({
  x,
  y,
  tabId,
  label,
  pinned,
  color,
  canSplit,
  onRename,
  onColor,
  onPin,
  onUnpin,
  onSplit,
  onClose,
  onCloseMenu,
}: TabContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [screen, setScreen] = useState<Screen>('main')
  const [draft, setDraft] = useState(label)

  useEffect(() => {
    setDraft(label)
  }, [label])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCloseMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (screen === 'main') onCloseMenu()
        else setScreen('main')
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onCloseMenu, screen])

  const left = useMemo(() => Math.max(8, Math.min(x, window.innerWidth - 220)), [x])
  const top = useMemo(() => Math.max(8, Math.min(y, window.innerHeight - 320)), [y])

  const commitRename = () => {
    const next = draft.trim() || label
    onRename(tabId, next)
    onCloseMenu()
  }

  return (
    <div ref={ref} className="ctx-menu" style={{ left, top, position: 'fixed' }}>
      {screen === 'main' && (
        <>
          <button className="ctx-item" onClick={() => setScreen('rename')}>
            <span className="ctx-icon"><Icon name="edit" size={12} /></span>
            <span className="ctx-label">Rename</span>
          </button>
          <button className="ctx-item" onClick={() => setScreen('color')}>
            <span className="ctx-icon"><Icon name="palette" size={12} /></span>
            <span className="ctx-label">Color Code</span>
          </button>
          <button className="ctx-item" onClick={() => (pinned ? onUnpin(tabId) : onPin(tabId))}>
            <span className="ctx-icon"><Icon name="pin" size={12} /></span>
            <span className="ctx-label">{pinned ? 'Unpin' : 'Pin'}</span>
          </button>
          {canSplit && (
            <button className="ctx-item" onClick={() => { onSplit(tabId); onCloseMenu() }}>
              <span className="ctx-icon"><Icon name="panel" size={12} /></span>
              <span className="ctx-label">Split Right</span>
            </button>
          )}
          <div className="ctx-divider" />
          <button className="ctx-item" onClick={() => { onClose(tabId); onCloseMenu() }}>
            <span className="ctx-icon"><Icon name="close" size={12} /></span>
            <span className="ctx-label">Close</span>
          </button>
        </>
      )}

      {screen === 'rename' && (
        <div style={{ padding: 8 }}>
          <input
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename()
              else if (e.key === 'Escape') setScreen('main')
            }}
            style={{
              width: '100%',
              background: 'var(--secondary)',
              color: 'var(--foreground)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '8px 10px',
              font: 'inherit',
              outline: 'none',
            }}
          />
        </div>
      )}

      {screen === 'color' && (
        <div style={{ padding: 8, width: 220 }}>
          <button className="ctx-item" onClick={() => setScreen('main')}>
            <span className="ctx-icon"><Icon name="chevRight" size={12} style={{ transform: 'rotate(180deg)' }} /></span>
            <span className="ctx-label">Back</span>
          </button>
          <div className="ctx-color-grid">
            {TAB_COLOR_PALETTE.map(entry => {
              const selected = (entry.id === 'none' ? undefined : entry.id) === color
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={`ctx-color-swatch ${selected ? 'on' : ''}`}
                  title={entry.label}
                  onClick={() => {
                    onColor(tabId, entry.id === 'none' ? undefined : entry.id)
                    onCloseMenu()
                  }}
                  style={{
                    background: entry.value || 'transparent',
                  }}
                >
                  {entry.id === 'none' && (
                    <span style={{ color: 'var(--muted-foreground)', fontSize: 16, lineHeight: 1 }}>∅</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

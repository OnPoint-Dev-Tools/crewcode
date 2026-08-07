import React, { useEffect, useRef } from 'react'
import { Icon, type IconName } from '../ui/Icon'

export interface ChatContextMenuItem {
  id:       string
  label:    string
  icon?:    IconName
  kbd?:     string
  divider?: boolean
  disabled?: boolean
}

interface ChatContextMenuProps {
  x:        number
  y:        number
  items:    ChatContextMenuItem[]
  onPick:   (id: string) => void
  onClose:  () => void
}

export function ChatContextMenu({ x, y, items, onPick, onClose }: ChatContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown',   onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown',   onKey)
    }
  }, [onClose])

  // Clamp menu inside viewport
  const left = Math.min(x, window.innerWidth  - 240)
  const top  = Math.min(y, window.innerHeight - items.length * 28 - 16)

  return (
    <div ref={ref} className="ctx-menu" style={{ left, top }}>
      {items.map(item =>
        item.divider ? (
          <div key={item.id} className="ctx-divider" />
        ) : (
          <button
            key={item.id}
            className="ctx-item"
            disabled={item.disabled}
            onClick={() => { onPick(item.id); onClose() }}
          >
            <span className="ctx-icon">{item.icon && <Icon name={item.icon} size={12} />}</span>
            <span className="ctx-label">{item.label}</span>
            {item.kbd && <span className="ctx-kbd">{item.kbd}</span>}
          </button>
        ),
      )}
    </div>
  )
}

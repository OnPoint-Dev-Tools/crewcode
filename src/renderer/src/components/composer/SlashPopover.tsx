import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon, type IconName } from '../ui/Icon'

export interface SlashItem {
  id: string
  kind: 'prompt' | 'skill' | 'command'
  title: string
  description: string
}

const KIND_ICON: Record<SlashItem['kind'], IconName> = {
  prompt: 'fileText',
  skill: 'sparkle',
  command: 'terminal',
}

interface SlashPopoverProps {
  items: SlashItem[]
  query: string
  onPick: (id: string) => void
  onClose: () => void
}

export function SlashPopover({ items, query, onPick, onClose }: SlashPopoverProps) {
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter(item => !q || item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q))
  }, [items, query])

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
          onPick(filtered[active].id)
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
        <div className="mention-empty">no commands, prompts, or skills match "{query}"</div>
      </div>
    )
  }

  return (
    <div className="mention-pop" ref={listRef}>
      {filtered.slice(0, 12).map((item, i) => (
        <div
          key={item.id}
          data-idx={i}
          className={`mention-row${i === active ? ' active' : ''}`}
          onMouseDown={e => { e.preventDefault(); onPick(item.id) }}
          onMouseEnter={() => setActive(i)}
        >
          <Icon name={KIND_ICON[item.kind]} size={12} />
          <span className="mention-name">{item.title}</span>
          <span className="mention-dir">{item.kind} · {item.description}</span>
        </div>
      ))}
    </div>
  )
}

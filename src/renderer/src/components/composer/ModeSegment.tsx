import React, { useRef, useState } from 'react'

import { Icon, type IconName } from '../ui/Icon'
import { PickerSheet, type PickerItem } from './PickerSheet'

type Mode = 'Ask' | 'Plan' | 'Build' | 'Full'
const MODES: Mode[] = ['Ask', 'Plan', 'Build', 'Full']

// The mode token doubles as a CSS class suffix and picker id, so it stays a
// single word; MODE_LABEL carries the human name.
const MODE_LABEL: Record<Mode, string> = {
  Ask: 'Ask', Plan: 'Plan', Build: 'Build', Full: 'Full Access',
}

const MODE_META: Record<Mode, { icon: IconName; sub: string; badge?: string }> = {
  Ask:   { icon: 'chat',       sub: 'read-only answers and discovery' },
  Plan:  { icon: 'listChecks', sub: 'fresh context, markdown plan' },
  Build: { icon: 'wrench',     sub: 'careful implementation' },
  Full:  { icon: 'bolt',       sub: 'all tools pre-approved, fast autonomous execution', badge: 'FULL' },
}

interface ModeSegmentProps {
  mode: Mode
  onChange: (m: Mode) => void
}

function modeItems(): PickerItem[] {
  return MODES.map(m => ({
    id:    m,
    label: MODE_LABEL[m],
    sub:   MODE_META[m].sub,
    badge: MODE_META[m].badge,
    icon:  <Icon name={MODE_META[m].icon} size={13} />,
  }))
}

export function ModeSegment({ mode, onChange }: ModeSegmentProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const meta = MODE_META[mode]

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`mode-select mode-${mode.toLowerCase()}`}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`execution mode: ${MODE_LABEL[mode].toLowerCase()}`}
      >
        <span className="mode-select-icon"><Icon name={meta.icon} size={12} /></span>
        <span className="mode-select-text">
          <span className="mode-select-k">mode</span>
          <span className="mode-select-v">{MODE_LABEL[mode]}</span>
        </span>
        <Icon name="chevDown" size={11} />
      </button>
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref.current}
        header="EXECUTION MODE"
        items={modeItems()}
        activeId={mode}
        onPick={id => onChange(id as Mode)}
        width={300}
      />
    </>
  )
}

export type { Mode }

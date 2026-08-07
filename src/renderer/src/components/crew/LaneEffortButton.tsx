import React, { useRef, useState } from 'react'

import { Icon } from '../ui/Icon'
import { effortRowsForProvider } from '../composer/EffortPicker'
import { PickerSheet } from '../composer/PickerSheet'
import type { CrewLaneEffort } from '../../orchestrator/crew-session'

interface LaneEffortButtonProps {
  provider: string
  effort: CrewLaneEffort
  onPick: (effort: CrewLaneEffort) => void
}

/**
 * Per-lane reasoning effort picker — sibling to LaneModelButton. `inherit` keeps
 * the lane on the composer's global effort, otherwise the lane pins its own
 * value and the bridge respawns on the next prompt with the new flag.
 */
export function LaneEffortButton({ provider, effort, onPick }: LaneEffortButtonProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  // Mirror the composer so lanes cannot select values their provider cannot use.
  const rows: { id: string; effort: CrewLaneEffort; label: string; sub: string }[] = [
    { id: 'inherit', effort: null, label: 'inherit', sub: 'use composer effort' },
    ...effortRowsForProvider(provider).map(row => ({ ...row, effort: row.id })),
  ]
  const activeId = rows.find(row => row.effort === effort)?.id ?? 'inherit'

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="crew-lane-effort"
        title={effort === null ? 'inheriting composer effort' : `effort: ${effort}`}
        onClick={() => setOpen(o => !o)}
      >
        <Icon name="sparkle" size={11} />
        <span className="crew-lane-effort-id">{effort ?? 'inherit'}</span>
        <Icon name="chevDown" size={10} />
      </button>
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref.current}
        header="LANE EFFORT"
        items={rows.map(row => ({ id: row.id, label: row.label, sub: row.sub }))}
        activeId={activeId}
        onPick={id => {
          const row = rows.find(candidate => candidate.id === id)
          if (row) onPick(row.effort)
          setOpen(false)
        }}
        defaultIcon={<Icon name="sparkle" size={13} />}
      />
    </>
  )
}

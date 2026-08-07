import React from 'react'

interface LaneRunSwitchProps {
  enabled: boolean
  onToggle: () => void
  compact?: boolean
}

/**
 * Explicit run inclusion switch for a lane's selected model. It is separate from
 * model picking so operators choose both "which model" and "whether it runs".
 */
export function LaneRunSwitch({ enabled, onToggle, compact = false }: LaneRunSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className={`crew-lane-run-switch ${enabled ? 'is-on' : 'is-off'} ${compact ? 'is-compact' : ''}`}
      title={enabled ? 'included in this run' : 'excluded from this run'}
      onClick={onToggle}
    >
      <span className="crew-lane-run-track" aria-hidden="true">
        <span className="crew-lane-run-thumb" />
      </span>
      <span className="crew-lane-run-label">{enabled ? 'use' : 'skip'}</span>
    </button>
  )
}

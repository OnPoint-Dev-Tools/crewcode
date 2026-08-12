import React from 'react'

interface LaneRunSwitchProps {
  enabled: boolean
  onToggle: () => void
  compact?: boolean
}

/**
 * Explicit pause/resume switch for one durable lane. Pausing stops its runtime
 * while preserving the worktree, transcript, and next-action checkpoint.
 */
export function LaneRunSwitch({ enabled, onToggle, compact = false }: LaneRunSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      className={`crew-lane-run-switch ${enabled ? 'is-on' : 'is-off'} ${compact ? 'is-compact' : ''}`}
      title={enabled ? 'lane enabled for delegation; pause it' : 'lane paused; resume with its retained next action'}
      onClick={onToggle}
    >
      <span className="crew-lane-run-track" aria-hidden="true">
        <span className="crew-lane-run-thumb" />
      </span>
      <span className="crew-lane-run-label">{enabled ? 'enabled' : 'paused'}</span>
    </button>
  )
}

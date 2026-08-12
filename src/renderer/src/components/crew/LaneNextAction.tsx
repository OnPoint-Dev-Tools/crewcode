import React from 'react'

interface LaneNextActionProps {
  value: string
  paused: boolean
  onChange: (value: string) => void
  compact?: boolean
}

/**
 * Durable operator checkpoint for one lane/worktree. Assignments seed this text
 * automatically, but the operator can rewrite it into the precise next step to
 * use after switching attention or restarting CrewCode.
 */
export function LaneNextAction({ value, paused, onChange, compact = false }: LaneNextActionProps) {
  return (
    <label className={`lane-next-action ${paused ? 'is-paused' : ''} ${compact ? 'is-compact' : ''}`}>
      <span>{paused ? 'resume with' : 'next action'}</span>
      <input
        type="text"
        value={value}
        maxLength={500}
        placeholder={paused ? 'record what this lane should do when resumed' : 'record this lane’s next step'}
        aria-label={paused ? 'next action when lane resumes' : 'lane next action'}
        onChange={event => onChange(event.target.value)}
      />
    </label>
  )
}

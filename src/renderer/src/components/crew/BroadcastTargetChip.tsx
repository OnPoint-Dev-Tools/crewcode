import React, { useRef, useState } from 'react'

import { Icon } from '../ui/Icon'
import { PickerSheet } from '../composer/PickerSheet'
import type { CrewAgentLane } from '../../orchestrator/crew-session'
import type { AgentInfo } from '../../types'

interface BroadcastTargetChipProps {
  lanes:    CrewAgentLane[]
  agents:   AgentInfo[]
  /** null = broadcast to all run-enabled lanes. */
  targetId: string | null
  onPick:   (laneId: string | null) => void
}

const ALL_ID = '__all__'

/**
 * Sits above the shared-mode composer. The chip shows whether the next send
 * fans out to every run-enabled lane or hits one specific enabled lane, and
 * clicking opens a picker to switch.
 */
export function BroadcastTargetChip({ lanes, agents, targetId, onPick }: BroadcastTargetChipProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  const enabledLanes = lanes.filter(l => !l.muted)
  const reach = enabledLanes.length
  const target = enabledLanes.find(l => l.laneId === targetId) ?? null
  const targetName = target
    ? (agents.find(a => a.id === target.agentId)?.name ?? target.agentId)
    : null

  const items = [
    {
      id:    ALL_ID,
      label: `broadcast`,
      sub:   `${reach} of ${lanes.length} model${lanes.length === 1 ? '' : 's'} enabled`,
    },
    ...enabledLanes.map(l => {
      const a = agents.find(a => a.id === l.agentId)
      return {
        id:    l.laneId,
        label: a?.name ?? l.agentId,
        sub:   `target only · ${l.roleName || 'no role'}`,
      }
    }),
  ]

  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`crew-broadcast-chip ${target ? 'is-targeted' : 'is-broadcast'}`}
        onClick={() => setOpen(o => !o)}
        title={target
          ? `next prompt → ${targetName} only`
          : `next prompt → broadcast to ${reach} enabled model${reach === 1 ? '' : 's'}`}
      >
        <Icon name={target ? 'target' : 'megaphone'} size={11} />
        <span className="crew-broadcast-chip-text">
          {target ? `→ ${targetName}` : `broadcast · ${reach}/${lanes.length}`}
        </span>
        <Icon name="chevDown" size={10} />
      </button>
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref.current}
        header="NEXT PROMPT"
        items={items}
        activeId={targetId ?? ALL_ID}
        onPick={id => {
          onPick(id === ALL_ID ? null : id)
          setOpen(false)
        }}
        defaultIcon={<Icon name="bot" size={13} />}
      />
    </>
  )
}

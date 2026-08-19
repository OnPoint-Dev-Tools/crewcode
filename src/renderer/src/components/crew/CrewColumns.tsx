import React, { useEffect, useState } from 'react'

import { LaneColumn } from './LaneColumn'
import { LaneComposer } from './LaneComposer'
import { BroadcastTargetChip } from './BroadcastTargetChip'
import { crewDistribution } from '../../orchestrator/crew-session'
import type { Message, AgentInfo, PtyPane, AgentUserRequest, AgentUserResponse } from '../../types'
import type { CrewSession, CrewLaneEffort } from '../../orchestrator/crew-session'

interface CrewColumnsProps {
  session:       CrewSession
  agents:        AgentInfo[]
  messagesByTab: Record<string, Message[]>
  ptyPanes:      PtyPane[]
  onSendToLane:  (laneId: string, text: string) => void
  onBroadcast:   (text: string) => void
  onClosePane:   (paneId: string) => void
  onSetLaneModel:  (laneId: string, model: string) => void
  onSetLaneEffort: (laneId: string, effort: CrewLaneEffort) => void
  onRestartLane:   (laneId: string) => void
  onToggleLaneMute:(laneId: string) => void
  onSetLaneNextAction: (laneId: string, nextAction: string) => void
  userRequestsByTab?: Record<string, AgentUserRequest[]>
  onAgentRequestResponse?: (response: AgentUserResponse) => void
  /** Hide every composer — set when the Supervisor owns the crew's input. */
  hideComposer?:   boolean
}

/**
 * Isolated mode — every lane as its own pane card, each on its own worktree
 * with its own thread and composer. Seeing the lanes progress in parallel is
 * the point, so they share Workbench's responsive pane grid: lanes wrap onto
 * new rows instead of squeezing into a horizontal scroller.
 *
 * Input follows `session.distribution`, matching shared mode: `split` keeps one
 * composer inside each lane card so the user sends a distinct task per worker;
 * `broadcast` drops those and puts a single centered composer under the grid
 * that fans the same text out to every run-enabled lane at once.
 */
export function CrewColumns({
  session, agents, messagesByTab, ptyPanes,
  onSendToLane, onBroadcast, onClosePane, onSetLaneModel, onSetLaneEffort, onRestartLane, onToggleLaneMute, onSetLaneNextAction,
  userRequestsByTab, onAgentRequestResponse,
  hideComposer = false,
}: CrewColumnsProps) {
  // null = broadcast to all run-enabled lanes; otherwise sends only to this lane.
  const [targetId, setTargetId] = useState<string | null>(null)
  // null = show the grid; otherwise this one lane fills the whole surface so a
  // long worker thread is actually readable.
  const [maximizedId, setMaximizedId] = useState<string | null>(null)

  // Resolve against live lanes: a maximized lane that is edited away or archived
  // must fall back to the grid rather than render an empty surface.
  const maximizedLane = session.lanes.find(l => l.laneId === maximizedId) ?? null
  const visibleLanes = maximizedLane ? [maximizedLane] : session.lanes

  useEffect(() => {
    if (!maximizedLane) return undefined
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaximizedId(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximizedLane])

  const split = crewDistribution(session) === 'split'
  // A lane whose run switch was flipped off (or that was removed) mid-session
  // silently falls back to broadcast on the next send.
  const targetLane   = session.lanes.find(l => l.laneId === targetId && !l.muted)
  const enabledLanes = session.lanes.filter(l => !l.muted)
  const reach        = enabledLanes.length
  const agentName    = (id: string) => agents.find(a => a.id === id)?.name ?? id

  const showBroadcastFoot = !hideComposer && !split
  const placeholder = targetLane
    ? `message ${agentName(targetLane.agentId)} only`
    : reach > 0
      ? `broadcast to ${reach} enabled model${reach === 1 ? '' : 's'}`
      : 'enable a model before sending'

  const handleBroadcastSend = (text: string) => {
    if (targetLane) onSendToLane(targetLane.laneId, text)
    else            onBroadcast(text)
  }

  return (
    <div className="crew-columns-wrap">
      <div className={`canvas-mode-pane-grid crew-pane-grid ${maximizedLane ? 'is-maximized' : ''}`}>
        {visibleLanes.map((lane, i) => {
          const tabId = lane.tabId ?? ''
          return (
            <LaneColumn
              key={lane.laneId}
              index={i}
              lane={lane}
              agent={agents.find(a => a.id === lane.agentId)}
              messages={messagesByTab[tabId] ?? []}
              ptyPane={ptyPanes.find(p => p.tabId === tabId)}
              onSend={text => onSendToLane(lane.laneId, text)}
              onClosePane={onClosePane}
              onSetModel={m => onSetLaneModel(lane.laneId, m)}
              onSetEffort={e => onSetLaneEffort(lane.laneId, e)}
              onRestart={() => onRestartLane(lane.laneId)}
              onToggleMute={() => onToggleLaneMute(lane.laneId)}
              onSetNextAction={nextAction => onSetLaneNextAction(lane.laneId, nextAction)}
              agentRequest={(userRequestsByTab?.[tabId] ?? [])[0] ?? null}
              onAgentRequestResponse={onAgentRequestResponse}
              hideComposer={hideComposer || !split}
              maximized={!!maximizedLane}
              onToggleMaximize={() => setMaximizedId(id => (id === lane.laneId ? null : lane.laneId))}
            />
          )
        })}
      </div>

      {showBroadcastFoot && (
        <div className="crew-broadcast-foot">
          <div className="crew-broadcast-center">
            <BroadcastTargetChip
              lanes={session.lanes}
              agents={agents}
              targetId={targetId}
              onPick={setTargetId}
            />
            <LaneComposer
              workspacePath={targetLane?.path || session.basePath}
              placeholder={`${placeholder} · use @ to add files`}
              disabled={reach === 0 && !targetLane}
              running={targetLane
                ? !!(targetLane.bridgeId || targetLane.paneId)
                : enabledLanes.some(l => l.bridgeId || l.paneId)}
              onStop={targetLane ? () => onRestartLane(targetLane.laneId) : undefined}
              onSend={handleBroadcastSend}
            />
          </div>
        </div>
      )}
    </div>
  )
}

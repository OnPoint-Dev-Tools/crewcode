import React from 'react'

import { LaneColumn } from './LaneColumn'
import type { Message, AgentInfo, PtyPane, AgentUserRequest, AgentUserResponse } from '../../types'
import type { CrewSession, CrewLaneEffort } from '../../orchestrator/crew-session'

interface CrewColumnsProps {
  session:       CrewSession
  agents:        AgentInfo[]
  messagesByTab: Record<string, Message[]>
  ptyPanes:      PtyPane[]
  onSendToLane:  (laneId: string, text: string) => void
  onClosePane:   (paneId: string) => void
  onSetLaneModel:  (laneId: string, model: string) => void
  onSetLaneEffort: (laneId: string, effort: CrewLaneEffort) => void
  onRestartLane:   (laneId: string) => void
  onToggleLaneMute:(laneId: string) => void
  onSetLaneNextAction: (laneId: string, nextAction: string) => void
  userRequestsByTab?: Record<string, AgentUserRequest[]>
  onAgentRequestResponse?: (response: AgentUserResponse) => void
  /** Hide each lane's composer — set when the Supervisor owns the crew's input. */
  hideComposer?:   boolean
}

/**
 * Isolated mode — every lane side by side, each on its own worktree with its
 * own thread and composer. Seeing the lanes progress in parallel is the point.
 */
export function CrewColumns({
  session, agents, messagesByTab, ptyPanes,
  onSendToLane, onClosePane, onSetLaneModel, onSetLaneEffort, onRestartLane, onToggleLaneMute, onSetLaneNextAction,
  userRequestsByTab, onAgentRequestResponse,
  hideComposer = false,
}: CrewColumnsProps) {
  return (
    <div className="crew-columns">
      {session.lanes.map((lane, i) => {
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
            hideComposer={hideComposer}
          />
        )
      })}
    </div>
  )
}

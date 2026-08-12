import React, { useEffect, useRef, useState } from 'react'

import { Icon } from '../ui/Icon'
import { Messages } from '../thread/Messages'
import { AgentActivityOverlay } from '../thread/AgentActivityOverlay'
import { latestTodoActivity } from '../thread/todo-from-toolcall'
import { LaneComposer } from './LaneComposer'
import { LaneModelButton } from './LaneModelButton'
import { LaneRunSwitch } from './LaneRunSwitch'
import { LaneNextAction } from './LaneNextAction'
import { LaneEffortButton } from './LaneEffortButton'
import { BroadcastTargetChip } from './BroadcastTargetChip'
import { buildCrewRounds } from './crew-rounds'
import { shortModel } from './model-label'
import { formatTokens, formatElapsed } from './lane-usage-format'
import { PROVIDER_IMAGES, providerImageClass } from '../composer/provider-meta'
import { crewDistribution } from '../../orchestrator/crew-session'
import type { Message, AgentInfo, AgentUserRequest, AgentUserResponse } from '../../types'
import type { CrewSession, CrewLaneEffort } from '../../orchestrator/crew-session'

interface CrewTimelineProps {
  session:          CrewSession
  agents:           AgentInfo[]
  messagesByTab:    Record<string, Message[]>
  onBroadcast:      (text: string) => void
  onSendToLane:     (laneId: string, text: string) => void
  onSetLaneModel:   (laneId: string, model: string) => void
  onSetLaneEffort:  (laneId: string, effort: CrewLaneEffort) => void
  onRestartLane:    (laneId: string) => void
  onToggleLaneMute: (laneId: string) => void
  onSetLaneNextAction: (laneId: string, nextAction: string) => void
  userRequestsByTab?: Record<string, AgentUserRequest[]>
  onAgentRequestResponse?: (response: AgentUserResponse) => void
  /** Hide the broadcast composer — set when the Supervisor owns the crew's input. */
  hideComposer?:    boolean
}

/**
 * Shared mode — every lane works the same branch, so their threads merge into
 * one timeline: each broadcast prompt followed by every agent's answer, grouped
 * side by side. The composer can broadcast to every run-enabled lane or be
 * retargeted at a single enabled lane via the chip above it; per-lane controls
 * live in each group head.
 */
export function CrewTimeline({
  session, agents, messagesByTab,
  onBroadcast, onSendToLane, onSetLaneModel, onSetLaneEffort, onRestartLane, onToggleLaneMute, onSetLaneNextAction,
  userRequestsByTab, onAgentRequestResponse,
  hideComposer = false,
}: CrewTimelineProps) {
  // null = broadcast to all run-enabled lanes; otherwise sends only to this lane.
  const [targetId, setTargetId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [showScrollBottom, setShowScrollBottom] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // If the target lane is removed or excluded mid-session, the targetId silently
  // falls back to broadcast on the next send (lookup just returns undefined).
  const targetLane = session.lanes.find(l => l.laneId === targetId && !l.muted)
  const handleSend = (text: string) => {
    if (targetLane) onSendToLane(targetLane.laneId, text)
    else            onBroadcast(text)
  }

  const rounds = buildCrewRounds(
    session.lanes.map(lane => ({ lane, messages: messagesByTab[lane.tabId ?? ''] ?? [] })),
  )

  // Show the jump-to-latest button only when the user has scrolled up past
  // threshold; hide once they're back near the bottom. Mirrors SupervisorSidebar.
  const updateScrollBottomButton = () => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowScrollBottom(distance > 80)
  }
  const scrollToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setShowScrollBottom(false)
  }

  useEffect(() => {
    requestAnimationFrame(updateScrollBottomButton)
  }, [rounds.length, messagesByTab])
  const agentName = (id: string) => agents.find(a => a.id === id)?.name ?? id
  const enabledLanes = session.lanes.filter(l => !l.muted)
  const providerLogo = (agentId: string) => PROVIDER_IMAGES[agentId]
    ? <img src={PROVIDER_IMAGES[agentId]} alt={agentId} className={`lane-head-provider ${providerImageClass(agentId)}`} width={16} height={16} />
    : null
  const reach     = enabledLanes.length
  // Split → one composer per worker so the user sends a distinct task to each;
  // broadcast → a single composer that fans the same text out to every worker.
  const split     = crewDistribution(session) === 'split'
  const placeholder = targetLane
    ? `message ${agentName(targetLane.agentId)} only`
    : reach > 0
      ? `broadcast to ${reach} enabled model${reach === 1 ? '' : 's'}`
      : 'enable a model above before sending'

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => ({ ...prev, [key]: !prev[key] }))
  }

  return (
    <div className="crew-timeline">
      <div className="crew-timeline-scroll" ref={scrollRef} onScroll={updateScrollBottomButton}>
        {rounds.length === 0 && (
          <div className="crew-run-setup">
            <div className="crew-run-setup-copy">
              choose which selected models participate before sending a prompt on {session.baseBranch}
            </div>
            <div className="crew-run-setup-lanes">
              {session.lanes.map(lane => (
                <div key={lane.laneId} className={`crew-run-setup-lane ${lane.muted ? 'is-muted' : ''}`}>
                  <div className="crew-run-setup-main">
                    {providerLogo(lane.agentId)}
                    <span className="lane-head-agent">{agentName(lane.agentId)}</span>
                    <span className="lane-head-role">{lane.roleName || 'no role'}</span>
                  </div>
                  <LaneNextAction
                    value={lane.nextAction ?? ''}
                    paused={lane.muted}
                    compact
                    onChange={nextAction => onSetLaneNextAction(lane.laneId, nextAction)}
                  />
                  <LaneModelButton
                    provider={lane.agentId}
                    model={lane.model}
                    onPick={m => onSetLaneModel(lane.laneId, m)}
                    placement="down"
                  />
                  <LaneRunSwitch enabled={!lane.muted} onToggle={() => onToggleLaneMute(lane.laneId)} />
                  <LaneEffortButton provider={lane.agentId} effort={lane.effort} onPick={e => onSetLaneEffort(lane.laneId, e)} />
                </div>
              ))}
            </div>
          </div>
        )}
        {rounds.map((round, i) => (
          <div key={i} className={`crew-round ${split ? 'is-split' : 'is-broadcast'}`}>
            {!split && (
              <div className="crew-round-prompt">
                <div className="bub-user">{round.prompt}</div>
                {round.time && <div className="ts">{round.time}</div>}
              </div>
            )}
            <div className="crew-round-lanes">
              {round.groups.map(group => {
                const lane  = group.lane
                const live  = !!(lane.bridgeId || lane.paneId)
                const usage = lane.usage
                const todoActivity = i === rounds.length - 1 ? latestTodoActivity(group.messages) : null
                const request = (userRequestsByTab?.[lane.tabId ?? ''] ?? [])[0]
                const groupKey = `${i}:${lane.laneId}`
                const collapsed = collapsedGroups[groupKey] === true
                return (
                  <div
                    key={lane.laneId}
                    className={`crew-lane-group ${lane.muted ? 'is-muted' : ''} ${collapsed ? 'is-collapsed' : ''}`}
                  >
                    <div className="crew-lane-group-head">
                      {providerLogo(lane.agentId)}
                      <span className="lane-head-agent">{agentName(lane.agentId)}</span>
                      <span className="lane-head-role">{lane.roleName || 'no role'}</span>
                      <div className="lane-head-spacer" />
                      <button
                        type="button"
                        className="lane-head-btn crew-lane-collapse"
                        title={collapsed ? 'open worker thread' : 'collapse worker thread'}
                        aria-expanded={!collapsed}
                        onClick={() => toggleGroup(groupKey)}
                      >
                        <Icon name={collapsed ? 'chevRight' : 'chevDown'} size={11} />
                      </button>
                      <button
                        type="button"
                        className="lane-head-btn"
                        title={live ? 'stop · next prompt respawns' : 'no live process'}
                        disabled={!live}
                        onClick={() => onRestartLane(lane.laneId)}
                      >
                        <Icon name="refresh" size={11} />
                      </button>
                      <span className={`crew-status-dot status-${lane.status}`} />
                    </div>
                    {!collapsed && (
                      <>
                        {split && group.prompt && (
                          <div className="crew-lane-task">
                            <div className="bub-user">{group.prompt}</div>
                            {group.time && <div className="ts">{group.time}</div>}
                          </div>
                        )}
                        {/* In-timeline lane controls — only on the most recent round so the
                            history stays clean while edits act on the live config. */}
                        {i === rounds.length - 1 && (
                          <div className="crew-lane-group-meta">
                            <LaneModelButton
                              provider={lane.agentId}
                              model={lane.model}
                              onPick={m => onSetLaneModel(lane.laneId, m)}
                            />
                            <LaneRunSwitch compact enabled={!lane.muted} onToggle={() => onToggleLaneMute(lane.laneId)} />
                            <LaneEffortButton provider={lane.agentId} effort={lane.effort} onPick={e => onSetLaneEffort(lane.laneId, e)} />
                            {(usage.tokensIn > 0 || usage.tokensOut > 0 || usage.elapsedMs > 0) && (
                              <span className="crew-lane-group-usage" title={`in ${usage.tokensIn} · out ${usage.tokensOut}`}>
                                <Icon name="clock" size={10} />{formatElapsed(usage.elapsedMs)}
                                {' · '}
                                {formatTokens(usage.tokensIn + usage.tokensOut)}
                              </span>
                            )}
                            <LaneNextAction
                              value={lane.nextAction ?? ''}
                              paused={lane.muted}
                              compact
                              onChange={nextAction => onSetLaneNextAction(lane.laneId, nextAction)}
                            />
                          </div>
                        )}
                        {i !== rounds.length - 1 && (
                          <div className="crew-lane-group-history-model mono" title={lane.model || 'provider default'}>
                            {shortModel(lane.model)}
                          </div>
                        )}
                        {(request || todoActivity) && (
                          <div className="composer-activity-shell">
                            <AgentActivityOverlay
                              todos={todoActivity?.todos ?? []}
                              isStreaming={todoActivity?.isStreaming ?? live}
                              request={request}
                              onRespond={onAgentRequestResponse}
                            />
                          </div>
                        )}
                        {group.messages.length === 0
                          ? <div className="crew-lane-group-wait">waiting…</div>
                          : <Messages messages={group.messages} />}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        {showScrollBottom && (
          <button type="button" className="crew-scroll-bottom" onClick={scrollToBottom} title="scroll to latest crew message">
            <Icon name="arrowDown" size={12} />
          </button>
        )}
      </div>
      {!hideComposer && !split && (
        <div className="crew-timeline-foot">
          <BroadcastTargetChip
            lanes={session.lanes}
            agents={agents}
            targetId={targetId}
            onPick={setTargetId}
          />
          <LaneComposer
            workspacePath={session.basePath}
            placeholder={`${placeholder} · use @ to add files`}
            disabled={reach === 0 && !targetLane}
            running={targetLane ? !!(targetLane.bridgeId || targetLane.paneId) : enabledLanes.some(l => l.bridgeId || l.paneId)}
            onStop={targetLane ? () => onRestartLane(targetLane.laneId) : undefined}
            onSend={handleSend}
          />
        </div>
      )}
      {!hideComposer && split && (
        <div className="crew-timeline-foot crew-split-foot">
          {reach === 0
            ? <div className="crew-split-empty">enable a model above to send a task</div>
            : enabledLanes.map(lane => (
              <div key={lane.laneId} className="crew-split-composer">
                <span className="crew-split-label">
                  {providerLogo(lane.agentId)}
                  <span className="lane-head-agent">{agentName(lane.agentId)}</span>
                  <span className="lane-head-role">{lane.roleName || 'no role'}</span>
                </span>
                <LaneComposer
                  workspacePath={lane.path || session.basePath}
                  placeholder={`task for ${agentName(lane.agentId)} · use @ to add files`}
                  running={!!(lane.bridgeId || lane.paneId)}
                  onStop={() => onRestartLane(lane.laneId)}
                  onSend={text => onSendToLane(lane.laneId, text)}
                />
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

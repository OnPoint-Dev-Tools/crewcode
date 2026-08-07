import React from 'react'

import { Icon } from '../ui/Icon'
import { Messages } from '../thread/Messages'
import { XTermPane } from '../terminal/XTermPane'
import { AgentActivityOverlay } from '../thread/AgentActivityOverlay'
import { latestTodoActivity } from '../thread/todo-from-toolcall'
import { LaneComposer } from './LaneComposer'
import { LaneModelButton } from './LaneModelButton'
import { LaneRunSwitch } from './LaneRunSwitch'
import { LaneEffortButton } from './LaneEffortButton'
import { shortModel } from './model-label'
import { formatTokens, formatElapsed } from './lane-usage-format'
import { PROVIDER_IMAGES, providerImageClass } from '../composer/provider-meta'
import type { Message, AgentInfo, PtyPane, AgentUserRequest, AgentUserResponse } from '../../types'
import type { CrewAgentLane, CrewLaneEffort } from '../../orchestrator/crew-session'

interface LaneColumnProps {
  /** Position in the row — drives the stagger entry animation via --lane-i. */
  index?:      number
  lane:        CrewAgentLane
  agent:       AgentInfo | undefined
  messages:    Message[]
  ptyPane:     PtyPane | undefined
  onSend:      (text: string) => void
  onClosePane: (paneId: string) => void
  onSetModel:  (model: string) => void
  onSetEffort: (effort: CrewLaneEffort) => void
  onRestart:   () => void
  onToggleMute:() => void
  agentRequest?: AgentUserRequest | null
  onAgentRequestResponse?: (response: AgentUserResponse) => void
  /** Hide the per-lane composer — set when the Supervisor owns the crew's input. */
  hideComposer?: boolean
}

/**
 * One isolated-mode lane: agent header (with live controls), its own thread
 * (or embedded terminal for pty agents), and its own composer. The header
 * exposes per-lane model + run inclusion + effort, a stop/respawn button, and a
 * compact usage strip — every operator needs these controls in the lane card
 * rather than in a separate menu.
 */
export function LaneColumn({
  index = 0,
  lane, agent, messages, ptyPane,
  onSend, onClosePane, onSetModel, onSetEffort, onRestart, onToggleMute,
  agentRequest = null, onAgentRequestResponse,
  hideComposer = false,
}: LaneColumnProps) {
  const name    = agent?.name ?? lane.agentId
  const isPty   = agent?.transport === 'pty'
  const offline = !agent?.available
  const live    = !!(lane.bridgeId || lane.paneId)
  const usage   = lane.usage
  const todoActivity = latestTodoActivity(messages)
  // pty agents take the lane model as a CLI flag — bridges apply it at spawn,
  // so this is the only place a pty lane's picked model reaches the process.
  const ptyArgv = isPty && lane.model ? ['--model', lane.model] : undefined

  return (
    <div
      className={`lane-col ${lane.muted ? 'is-muted' : ''}`}
      style={{ ['--lane-i' as string]: index }}
    >
      <header className="lane-head">
        <div className="lane-head-row">
          {PROVIDER_IMAGES[lane.agentId] && (
            <img
              src={PROVIDER_IMAGES[lane.agentId]}
              alt={lane.agentId}
              className={`lane-head-provider ${providerImageClass(lane.agentId)}`}
              width={16}
              height={16}
            />
          )}
          <span className="lane-head-agent crew-diff-base">{name}</span>
          <span className="lane-head-role">{lane.roleName || 'no role'}</span>
          <div className="lane-head-spacer" />
          <button
            type="button"
            className="lane-head-btn"
            title={live ? 'stop agent — next prompt respawns it' : 'no live process'}
            disabled={!live}
            onClick={onRestart}
          >
            <Icon name="refresh" size={11} />
          </button>
          <span
            className={`crew-status-dot status-${lane.status}`}
            title={lane.muted ? `${lane.status} · skipped for this run` : lane.status}
          />
        </div>
        <div className="lane-head-row lane-head-meta">
          <span className="lane-head-branch mono" title={lane.path || lane.branch}>{lane.branch}</span>
          <LaneModelButton
            provider={lane.agentId}
            model={lane.model}
            onPick={onSetModel}
          />
          <LaneRunSwitch enabled={!lane.muted} onToggle={onToggleMute} />
          <LaneEffortButton provider={lane.agentId} effort={lane.effort} onPick={onSetEffort} />
        </div>
        {(usage.tokensIn > 0 || usage.tokensOut > 0 || usage.elapsedMs > 0) && (
          <div className="lane-usage" title={`in ${usage.tokensIn} · out ${usage.tokensOut} · ${usage.elapsedMs}ms`}>
            <span className="lane-usage-cell"><Icon name="arrowDown" size={10} />{formatTokens(usage.tokensIn)}</span>
            <span className="lane-usage-cell"><Icon name="arrowUp"   size={10} />{formatTokens(usage.tokensOut)}</span>
            {/*
              Re-keying the clock cell on every elapsed update re-mounts it, so
              the once-per-tick pulse animation actually replays.
            */}
            <span
              key={usage.elapsedMs}
              className={`lane-usage-cell ${live ? 'is-ticking' : ''}`}
            >
              <Icon name="clock" size={10} />{formatElapsed(usage.elapsedMs)}
            </span>
          </div>
        )}
      </header>

      <div className={`lane-body ${isPty ? 'lane-body-term' : ''}`}>
        {offline ? (
          <div className="lane-empty">{lane.agentId} is unavailable</div>
        ) : lane.muted ? (
          <div className="lane-empty">enable this model to include {name} in the next run</div>
        ) : isPty ? (
          ptyPane
            ? <XTermPane
                pane={ptyPane}
                shell={agent?.path ?? undefined}
                argv={ptyArgv}
                onClose={() => onClosePane(ptyPane.paneId)}
              />
            : <div className="lane-empty">send a prompt to start {name}</div>
        ) : (
          <div className="lane-thread">
            {(agentRequest || todoActivity) && (
              <div className="composer-activity-shell">
                <AgentActivityOverlay
                  todos={todoActivity?.todos ?? []}
                  isStreaming={todoActivity?.isStreaming ?? live}
                  request={agentRequest ?? undefined}
                  onRespond={onAgentRequestResponse}
                />
              </div>
            )}
            {messages.length === 0
              ? <div className="lane-empty">send a prompt to start {name} · {shortModel(lane.model)}</div>
              : <Messages messages={messages} />}
          </div>
        )}
      </div>

      {!hideComposer && (
        <LaneComposer
          placeholder={lane.muted ? `enable ${name} to message this model` : `message ${name}`}
          disabled={offline || lane.muted}
          running={live}
          onStop={onRestart}
          onSend={onSend}
        />
      )}
    </div>
  )
}

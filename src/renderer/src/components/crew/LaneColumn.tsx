import React, { useCallback, useEffect } from 'react'

import { Icon } from '../ui/Icon'
import { Messages } from '../thread/Messages'
import { useStickToBottom } from '../../hooks/useStickToBottom'
import { XTermPane } from '../terminal/XTermPane'
import { AgentActivityOverlay } from '../thread/AgentActivityOverlay'
import { latestTodoActivity } from '../thread/todo-from-toolcall'
import { LaneComposer } from './LaneComposer'
import { LaneModelButton } from './LaneModelButton'
import { LaneRunSwitch } from './LaneRunSwitch'
import { LaneNextAction } from './LaneNextAction'
import { LaneEffortButton } from './LaneEffortButton'
import { CustodyHaltBanner } from '../chat/CustodyHaltBanner'
import { shortModel } from './model-label'
import { formatTokens, formatElapsed } from './lane-usage-format'
import { PROVIDER_IMAGES, providerImageClass } from '../composer/provider-meta'
import type { Message, AgentInfo, PtyPane, AgentUserRequest, AgentUserResponse } from '../../types'
import type { CrewAgentLane, CrewLaneEffort } from '../../orchestrator/crew-session'
import { bridgeActivity, useCustodyHalt, useIsBridgeRunning } from '../../stores/bridge-activity-store'
import { getCrewCodeClient } from '../../runtime/crewcode-client'

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
  onSetNextAction: (nextAction: string) => void
  agentRequest?: AgentUserRequest | null
  onAgentRequestResponse?: (response: AgentUserResponse) => void
  /** Hide the per-lane composer — set when the Supervisor owns the crew's input. */
  hideComposer?: boolean
  /** This lane is the only one rendered, filling the whole crew surface. */
  maximized?: boolean
  /** Toggle this lane between the pane grid and full-surface reading view. */
  onToggleMaximize?: () => void
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
  onSend, onClosePane, onSetModel, onSetEffort, onRestart, onToggleMute, onSetNextAction,
  agentRequest = null, onAgentRequestResponse,
  hideComposer = false,
  maximized = false, onToggleMaximize,
}: LaneColumnProps) {
  const name    = agent?.name ?? lane.agentId
  const isPty   = agent?.transport === 'pty'
  const offline = !agent?.available
  const live    = !!(lane.bridgeId || lane.paneId)
  const usage   = lane.usage
  const todoActivity = latestTodoActivity(messages)
  // pty lanes render a raw terminal — they have no bridge requests or todo
  // stream, so the dock stays composer-only there.
  const showActivity = !isPty && !!(agentRequest || todoActivity)
  // pty agents take the lane model as a CLI flag — bridges apply it at spawn,
  // so this is the only place a pty lane's picked model reaches the process.
  const ptyArgv = isPty && lane.model ? ['--model', lane.model] : undefined
  // Follow the newest output while the worker streams, but stop following the
  // moment the operator scrolls up to read — re-arms when they scroll back down.
  const thread = useStickToBottom(messages, !isPty)
  // `live` only means a bridge/pane is attached — it stays true between turns.
  // The waiting loader needs the real turn-in-flight signal, or it never clears.
  const streaming = useIsBridgeRunning(lane.bridgeId ?? null)
  const laneTabId = lane.tabId ?? ''
  const custodyHalt = useCustodyHalt(laneTabId)
  const reauthorizeCustody = useCallback(async () => {
    if (!custodyHalt) return
    const result = await getCrewCodeClient().bridgeReauthorize({ scopeKey: custodyHalt.scopeKey })
    if (!result.ok) throw new Error(result.error ?? 'Reauthorization was refused')
    bridgeActivity.clearCustodyHaltsForScope(custodyHalt.scopeKey)
  }, [custodyHalt])

  useEffect(() => {
    if (!lane.tabId || isPty) return
    let cancelled = false
    const scopeKey = `${lane.tabId}:${lane.agentId}`
    void getCrewCodeClient().bridgeCustodyState({ sessionKey: scopeKey }).then(state => {
      if (cancelled || !state?.ok || !state.halt) return
      bridgeActivity.setCustodyHalt(lane.tabId!, {
        scopeKey: state.scopeKey,
        violation: state.halt,
        interruptedPrompt: state.record?.interruptedPrompt,
        interruptedPartial: state.record?.interruptedPartial,
      })
    }).catch(() => { /* read-only recovery evidence; lane remains inspectable */ })
    return () => { cancelled = true }
  }, [isPty, lane.agentId, lane.tabId])

  return (
    <div
      className={`canvas-mode-pane ${isPty ? 'canvas-pane-terminal' : 'canvas-pane-chat'} lane-col ${lane.muted ? 'is-muted' : ''}`}
      style={{ ['--lane-i' as string]: index }}
    >
      <div className="canvas-mode-pane-bar">
        <span className="canvas-mode-pane-title">
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
        </span>
        <div className="canvas-mode-pane-actions">
          <button
            type="button"
            className="lane-head-btn"
            title={live ? 'stop agent — next prompt respawns it' : 'no live process'}
            disabled={!live}
            onClick={onRestart}
          >
            <Icon name="refresh" size={11} />
          </button>
          {onToggleMaximize && (
            <button
              type="button"
              className={`lane-head-btn ${maximized ? 'is-on' : ''}`}
              title={maximized ? 'restore the lane grid (Esc)' : `expand ${name} to the full crew surface`}
              aria-pressed={maximized}
              onClick={onToggleMaximize}
            >
              <Icon name={maximized ? 'shrink' : 'expand'} size={11} />
            </button>
          )}
          <span
            className={`crew-status-dot status-${lane.status}`}
            title={lane.muted ? 'paused · worktree and next action retained' : lane.status}
          />
        </div>
      </div>

      <header className="lane-head">
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
        <LaneNextAction
          value={lane.nextAction ?? ''}
          paused={lane.muted}
          onChange={onSetNextAction}
        />
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
        {custodyHalt && <CustodyHaltBanner halt={custodyHalt} onReauthorize={reauthorizeCustody} />}
        {offline ? (
          <div className="lane-empty">{lane.agentId} is unavailable</div>
        ) : lane.muted ? (
          <div className="lane-empty">paused — resume when ready; this worktree and its next action are retained</div>
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
          <div className="lane-thread" ref={thread.ref} onScroll={thread.onScroll}>
            {messages.length === 0
              ? <div className="lane-empty">send a prompt to start {name} · {shortModel(lane.model)}</div>
              : <Messages messages={messages} isRunning={streaming} />}
            {thread.scrolledUp && (
              <button
                type="button"
                className="lane-scroll-bottom"
                onClick={() => thread.scrollToBottom('smooth')}
                title="jump to the newest output"
              >
                <Icon name="arrowDown" size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {/*
        Activity/permission card is docked to the composer, not parked in the
        scrolling thread — same as the solo `composer-dock`. A permission pause
        blocks the turn, so it must stay on screen no matter where the thread is
        scrolled. It renders even when the composer is hidden (broadcast
        distribution / Supervisor owns input) so the lane's pause is still
        answerable.
      */}
      {(showActivity || !hideComposer) && (
        <div className="lane-composer-dock">
          {showActivity && (
            <div className="composer-activity-shell lane-activity-shell">
              <AgentActivityOverlay
                todos={todoActivity?.todos ?? []}
                isStreaming={todoActivity?.isStreaming ?? live}
                request={agentRequest ?? undefined}
                onRespond={onAgentRequestResponse}
              />
            </div>
          )}
          {!hideComposer && (
            <LaneComposer
              workspacePath={lane.path}
              placeholder={lane.muted ? `resume ${name} before sending` : `message ${name} · use @ to add files`}
              disabled={offline || lane.muted || !!custodyHalt}
              running={live}
              onStop={onRestart}
              onSend={onSend}
            />
          )}
        </div>
      )}
    </div>
  )
}

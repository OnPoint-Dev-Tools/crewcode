import React, { useCallback, useEffect, useState } from 'react'

import { Splitter } from '../chat/Splitter'
import { Icon } from '../ui/Icon'
import { CrewColumns } from './CrewColumns'
import { CrewTimeline } from './CrewTimeline'
import { SupervisorSidebar } from './SupervisorSidebar'
import { buildCrewTranscript, downloadTranscript } from './crew-transcript'
import { crewDistribution } from '../../orchestrator/crew-session'
import type { Message, AgentInfo, PtyPane, AgentUserRequest, AgentUserResponse } from '../../types'
import type { CrewSession, CrewLaneEffort, CrewDistribution } from '../../orchestrator/crew-session'

interface CrewSurfaceProps {
  session:       CrewSession
  agents:        AgentInfo[]
  messagesByTab: Record<string, Message[]>
  ptyPanes:      PtyPane[]
  onSendToLane:  (laneId: string, text: string) => void
  onBroadcast:   (text: string) => void
  onClosePane:   (paneId: string) => void
  onEdit:        () => void
  onArchive:     () => void
  onReset:       () => void
  onShowDiff:    () => void
  onShowGit:     () => void
  onSaveTemplate:() => void
  onSetLaneModel:   (laneId: string, model: string) => void
  onSetLaneEffort:  (laneId: string, effort: CrewLaneEffort) => void
  onRestartLane:    (laneId: string) => void
  onToggleLaneMute: (laneId: string) => void
  onAbortAll:       () => void
  onAbortSupervisor: () => void
  onSendToSupervisor: (text: string) => void
  onSetDistribution:  (distribution: CrewDistribution) => void
  userRequestsByTab?: Record<string, AgentUserRequest[]>
  onAgentRequestResponse?: (response: AgentUserResponse) => void
}

const STATE_COPY: Record<CrewSession['state'], string> = {
  configuring:  'configuring',
  provisioning: 'provisioning worktrees…',
  active:       'active',
  archiving:    'archiving…',
  closed:       'archived',
  error:        'error',
}

/**
 * The active-crew home — header plus the simultaneous layout for the session's
 * mode: side-by-side columns (isolated) or one merged timeline (shared). Owns
 * every non-configuring state; the config phase stays in CrewConfigPanel.
 */
export function CrewSurface({
  session, agents, messagesByTab, ptyPanes,
  onSendToLane, onBroadcast, onClosePane, onEdit, onArchive, onReset, onShowDiff, onShowGit, onSaveTemplate,
  onSetLaneModel, onSetLaneEffort, onRestartLane, onToggleLaneMute, onAbortAll, onAbortSupervisor, onSendToSupervisor,
  onSetDistribution,
  userRequestsByTab,
  onAgentRequestResponse,
}: CrewSurfaceProps) {
  const distribution = crewDistribution(session)
  const busy    = session.state === 'provisioning' || session.state === 'archiving'
  const settled = session.state === 'closed' || session.state === 'error'

  // Supervisor sidebar shows whenever the surface is up and not mid-transition,
  // not just in 'active'. Isolated crews can land in 'error'/'closed' (e.g. a
  // worktree failed to provision) while still rendering their lane columns; the
  // supervisor owns no worktree (it runs in basePath), so it must stay available
  // there too — gating on 'active' alone hid it for any non-active isolated crew.
  // collapsing falls back to a thin rail without unmounting the thread.
  const [supervisorCollapsed, setSupervisorCollapsed] = useState(false)
  const [supervisorWidth, setSupervisorWidth] = useState(340)
  const [stopNotice, setStopNotice] = useState<string | null>(null)
  const showSupervisor = session.supervisor.enabled && !busy
  const supervisorTabId = session.supervisor.tabId ?? `crew/${session.id}/supervisor`
  const supervisorRequest = (userRequestsByTab?.[supervisorTabId] ?? [])[0] ?? null
  // When the Supervisor is enabled it owns the crew's input — the user talks to
  // it, not to individual lanes — so hide every per-lane / broadcast composer.
  const supervisorOwnsInput = session.supervisor.enabled

  const agentName = (id: string) => agents.find(a => a.id === id)?.name ?? id

  const exportTranscript = useCallback(() => {
    const md = buildCrewTranscript({ session, agentName, messagesByTab })
    const ts = new Date(session.createdAt).toISOString().slice(0, 16).replace(/[T:]/g, '-')
    downloadTranscript(md, `crew-${session.mode}-${ts}.md`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, messagesByTab, agents])

  const onSupervisorDrag = useCallback((delta: number) => {
    setSupervisorWidth(width => Math.max(280, Math.min(560, width - delta)))
  }, [])

  const handleAbortAll = useCallback(() => {
    const targets = session.lanes.filter(l => l.bridgeId || l.paneId).length + (session.supervisor.bridgeId ? 1 : 0)
    onAbortAll()
    // Abort delivery is provider-specific; confirm the local stop signal so the
    // user is not left guessing whether the stop-all click was accepted.
    setStopNotice(targets > 0
      ? `stop signal sent to ${targets} runtime${targets === 1 ? '' : 's'}`
      : 'stop signal sent; no active runtimes found')
  }, [session, onAbortAll])

  useEffect(() => {
    if (!stopNotice) return undefined
    const id = window.setTimeout(() => setStopNotice(null), 4500)
    return () => window.clearTimeout(id)
  }, [stopNotice])

  return (
    <div className="crew-surface">
      <header className="crew-surface-head">
        <div className="crew-surface-title">
          <span className="crew-surface-icon"><Icon name="crew" size={14} /></span>
          <span className="crew-surface-name">Crew Workers</span>
          <span className={`crew-mode-tag mode-${session.mode}`}>
            {session.mode === 'isolated' ? 'multiple workspaces' : 'single workspace'}
          </span>
        </div>
        <div className="crew-surface-state" data-state={session.state}>
          <span className="crew-state-dot" />
          {STATE_COPY[session.state]}
        </div>
        <div className="crew-surface-actions">
          {session.state === 'active' && (
            <>
              <button
                type="button"
                className={`crew-btn-ghost crew-dist-toggle is-${distribution}`}
                onClick={() => onSetDistribution(distribution === 'split' ? 'broadcast' : 'split')}
                aria-pressed={distribution === 'split'}
                title={distribution === 'split'
                  ? 'Split: each worker gets a different task. Click to broadcast the same task to all.'
                  : 'Broadcast: every worker gets the same task. Click to split work per worker.'}
              >
                <Icon name={distribution === 'split' ? 'gitBranch' : 'megaphone'} size={12} />
                {distribution === 'split' ? 'split work' : 'broadcast'}
              </button>
              <button type="button" className="crew-btn-ghost crew-btn-stop" onClick={handleAbortAll} title="abort every running agent and stop the supervisor loop">
                <Icon name="square" size={11} /> {stopNotice ? 'stop sent' : 'stop all'}
              </button>
              {session.mode === 'isolated' && (
                <>
                  <button type="button" className="crew-btn-ghost" onClick={onShowDiff}>
                    <Icon name="gitCompare" size={12} /> compare
                  </button>
                  <button type="button" className="crew-btn-ghost" onClick={onShowGit} title="merge lane branches into the base branch">
                    <Icon name="gitMerge" size={12} /> merge
                  </button>
                </>
              )}
              <button type="button" className="crew-btn-ghost" onClick={exportTranscript}>
                <Icon name="fileText" size={12} /> export
              </button>
              <button type="button" className="crew-btn-ghost" onClick={onSaveTemplate} title="save lanes as reusable template">
                <Icon name="tag" size={12} /> save as template
              </button>
              <button type="button" className="crew-btn-ghost" onClick={onEdit}>
                <Icon name="sliders" size={12} /> edit
              </button>
              <button type="button" className="crew-btn-ghost" onClick={onArchive}>
                <Icon name="box" size={12} /> archive crew
              </button>
            </>
          )}
          {settled && (
            <>
              <button type="button" className="crew-btn-ghost" onClick={exportTranscript}>
                <Icon name="fileText" size={12} /> export
              </button>
              <button type="button" className="crew-btn-ghost" onClick={onReset}>dismiss</button>
            </>
          )}
        </div>
      </header>

      {stopNotice && (
        <div className="crew-stop-notice" role="status" aria-live="polite">
          <Icon name="check" size={12} />
          <span>{stopNotice}</span>
        </div>
      )}

      {session.error && (
        <div className="crew-warning crew-surface-error">
          <Icon name="alert" size={12} />
          <span>{session.error}</span>
        </div>
      )}

      <div className={`crew-surface-body ${showSupervisor && !supervisorCollapsed ? 'with-supervisor' : ''}`}>
        {showSupervisor && (
          <>
            <SupervisorSidebar
              session={session}
              agents={agents}
              messagesByTab={messagesByTab}
              onSend={onSendToSupervisor}
              onStop={onAbortSupervisor}
              agentRequest={supervisorRequest}
              onAgentRequestResponse={onAgentRequestResponse}
              collapsed={supervisorCollapsed}
              onToggle={() => setSupervisorCollapsed(c => !c)}
              width={supervisorWidth}
            />
            {!supervisorCollapsed && <Splitter orientation="vertical" onDrag={onSupervisorDrag} />}
          </>
        )}
        <div className="crew-surface-lanes">
        {busy && <div className="lane-empty">{STATE_COPY[session.state]}</div>}
        {!busy && session.mode === 'isolated' && (
          <CrewColumns
            session={session}
            agents={agents}
            messagesByTab={messagesByTab}
            ptyPanes={ptyPanes}
            onSendToLane={onSendToLane}
            onClosePane={onClosePane}
            onSetLaneModel={onSetLaneModel}
            onSetLaneEffort={onSetLaneEffort}
            onRestartLane={onRestartLane}
            onToggleLaneMute={onToggleLaneMute}
            userRequestsByTab={userRequestsByTab}
            onAgentRequestResponse={onAgentRequestResponse}
            hideComposer={supervisorOwnsInput}
          />
        )}
        {!busy && session.mode === 'shared' && (
          <CrewTimeline
            session={session}
            agents={agents}
            messagesByTab={messagesByTab}
            onBroadcast={onBroadcast}
            onSendToLane={onSendToLane}
            onSetLaneModel={onSetLaneModel}
            onSetLaneEffort={onSetLaneEffort}
            onRestartLane={onRestartLane}
            onToggleLaneMute={onToggleLaneMute}
            userRequestsByTab={userRequestsByTab}
            onAgentRequestResponse={onAgentRequestResponse}
            hideComposer={supervisorOwnsInput}
          />
        )}
        </div>
      </div>
    </div>
  )
}

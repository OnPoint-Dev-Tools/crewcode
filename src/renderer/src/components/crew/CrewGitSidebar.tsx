import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { Icon } from '../ui/Icon'
import { useGitSidebar } from '../../hooks/useGitSidebar'
import type { AgentInfo, CrewIntegrationRecord } from '../../types'
import type { CrewSession } from '../../orchestrator/crew-session'
import { analyzeCrewCollisions } from '../../orchestrator/crew-collision-analysis'
import { presentCrewIntegration } from '../../orchestrator/crew-integration-presentation'
import { crewReviewFingerprint } from '../../orchestrator/crew-review-fingerprint'

interface CrewGitSidebarProps {
  open:        boolean
  session:     CrewSession
  agents:      AgentInfo[]
  onClose:     () => void
  /** Delegate a conflict to the host tab's agent (drops a prompt in the composer). */
  onAskAgent?: (text: string) => void
  /** Worktree added/removed (e.g. a lane discarded) — refresh app workspace state. */
  onWorktreesChanged?: () => void
}

interface LaneGit {
  changed:     number   // files changed vs base — what a merge would bring in
  uncommitted: number   // staged + unstaged + untracked — NOT in the merge yet
  loading:     boolean
  error:       string | null
  files:       string[]
  head:        string
}

const EMPTY_LANE: LaneGit = { changed: 0, uncommitted: 0, loading: true, error: null, files: [], head: '' }

/**
 * Dedicated git surface for an isolated crew: one row per lane worktree with a
 * merge-into-base action, plus the merge-in-progress / conflict controls. Reuses
 * useGitSidebar (scoped to the crew's base checkout) for the real merge / remove
 * / conflict plumbing, and fetches each lane's status directly for the per-lane
 * change counts.
 *
 * Merges take the lane branch's committed tip — so uncommitted working-tree
 * changes in a lane are surfaced as a pre-merge warning with a one-click commit,
 * rather than silently left behind.
 */
export function CrewGitSidebar({
  open, session, agents, onClose, onAskAgent, onWorktreesChanged,
}: CrewGitSidebarProps) {
  const git = useGitSidebar({
    repoPath:          session.basePath,
    workspacePath:     session.basePath,
    mainBranch:        session.baseBranch,
    currentWorktreeId: null,
    enabled:           open,
    onSwitchWorktree:  () => { /* crew git surface doesn't switch the active checkout */ },
    onAskAgent,
    onWorktreesChanged,
  })

  const [byLane, setByLane] = useState<Record<string, LaneGit>>({})
  const [tick, setTick]     = useState(0)
  const [baseHead, setBaseHead] = useState('')
  const [integration, setIntegration] = useState<CrewIntegrationRecord | null>(null)
  const [integrationError, setIntegrationError] = useState<string | null>(null)
  const [integrationBusy, setIntegrationBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void Promise.all([
      window.electronAPI?.gitLog(session.basePath, 1),
      window.electronAPI?.gitCrewIntegrationStatus(session.id),
    ]).then(([log, status]) => {
      if (cancelled) return
      setBaseHead(log?.commits?.[0]?.hash ?? '')
      setIntegration(status?.record ?? null)
      setIntegrationError(status?.record ? null : status?.error ?? null)
    })
    return () => { cancelled = true }
  }, [open, session.basePath, session.id, tick])

  const agentName = useCallback(
    (id: string) => agents.find(a => a.id === id)?.name ?? id,
    [agents],
  )

  // Lanes that own a worktree on disk (everything past the pending config phase).
  const lanes = useMemo(
    () => session.lanes.filter(l => l.status !== 'pending' && l.path),
    [session.lanes],
  )

  // Resolve a lane to its registered worktree by branch (ids are derived from the
  // path basename, which can differ from the lane's worktreeId — branch is stable).
  const reviewFingerprint = crewReviewFingerprint(lanes)

  const worktreeForLane = useCallback(
    (branch: string) => git.state.worktrees.find(w => w.branch === branch) ?? null,
    [git.state.worktrees],
  )

  // Pull each lane's working-tree status for the change/uncommitted counts.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setByLane(prev => {
      const next: Record<string, LaneGit> = {}
      for (const lane of lanes) next[lane.laneId] = { ...EMPTY_LANE }
      return next
    })
    lanes.forEach(async lane => {
      // "changed" = files differing from base (committed work counts → what the
      // merge brings). "uncommitted" = working-tree changes not yet committed,
      // which a merge would leave behind — surfaced as the pre-merge warning.
      const [vsBase, status, log] = await Promise.all([
        window.electronAPI?.gitChangesVsRef(lane.path, session.baseBranch),
        window.electronAPI?.gitStatus(lane.path),
        window.electronAPI?.gitLog(lane.path, 1),
      ])
      if (cancelled) return
      if ((!vsBase || vsBase.error) && (!status || status.error)) {
        setByLane(prev => ({ ...prev, [lane.laneId]: { ...EMPTY_LANE, loading: false, error: vsBase?.error ?? status?.error ?? 'no git ipc' } }))
        return
      }
      const changed = vsBase?.files?.length ?? 0
      const uncommitted = status && !status.error
        ? status.staged.length + status.unstaged.length + status.untracked.length
        : 0
      setByLane(prev => ({
        ...prev,
        [lane.laneId]: {
          changed, uncommitted, loading: false, error: null,
          files: (vsBase?.files ?? []).map(file => file.path),
          head: log?.commits?.[0]?.hash ?? '',
        },
      }))
    })
    return () => { cancelled = true }
  // Runtime status/usage updates must not clear loaded lane evidence. Refresh
  // only when Git ownership changes, the operator asks, or the panel reopens.
  }, [open, reviewFingerprint, tick, session.baseBranch])

  const collisionFindings = useMemo(() => analyzeCrewCollisions(lanes.map(lane => ({
    laneId: lane.laneId,
    label: lane.roleName || agentName(lane.agentId),
    files: byLane[lane.laneId]?.files ?? [],
  }))), [lanes, byLane, agentName])

  const refreshAll = useCallback(() => { setTick(t => t + 1); git.refresh() }, [git])

  const verifyCombinedIntegration = useCallback(async () => {
    const candidates = lanes.map(lane => ({
      laneId: lane.laneId, label: lane.roleName || agentName(lane.agentId),
      branch: lane.branch, head: byLane[lane.laneId]?.head ?? '',
      worktreePath: lane.path, files: byLane[lane.laneId]?.files ?? [],
    })).filter(lane => lane.head && (byLane[lane.laneId]?.changed ?? 0) > 0)
    if (!baseHead || !candidates.length) return
    setIntegrationError(null)
    setIntegrationBusy(true)
    try {
      const result = await window.electronAPI?.gitVerifyCrewIntegration({
        sessionId: session.id, repoPath: session.basePath,
        baseBranch: session.baseBranch, baseHead, lanes: candidates,
      })
      setIntegration(result?.record ?? null)
      setIntegrationError(result?.record ? null : result?.error ?? null)
      setTick(value => value + 1)
    } finally { setIntegrationBusy(false) }
  }, [lanes, byLane, baseHead, session.id, session.basePath, session.baseBranch, agentName])

  const applyCombinedIntegration = useCallback(async () => {
    setIntegrationError(null)
    setIntegrationBusy(true)
    try {
      const result = await window.electronAPI?.gitApplyCrewIntegration(session.id)
      setIntegration(result?.record ?? null)
      setIntegrationError(result?.record ? null : result?.error ?? null)
      refreshAll()
    } finally { setIntegrationBusy(false) }
  }, [session.id, refreshAll])

  const discardLane = useCallback((branch: string) => {
    const wt = worktreeForLane(branch)
    if (!wt) return
    git.handlers.onRemoveWorktree?.(wt.id)
    setTimeout(refreshAll, 400)
  }, [worktreeForLane, git.handlers, refreshAll])

  // Stage + commit a lane's uncommitted work so combined verification includes it.
  // The automatic message keeps this one click; agents can amend later.
  const commitLane = useCallback(async (lanePath: string, agentId: string) => {
    await window.electronAPI?.gitStage(lanePath, ['.'])
    let c = await window.electronAPI?.gitCommit(lanePath, `crew: ${agentName(agentId)} lane work`)
    if (c?.error && c.signingFailure) {
      await window.electronAPI?.gitCommit(lanePath, `crew: ${agentName(agentId)} lane work`, false, true)
    }
    refreshAll()
  }, [agentName, refreshAll])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const banner    = git.state.banner
  const conflicts = git.state.conflicts
  const integrationRunning = integrationBusy || integration?.status === 'running'
  const candidateLaneCount = lanes.filter(lane => !!byLane[lane.laneId]?.head && (byLane[lane.laneId]?.changed ?? 0) > 0).length
  const hasCandidateLanes = candidateLaneCount > 0
  const merging   = conflicts.length > 0 || integrationRunning
  const integrationView = presentCrewIntegration(integration)

  return (
    <div className="crew-git-backdrop" onClick={onClose}>
      <aside
        className="crew-git-sidebar"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="crew git"
      >
        <header className="crew-git-head">
          <span className="crew-git-icon"><Icon name="gitMerge" size={14} /></span>
          <div className="crew-git-title">
            <span>merge lanes</span>
            <span className="crew-git-base mono">→ {session.baseBranch}</span>
          </div>
          <div className="crew-git-head-actions">
            <button type="button" className="crew-btn-ghost" onClick={refreshAll}>
              <Icon name="refresh" size={12} /> refresh
            </button>
            <button type="button" className="crew-btn-ghost" onClick={onClose}>close</button>
          </div>
        </header>

        {banner && (
          <div className={`crew-git-banner ${banner.kind ? `is-${banner.kind}` : ''}`}>
            {banner.spinning && <Icon name="refresh" size={12} />}
            <span>{banner.text}</span>
          </div>
        )}

        {conflicts.length > 0 && (
          <section className="crew-git-conflicts">
            <div className="crew-git-section-head">
              <Icon name="alert" size={12} />
              <span>merge in progress · {conflicts.length} conflicted</span>
            </div>
            <ul className="crew-git-conflict-list">
              {conflicts.map(c => (
                <li key={c.path} className="crew-git-conflict">
                  <span className="crew-git-conflict-path mono">{c.path}</span>
                  <div className="crew-git-conflict-actions">
                    <button type="button" className="crew-git-mini" onClick={() => git.handlers.onResolveConflict?.({ file: c.path, strategy: 'ours' })}>ours</button>
                    <button type="button" className="crew-git-mini" onClick={() => git.handlers.onResolveConflict?.({ file: c.path, strategy: 'theirs' })}>theirs</button>
                    {onAskAgent && (
                      <button type="button" className="crew-git-mini" onClick={() => git.handlers.onResolveConflict?.({ file: c.path, strategy: 'agent' })}>agent</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            <div className="crew-git-conflict-foot">
              <button type="button" className="crew-btn-ghost" onClick={() => git.handlers.onAbortMerge?.()}>abort merge</button>
              <button type="button" className="crew-btn-ghost" onClick={() => git.handlers.onContinueMerge?.()}>continue</button>
            </div>
          </section>
        )}

        <section className={`crew-integration-card is-${integrationView.tone}`} aria-live="polite">
          <header className="crew-integration-card-head">
            <div>
              <span className="crew-integration-eyebrow">combined safety gate</span>
              <h3>{integrationView.heading}</h3>
            </div>
            <span className={`crew-integration-badge is-${integrationView.tone}`}>{integrationView.badge}</span>
          </header>

          <p className="crew-integration-summary">{integrationView.summary}</p>
          {integrationView.progress && (
            <div className="crew-integration-progress">
              {integrationRunning && <Icon name="refresh" size={11} />}
              <span>{integrationView.progress}</span>
            </div>
          )}

          {(integration?.error || integrationError) && (
            <div className="crew-integration-error">
              <Icon name="alert" size={12} />
              <div><b>Why this stopped</b><span>{integration?.error ?? integrationError}</span></div>
            </div>
          )}

          <div className="crew-integration-evidence">
            <div className="crew-integration-section-title">Project checks</div>
            {integration?.checks.length ? integration.checks.map(check => (
              <div className="crew-integration-check" key={check.id}>
                <div className="crew-integration-check-head">
                  <b>{check.label}</b>
                  <span className={`crew-integration-check-status is-${check.status}`}>{check.status}</span>
                </div>
                <span className="mono crew-integration-command">{check.command} → {check.script}</span>
                {check.output?.trim() && (
                  <details className="crew-integration-output" open={check.status === 'failed' || check.status === 'interrupted'}>
                    <summary>Check output</summary>
                    <pre>{check.output.trim()}</pre>
                  </details>
                )}
              </div>
            )) : (
              <span className="crew-integration-empty">
                {!integration ? 'Results will appear after verification.'
                  : integration.status === 'passed' ? 'No allowlisted typecheck or test script was discovered; only Git combination was verified.'
                    : integration.phase === 'checking' && integrationRunning ? 'Discovering project checks…'
                      : 'No project check completed.'}
              </span>
            )}
          </div>

          {integration && (
            <details className="crew-integration-inputs">
              <summary>Candidate ownership · {integration.lanes.length} lane{integration.lanes.length === 1 ? '' : 's'}</summary>
              <div className="crew-integration-base mono">base {integration.baseBranch}@{integration.baseHead.slice(0, 10)}</div>
              {integration.lanes.map(lane => (
                <div className="crew-integration-owner" key={lane.laneId}>
                  <b>{lane.label}</b>
                  <span className="mono">{lane.branch}@{lane.head.slice(0, 10)}</span>
                  <span className="mono">{lane.worktreePath}</span>
                  <span className="mono">{lane.files.join(', ') || 'no files recorded'}</span>
                </div>
              ))}
            </details>
          )}

          <div className="crew-integration-next">
            <b>Next step</b>
            <span>{integrationView.nextStep}</span>
          </div>

          <div className="crew-integration-actions">
            <button
              type="button"
              className="crew-btn-ghost"
              disabled={!baseHead || !hasCandidateLanes || merging}
              title={!baseHead ? 'base commit is still loading' : !hasCandidateLanes ? 'no committed lane changes found' : integrationView.nextStep}
              onClick={() => { void verifyCombinedIntegration() }}
            >
              {integrationView.verifyLabel}
            </button>
            <button type="button" className="crew-git-merge" disabled={integration?.status !== 'passed' || merging} onClick={() => { void applyCombinedIntegration() }}>
              apply verified commit → {session.baseBranch}
            </button>
          </div>
        </section>

        {collisionFindings.length > 0 && (
          <section className="crew-git-risk-gate">
            <div><Icon name="alert" size={12} /><b>{collisionFindings.length} behavioral review signal{collisionFindings.length === 1 ? '' : 's'}</b></div>
            <span>These lanes overlap by file or contract even if Git reports a clean merge. Inspect Cross-lane Diff first.</span>
            <ul className="crew-git-conflict-list">
              {collisionFindings.map((finding, index) => (
                <li key={`${finding.laneIds.join('-')}-${index}`} className="crew-git-conflict">
                  <span><b>{finding.laneLabels.join(' ↔ ')}</b> · {finding.reason}</span>
                  <span className="mono">{finding.files.join(', ')}</span>
                </li>
              ))}
            </ul>
            <span>The combined gate above must pass before any lane commit can update the base.</span>
          </section>
        )}

        <div className="crew-git-lanes">
          {lanes.length === 0 && <div className="lane-empty">no lane worktrees yet</div>}
          {lanes.map(lane => {
            const g  = byLane[lane.laneId] ?? EMPTY_LANE
            const wt = worktreeForLane(lane.branch)
            return (
              <div key={lane.laneId} className="crew-git-lane">
                <div className="crew-git-lane-head">
                  <span className="crew-git-lane-agent">{agentName(lane.agentId)}</span>
                  <span className="crew-git-lane-role">{lane.roleName || 'no role'}</span>
                </div>
                <span className="crew-git-lane-branch mono">{lane.branch}</span>

                <div className="crew-git-lane-status">
                  {g.loading && <span className="crew-git-muted">loading…</span>}
                  {g.error   && <span className="crew-git-err"><Icon name="alert" size={11} /> {g.error}</span>}
                  {!g.loading && !g.error && (
                    g.changed === 0
                      ? <span className="crew-git-muted">clean</span>
                      : <span className="crew-git-pill">{g.changed} changed</span>
                  )}
                </div>

                {g.uncommitted > 0 && (
                  <div className="crew-git-warn">
                    <Icon name="alert" size={11} />
                    <span>{g.uncommitted} uncommitted — won't be merged</span>
                    <button
                      type="button"
                      className="crew-git-mini"
                      onClick={() => commitLane(lane.path, lane.agentId)}
                    >
                      commit
                    </button>
                  </div>
                )}

                <div className="crew-git-lane-actions">
                  <button
                    type="button"
                    className="crew-git-merge"
                    disabled
                    title="Crew lane commits are applied only through the durable combined integration above"
                  >
                    <Icon name="gitMerge" size={12} /> {g.changed > 0 ? 'included in combined integration' : 'no committed change'}
                  </button>
                  <button
                    type="button"
                    className="crew-git-discard"
                    disabled={!wt || merging}
                    title="remove this lane's worktree"
                    onClick={() => discardLane(lane.branch)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </aside>
    </div>
  )
}

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { Icon } from '../ui/Icon'
import { useGitSidebar } from '../../hooks/useGitSidebar'
import type { AgentInfo } from '../../types'
import type { CrewSession } from '../../orchestrator/crew-session'

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
}

const EMPTY_LANE: LaneGit = { changed: 0, uncommitted: 0, loading: true, error: null }

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

  const agentName = useCallback(
    (id: string) => agents.find(a => a.id === id)?.name ?? id,
    [agents],
  )

  // Lanes that own a worktree on disk (everything past the pending config phase).
  const lanes = useMemo(
    () => session.lanes.filter(l => l.status !== 'pending' && l.path),
    [session.lanes],
  )

  // The base checkout in the worktree list — merge target for every lane.
  const baseId = useMemo(() => {
    const main = git.state.worktrees.find(w => w.path === session.basePath)
    return main?.id ?? git.state.worktrees[0]?.id ?? null
  }, [git.state.worktrees, session.basePath])

  // Resolve a lane to its registered worktree by branch (ids are derived from the
  // path basename, which can differ from the lane's worktreeId — branch is stable).
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
      const [vsBase, status] = await Promise.all([
        window.electronAPI?.gitChangesVsRef(lane.path, session.baseBranch),
        window.electronAPI?.gitStatus(lane.path),
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
      setByLane(prev => ({ ...prev, [lane.laneId]: { changed, uncommitted, loading: false, error: null } }))
    })
    return () => { cancelled = true }
  }, [open, lanes, tick, session.baseBranch])

  const refreshAll = useCallback(() => { setTick(t => t + 1); git.refresh() }, [git])

  const mergeLane = useCallback((branch: string) => {
    const wt = worktreeForLane(branch)
    if (!wt || !baseId) return
    git.handlers.onMergeWorktree?.({ from: wt.id, into: baseId })
    // Lane statuses don't change on merge, but the base history does — bump both.
    setTimeout(refreshAll, 400)
  }, [worktreeForLane, baseId, git.handlers, refreshAll])

  const discardLane = useCallback((branch: string) => {
    const wt = worktreeForLane(branch)
    if (!wt) return
    git.handlers.onRemoveWorktree?.(wt.id)
    setTimeout(refreshAll, 400)
  }, [worktreeForLane, git.handlers, refreshAll])

  // Pre-merge "hook": stage + commit a lane's uncommitted work so the next merge
  // actually carries it. Auto-message keeps it one click; agents can amend later.
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
  const merging   = conflicts.length > 0

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

        {merging && (
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
                    disabled={!wt || !baseId || merging}
                    title={!wt ? 'worktree not found in git' : merging ? 'finish the current merge first' : `merge ${lane.branch} into ${session.baseBranch}`}
                    onClick={() => mergeLane(lane.branch)}
                  >
                    <Icon name="gitMerge" size={12} /> merge → {session.baseBranch}
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

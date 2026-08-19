import React, { useEffect, useState, useCallback, useMemo } from 'react'

import { Icon } from '../ui/Icon'
import { PierreDiff } from '../diff/PierreDiff'
import { PROVIDER_IMAGES, providerImageClass } from '../composer/provider-meta'
import type { AgentInfo, GitStatusFile } from '../../types'
import type { CrewSession, CrewAgentLane } from '../../orchestrator/crew-session'
import { analyzeCrewCollisions } from '../../orchestrator/crew-collision-analysis'
import { CrewCollisionReview } from './CrewCollisionReview'
import { crewReviewFingerprint } from '../../orchestrator/crew-review-fingerprint'

interface CrewDiffViewProps {
  open:     boolean
  session:  CrewSession
  agents:   AgentInfo[]
  onClose:  () => void
}

interface LaneDiffState {
  /** Files this lane changed vs the base branch — committed work included. */
  files:   GitStatusFile[]
  loading: boolean
  error:   string | null
  /** path → unified diff text, lazily fetched on file click */
  diffs:   Record<string, string>
  /** Current lane tip, so review records who owns the exact change. */
  head:    string
  subject: string
}

const EMPTY: LaneDiffState = { files: [], loading: true, error: null, diffs: {}, head: '', subject: '' }

/**
 * Side-by-side comparison of every lane's worktree status. The point of running
 * a crew is comparing outputs, so this is the home for "what did each lane
 * actually change". Loads on open and refreshes manually — diffs auto-fetch on
 * file click rather than upfront, since a busy crew can produce a lot of patches.
 *
 * Only isolated mode has distinct paths per lane; shared mode is filtered out
 * one level up in CrewSurface.
 */
export function CrewDiffView({ open, session, agents, onClose }: CrewDiffViewProps) {
  const [byLane, setByLane] = useState<Record<string, LaneDiffState>>({})
  const [tick, setTick]     = useState(0)
  const lanes = session.lanes
  const reviewFingerprint = crewReviewFingerprint(lanes)
  const agentName = useCallback(
    (id: string) => agents.find(a => a.id === id)?.name ?? id,
    [agents],
  )

  // Pull each lane's changes *relative to the base branch* every time the dialog
  // opens (or refresh bumps `tick`). This counts committed work too — a lane that
  // committed has a clean working tree but still differs from base, which the old
  // `git status` check missed (it showed "no changes"). Diff bodies are deferred
  // to a per-file lookup below so this stays cheap on big repos.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setByLane(prev => {
      const next: Record<string, LaneDiffState> = {}
      for (const lane of lanes) next[lane.laneId] = { ...EMPTY, diffs: prev[lane.laneId]?.diffs ?? {} }
      return next
    })
    lanes.forEach(async lane => {
      if (!lane.path) {
        setByLane(prev => ({ ...prev, [lane.laneId]: { ...EMPTY, loading: false, error: 'lane has no worktree path' } }))
        return
      }
      const [r, log] = await Promise.all([
        window.electronAPI?.gitChangesVsRef(lane.path, session.baseBranch),
        window.electronAPI?.gitLog(lane.path, 1),
      ])
      if (cancelled) return
      if (!r || r.error) {
        setByLane(prev => ({ ...prev, [lane.laneId]: { ...EMPTY, loading: false, error: r?.error ?? 'no git ipc' } }))
        return
      }
      const tip = log?.commits?.[0]
      setByLane(prev => ({
        ...prev,
        [lane.laneId]: {
          files: r.files ?? [], loading: false, error: null,
          diffs: prev[lane.laneId]?.diffs ?? {},
          head: tip?.hash ?? '', subject: tip?.message ?? '',
        },
      }))
    })
    return () => { cancelled = true }
  // Runtime updates replace session.lanes every second. Depend only on Git
  // ownership inputs so loaded evidence does not flash back to "loading".
  }, [open, reviewFingerprint, tick, session.baseBranch])

  const loadDiff = useCallback(async (lane: CrewAgentLane, file: GitStatusFile) => {
    const key = file.path
    setByLane(prev => {
      const cur = prev[lane.laneId] ?? EMPTY
      if (cur.diffs[key] !== undefined) return prev   // already loaded — toggle handled in JSX
      return { ...prev, [lane.laneId]: { ...cur, diffs: { ...cur.diffs, [key]: '' } } }
    })
    const r = await window.electronAPI?.gitDiffVsRef(lane.path, session.baseBranch, file.path)
    setByLane(prev => {
      const cur = prev[lane.laneId] ?? EMPTY
      return {
        ...prev,
        [lane.laneId]: {
          ...cur,
          diffs: { ...cur.diffs, [key]: r?.diff ?? (r?.error ?? '(no diff)') },
        },
      }
    })
  }, [session.baseBranch])

  const summary = useMemo(() => {
    return lanes.map(lane => {
      const files = byLane[lane.laneId]?.files ?? []
      return { lane, changed: files.length }
    })
  }, [lanes, byLane])

  const collisions = useMemo(() => analyzeCrewCollisions(lanes.map(lane => ({
    laneId: lane.laneId,
    label: lane.roleName || agentName(lane.agentId),
    files: (byLane[lane.laneId]?.files ?? []).map(file => file.path),
  }))), [lanes, byLane, agentName])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="crew-modal-backdrop" onClick={onClose}>
      <div
        className="crew-modal crew-diff-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header className="crew-modal-head">
          <span className="crew-modal-icon"><Icon name="gitCompare" size={14} /></span>
          <h2 className="crew-modal-title">
            Cross-lane Diff
            <span className="crew-diff-base mono">{session.baseBranch}</span>
          </h2>
          <div className="crew-modal-head-actions">
            <button type="button" className="crew-btn-ghost" onClick={() => setTick(t => t + 1)}>
              <Icon name="refresh" size={12} /> refresh
            </button>
            <button type="button" className="crew-btn-ghost" onClick={onClose}>close</button>
          </div>
        </header>

        <div className="crew-diff-collision-slot">
          <CrewCollisionReview
            findings={collisions}
            note="Git can merge cleanly and still break behavior."
            footer="No verification checks are recorded here. Run the repository's typecheck/tests against the combined result before accepting it."
            emptyTitle="No heuristic collisions found"
            emptyNote="These heuristics are narrow — no finding is not a safety claim. Verify the combined result before accepting it."
          />
        </div>

        <div className="crew-diff-summary">
          {summary.map((s, i) => (
            <div
              key={s.lane.laneId}
              className="crew-diff-summary-cell"
              data-active={s.changed > 0}
              style={{ ['--cell-i' as string]: i }}
            >
              <div className="crew-diff-cell-top">
                {PROVIDER_IMAGES[s.lane.agentId] && (
                  <img
                    src={PROVIDER_IMAGES[s.lane.agentId]}
                    alt={s.lane.agentId}
                    className={`crew-diff-provider-icon ${providerImageClass(s.lane.agentId)}`}
                    width={16}
                    height={16}
                  />
                )}
                <span className="crew-diff-cell-count">
                  <strong>{s.changed}</strong>
                  <span>{s.changed === 1 ? 'file' : 'files'}</span>
                </span>
              </div>
              <span className="crew-diff-cell-branch mono">{s.lane.branch}</span>
              <span className="crew-diff-cell-head mono" title={byLane[s.lane.laneId]?.subject || 'commit unavailable'}>
                {byLane[s.lane.laneId]?.head ? byLane[s.lane.laneId].head.slice(0, 10) : 'uncommitted / unknown'} · {s.lane.status === 'running' ? 'executing' : 'not executing'}
              </span>
            </div>
          ))}
        </div>

        <div className="crew-diff-columns">
          {lanes.map(lane => {
            const st = byLane[lane.laneId] ?? EMPTY
            const allFiles: GitStatusFile[] = st.files
            return (
              <div key={lane.laneId} className="crew-diff-col">
                <div className="crew-diff-col-head">
                  {PROVIDER_IMAGES[lane.agentId] && (
                    <img
                      src={PROVIDER_IMAGES[lane.agentId]}
                      alt={lane.agentId}
                      className={`crew-diff-provider-icon ${providerImageClass(lane.agentId)}`}
                      width={16}
                      height={16}
                    />
                  )}
                  <span className="lane-head-agent crew-diff-base">{agentName(lane.agentId)}</span>
                  <span className="lane-head-role">{lane.roleName || 'no role'}</span>
                </div>
                {st.loading && <div className="lane-empty">loading…</div>}
                {st.error   && <div className="crew-warning"><Icon name="alert" size={12} /><span>{st.error}</span></div>}
                {!st.loading && !st.error && allFiles.length === 0 && (
                  <div className="lane-empty">no changes</div>
                )}
                <ul className="crew-diff-files">
                  {allFiles.map(file => {
                    const k = file.path
                    const diff = st.diffs[k]
                    const open = diff !== undefined
                    return (
                      <li key={k} className="crew-diff-file">
                        <button
                          type="button"
                          className="crew-diff-file-row"
                          onClick={() => open
                            ? setByLane(prev => {
                                const cur = prev[lane.laneId] ?? EMPTY
                                const { [k]: _drop, ...rest } = cur.diffs
                                return { ...prev, [lane.laneId]: { ...cur, diffs: rest } }
                              })
                            : loadDiff(lane, file)}
                        >
                          <span className={`crew-diff-st st-${file.status.trim() || '?'}`}>
                            {file.status.trim() || '?'}
                          </span>
                          <span className="crew-diff-file-path mono">{file.path}</span>
                          <Icon name={open ? 'chevDown' : 'chevRight'} size={11} />
                        </button>
                        {open && (
                          diff
                            ? <PierreDiff patch={diff} className="crew-diff-body" />
                            : <div className="crew-diff-body mono">loading…</div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * useCrewSession — drives the crew-session state machine and bridges it to the
 * effectful layers (git worktrees, agent processes).
 *
 * Crews are keyed by their **host chat tab** id, so a workspace can run several
 * crews at once — one per tab. The pure reducer in `orchestrator/crew-session`
 * decides *what* state is legal; this hook performs the *side effects* a
 * transition implies — creating/removing worktrees via the injected
 * `CrewGitDriver`, and releasing running agents before their worktree is torn
 * down (the orphan-prevention the registry exists for).
 */

import { useState, useRef, useMemo, useCallback, useEffect } from 'react'

import {
  createSession,
  crewReducer,
  canProvision,
  isSettled,
  crewRoster,
  type CrewSession,
  type CrewAction,
  type CrewAgentLane,
  type CrewMode,
  type CrewDistribution,
  type CrewRoleAssignment,
  type CrewLaneStatus,
  type CrewLaneEffort,
  type CrewGitDriver,
  type CrewRosterEntry,
  type CrewSupervisorStatus,
} from '../orchestrator/crew-session'

export interface UseCrewSessionOpts {
  /** Effectful git layer — wired by App over the `worktree:*` IPC. */
  git: CrewGitDriver
  /**
   * Stop any agent (bridge or pty pane) attached to a lane before its worktree
   * is removed. Without this an agent can keep writing into a deleted directory.
   */
  onReleaseLane?: (lane: CrewAgentLane) => void
}

/** Runtime facts the UI attaches to a lane once its agent is live. */
export interface CrewLaneBinding {
  status?:   CrewLaneStatus
  tabId?:    string | null
  bridgeId?: string | null
  paneId?:   string | null
}

type CrewResult = { ok: true } | { error: string }

const CREW_SESSIONS_STORAGE = 'crewcode:crewSessions:v1'

/** Restore durable crew ownership after an app crash without pretending that a
 * process from the previous renderer is still alive. Worktrees and commits stay
 * attributable; runtime ids are process-local and are always cleared. */
function loadSessions(): Record<string, CrewSession> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CREW_SESSIONS_STORAGE) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const recovered: Record<string, CrewSession> = {}
    for (const [tabId, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue
      const session = raw as CrewSession
      if (!session.id || !Array.isArray(session.lanes) || !session.basePath || !session.hostTabId) continue
      recovered[tabId] = {
        ...session,
        distribution: session.distribution === 'broadcast' ? 'broadcast' : 'split',
        lanes: session.lanes.map(lane => ({
          ...lane,
          bridgeId: null,
          paneId: null,
          status: lane.status === 'running' ? 'ready' : lane.status,
        })),
        supervisor: {
          ...session.supervisor,
          bridgeId: null,
          status: 'idle',
        },
      }
    }
    return recovered
  } catch {
    return {}
  }
}

export function useCrewSession({ git, onReleaseLane }: UseCrewSessionOpts) {
  // One crew per host tab, keyed by that tab's id — a workspace can run several.
  const [sessions, setSessions] = useState<Record<string, CrewSession>>(loadSessions)

  // Mirrors `sessions` synchronously so async effects (launch/archive) can read
  // the value at the moment they started, not a stale render closure.
  const sessionsRef = useRef<Record<string, CrewSession>>({})
  sessionsRef.current = sessions

  useEffect(() => {
    try { localStorage.setItem(CREW_SESSIONS_STORAGE, JSON.stringify(sessions)) } catch { /* quota/private mode: runtime still works */ }
  }, [sessions])

  const dispatch = useCallback((tabId: string, action: CrewAction) => {
    setSessions(map => {
      const cur = map[tabId]
      if (!cur) return map
      return { ...map, [tabId]: crewReducer(cur, action) }
    })
  }, [])

  // ── Begin / end ──────────────────────────────────────────────────────────

  const begin = useCallback((opts: {
    wsId:        string
    hostTabId:   string
    basePath:    string
    baseBranch:  string
    mode?:       CrewMode
    name?:       string
    worktrees?:  boolean
  }): CrewSession => {
    const existing = sessionsRef.current[opts.hostTabId]
    // A live crew on this tab must be archived before a new one starts, or its
    // worktrees and agents leak. Refuse silently, hand back the live one.
    if (existing && !isSettled(existing)) return existing
    const next = createSession(opts)
    sessionsRef.current = { ...sessionsRef.current, [opts.hostTabId]: next }
    setSessions(map => ({ ...map, [opts.hostTabId]: next }))
    return next
  }, [])

  /** Drop a settled (closed/error) crew so the tab returns to solo chat. */
  const reset = useCallback((tabId: string) => {
    const cur = sessionsRef.current[tabId]
    if (cur && !isSettled(cur)) return
    const { [tabId]: _gone, ...rest } = sessionsRef.current
    sessionsRef.current = rest
    setSessions(rest)
  }, [])

  // ── Config-phase actions ─────────────────────────────────────────────────

  const setName = useCallback(
    (tabId: string, name: string) => dispatch(tabId, { type: 'set_name', name }), [dispatch])

  const setMode = useCallback(
    (tabId: string, mode: CrewMode) => dispatch(tabId, { type: 'set_mode', mode }), [dispatch])

  const setDistribution = useCallback(
    (tabId: string, distribution: CrewDistribution) =>
      dispatch(tabId, { type: 'set_distribution', distribution }), [dispatch])

  const addLane = useCallback(
    (tabId: string, agentId: string, role?: CrewRoleAssignment, model?: string, effort?: CrewLaneEffort) =>
      dispatch(tabId, { type: 'add_lane', agentId, role, model, effort }), [dispatch])

  const removeLane = useCallback(
    (tabId: string, laneId: string) => dispatch(tabId, { type: 'remove_lane', laneId }), [dispatch])

  const setLaneAgent = useCallback(
    (tabId: string, laneId: string, agentId: string) =>
      dispatch(tabId, { type: 'set_lane_agent', laneId, agentId }), [dispatch])

  const setLaneRole = useCallback(
    (tabId: string, laneId: string, role: CrewRoleAssignment) =>
      dispatch(tabId, { type: 'set_lane_role', laneId, role }), [dispatch])

  const setLaneModel = useCallback(
    (tabId: string, laneId: string, model: string) =>
      dispatch(tabId, { type: 'set_lane_model', laneId, model }), [dispatch])

  const setLaneEffort = useCallback(
    (tabId: string, laneId: string, effort: CrewLaneEffort) =>
      dispatch(tabId, { type: 'set_lane_effort', laneId, effort }), [dispatch])

  const toggleLaneMute = useCallback(
    (tabId: string, laneId: string) =>
      dispatch(tabId, { type: 'toggle_lane_mute', laneId }), [dispatch])

  const addLaneUsage = useCallback(
    (tabId: string, laneId: string, delta: { tokensIn?: number; tokensOut?: number; elapsedMs?: number }) =>
      dispatch(tabId, { type: 'lane_usage', laneId, ...delta }), [dispatch])

  /** Stop a lane's running agent and let the next prompt respawn it. */
  const restartLane = useCallback((tabId: string, laneId: string) => {
    const cur = sessionsRef.current[tabId]
    if (!cur) return
    const lane = cur.lanes.find(l => l.laneId === laneId)
    if (!lane) return
    if (onReleaseLane) onReleaseLane(lane)
    dispatch(tabId, { type: 'lane_reset_runtime', laneId })
  }, [dispatch, onReleaseLane])

  // ── Launch: provision worktrees, then activate ───────────────────────────

  const launch = useCallback(async (tabId: string): Promise<CrewResult> => {
    const cur = sessionsRef.current[tabId]
    if (!cur || !canProvision(cur)) return { error: 'session is not ready to launch' }

    dispatch(tabId, { type: 'provision' })

    // Shared mode (and non-git isolated) own no worktrees — `provision` already
    // marked every lane ready. Only isolated + git has worktrees to create.
    if (cur.mode === 'isolated' && cur.worktrees) {
      const errors: string[] = []
      await Promise.all(cur.lanes.map(async (lane) => {
        const r = await git.provisionLane(cur.wsId, lane.branch, cur.baseBranch)
        if ('error' in r) {
          errors.push(`${lane.agentId}: ${r.error}`)
          dispatch(tabId, { type: 'fail', error: r.error, laneId: lane.laneId })
        } else {
          dispatch(tabId, {
            type:       'lane_provisioned',
            laneId:     lane.laneId,
            worktreeId: r.worktreeId,
            path:       r.path,
            branch:     lane.branch,
          })
        }
      }))
      if (errors.length > 0) return { error: errors.join('; ') }
    }

    // No-op inside the reducer if any lane failed (state is already 'error').
    dispatch(tabId, { type: 'activate' })
    return { ok: true }
  }, [dispatch, git])

  // ── Archive: release agents, remove worktrees, close ─────────────────────

  const archive = useCallback(async (tabId: string): Promise<CrewResult> => {
    const cur = sessionsRef.current[tabId]
    if (!cur || cur.state !== 'active') return { error: 'no active session to archive' }

    // Release every agent first — never let an agent outlive its worktree.
    // This runs in both modes: a shared session still has live agents to stop.
    if (onReleaseLane) cur.lanes.forEach(lane => onReleaseLane(lane))

    dispatch(tabId, { type: 'archive' })

    if (cur.mode === 'isolated' && cur.worktrees) {
      const errors: string[] = []
      await Promise.all(cur.lanes.map(async (lane) => {
        if (!lane.worktreeId) {
          // Lane never got a worktree (failed mid-provision) — nothing to remove.
          dispatch(tabId, { type: 'lane_archived', laneId: lane.laneId })
          return
        }
        const r = await git.archiveLane(cur.wsId, lane.worktreeId)
        if ('error' in r) {
          errors.push(`${lane.agentId}: ${r.error}`)
          dispatch(tabId, { type: 'fail', error: r.error, laneId: lane.laneId })
        } else {
          dispatch(tabId, { type: 'lane_archived', laneId: lane.laneId })
        }
      }))
      if (errors.length > 0) return { error: errors.join('; ') }
    }

    dispatch(tabId, { type: 'close' })
    return { ok: true }
  }, [dispatch, git, onReleaseLane])

  /** Abandon a tab's crew: archive it if live, then drop it entirely. */
  const discard = useCallback(async (tabId: string): Promise<void> => {
    const cur = sessionsRef.current[tabId]
    if (!cur) return
    if (cur.state === 'active') {
      await archive(tabId)
    } else if (cur.state === 'provisioning' && onReleaseLane) {
      // Mid-provision teardown is best-effort — release whatever is attached.
      cur.lanes.forEach(lane => onReleaseLane(lane))
    }
    const { [tabId]: _gone, ...rest } = sessionsRef.current
    sessionsRef.current = rest
    setSessions(rest)
  }, [archive, onReleaseLane])

  // ── Runtime binding ──────────────────────────────────────────────────────

  /** Record that a lane's agent is now live in a given tab / bridge / pane. */
  const bindLane = useCallback((tabId: string, laneId: string, binding: CrewLaneBinding) => {
    dispatch(tabId, {
      type:     'lane_status',
      laneId,
      status:   binding.status ?? 'running',
      tabId:    binding.tabId,
      bridgeId: binding.bridgeId,
      paneId:   binding.paneId,
    })
  }, [dispatch])

  // ── Supervisor ─────────────────────────────────────────────────────────────

  const setSupervisorEnabled = useCallback(
    (tabId: string, enabled: boolean) =>
      dispatch(tabId, { type: 'set_supervisor_enabled', enabled }), [dispatch])

  const setSupervisorAgent = useCallback(
    (tabId: string, agentId: string) =>
      dispatch(tabId, { type: 'set_supervisor_agent', agentId }), [dispatch])

  const setSupervisorModel = useCallback(
    (tabId: string, model: string) =>
      dispatch(tabId, { type: 'set_supervisor_model', model }), [dispatch])

  const setSupervisorEffort = useCallback(
    (tabId: string, effort: CrewLaneEffort) =>
      dispatch(tabId, { type: 'set_supervisor_effort', effort }), [dispatch])

  /** Record the supervisor's live tab / bridge / status. */
  const bindSupervisor = useCallback(
    (tabId: string, binding: { tabId?: string | null; bridgeId?: string | null; status?: CrewSupervisorStatus }) =>
      dispatch(tabId, { type: 'bind_supervisor', ...binding }), [dispatch])

  // ── Derived ──────────────────────────────────────────────────────────────

  /** The global registry — every provisioned/running agent across all crews. */
  const roster: CrewRosterEntry[] = useMemo(
    () => Object.values(sessions).flatMap(crewRoster),
    [sessions],
  )

  return {
    sessions,          // Record<hostTabId, CrewSession> — read sessions[tabId] for one crew
    roster,            // global registry: agent → directory + branch
    begin,
    reset,
    setName,
    setMode,
    setDistribution,
    addLane,
    removeLane,
    setLaneAgent,
    setLaneRole,
    setLaneModel,
    setLaneEffort,
    toggleLaneMute,
    addLaneUsage,
    restartLane,
    launch,
    archive,
    discard,
    bindLane,
    setSupervisorEnabled,
    setSupervisorAgent,
    setSupervisorModel,
    setSupervisorEffort,
    bindSupervisor,
  }
}

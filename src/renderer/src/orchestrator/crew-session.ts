/**
 * Crew session orchestration — the state machine behind a multi-agent session.
 *
 * Two modes:
 *   isolated → "Multiple Workspaces": every agent gets its own git worktree +
 *              branch. Independent files, runtimes, and review paths.
 *   shared   → "Single Workspace": every agent runs in the same directory on
 *              the same branch. Agents can edit the same files concurrently.
 *
 * This module is pure — interfaces, a reducer, and selectors. No React, no IPC.
 * The orchestration hook drives it; the git layer fulfils `provision`/`archive`
 * by calling the existing `worktree:*` IPC and reporting back via dispatch.
 * See decision-guide.ts for the task-shape → mode recommendation data.
 */

// ─── Modes ───────────────────────────────────────────────────────────────────

export type CrewMode = 'isolated' | 'shared'

/**
 * How a crew message is distributed to the workers:
 *   split     → each worker gets a DISTINCT sub-task (the default). The
 *               supervisor is told to divide the work; without a supervisor the
 *               shared timeline shows one composer per worker.
 *   broadcast → the same message goes to every worker verbatim (one shared task).
 */
export type CrewDistribution = 'split' | 'broadcast'

// ─── Lifecycle ───────────────────────────────────────────────────────────────

/**
 * Session state machine:
 *
 *   configuring ─provision→ provisioning ─activate→ active ─archive→ archiving
 *        │                       │                    │                 │
 *        └──────────── fail ─────┴──────── fail ──────┴─── fail ─────────┴──→ error
 *                                                                       close
 *                                                                         └──→ closed
 */
export type CrewSessionState =
  | 'configuring'   // user is choosing mode + agents in the config selector
  | 'provisioning'  // worktrees being created (isolated) / dir verified (shared)
  | 'active'        // agents running
  | 'archiving'     // worktrees being torn down / archived
  | 'closed'        // fully cleaned up
  | 'error'         // a transition or a lane failed unrecoverably

/** Per-agent lane status within a session. */
export type CrewLaneStatus =
  | 'pending'       // declared, not yet provisioned
  | 'provisioning'  // worktree being created
  | 'ready'         // workspace exists, no agent attached yet
  | 'running'       // an agent process/bridge is attached and live
  | 'done'          // agent finished / lane archived
  | 'error'

// Roles are no longer a fixed enum — they are user-authored definitions stored
// in crew-roles.ts. A lane denormalizes the chosen definition's three fields
// (name/role/instructions) so the worker preamble can inject them verbatim.

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** Reasoning effort level — matches composer/EffortPicker. `null` = inherit. */
export type CrewLaneEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | null

/** Cumulative agent usage attributed to a lane — drives the cost strip. */
export interface CrewLaneUsage {
  tokensIn:  number
  tokensOut: number
  /** Wall time the lane's agent has been live, in ms. */
  elapsedMs: number
}

/**
 * One agent's slot in a session. In `isolated` mode each lane owns a distinct
 * worktree (`worktreeId`/`path`/`branch`); in `shared` mode every lane points
 * at the same `basePath`/`baseBranch`.
 */
export interface CrewAgentLane {
  laneId:     string
  agentId:    string              // references AgentInfo.id
  model:      string              // '' = provider default; per-lane model id
  effort:     CrewLaneEffort      // null = inherit global; otherwise per-lane override
  /**
   * The custom role adopted by this lane, denormalized from a crew-roles.ts
   * definition so it survives edits/deletes of the source. `roleId` references
   * the definition (null = no role / generic worker); `roleName`, `role`, and
   * `instructions` are the definition's three fields, injected verbatim into the
   * worker's priming preamble on spawn. All '' = a plain worker with nothing to
   * prime. See buildWorkerPreamble.
   */
  roleId:     string | null
  roleName:   string              // the definition's name — display label + supervisor target token
  role:       string              // the definition's role descriptor
  instructions: string            // the definition's standing instructions
  status:     CrewLaneStatus
  branch:     string              // shared mode: baseBranch; isolated: derived
  path:       string              // '' until provisioned (isolated only)
  worktreeId: string | null       // null in shared mode or before provisioning
  tabId:      string | null       // chat tab bound to this lane, once active
  bridgeId:   string | null       // running agent bridge, if transport=bridge
  paneId:     string | null       // running pty pane, if transport=pty
  muted:      boolean             // skipped for run fan-out (broadcasts + supervisor)
  usage:      CrewLaneUsage
  error:      string | null
}

/** Supervisor runtime status — drives the sidebar's activity line. */
export type CrewSupervisorStatus = 'idle' | 'thinking' | 'delegating' | 'error'

/**
 * The optional Supervisor layer: a bridge agent that moderates the crew as a
 * group chat. It owns no worktree — it runs in the session's basePath and
 * coordinates by messaging lanes. `enabled` defaults on; opting out returns the
 * crew to plain lane-by-lane operation. See crew-supervisor-protocol.ts.
 */
export interface CrewSupervisor {
  enabled:  boolean
  agentId:  string                // must reference a bridge-transport AgentInfo
  model:    string                // '' = provider default
  effort:   CrewLaneEffort        // null = inherit global
  tabId:    string | null         // synthetic chat thread, bound once active
  bridgeId: string | null         // running supervisor bridge
  status:   CrewSupervisorStatus
}

export interface CrewSession {
  id:         string
  /** User-given display name. Falls back to workspace name in surfaces (e.g. Mission Control). */
  name:       string
  mode:       CrewMode
  /** How crew messages are split across workers. Defaults to 'split'. */
  distribution: CrewDistribution
  state:      CrewSessionState
  wsId:       string              // owning Workspace.id
  hostTabId:  string              // the chat tab the crew is anchored to
  basePath:   string              // workspace root on disk
  baseBranch: string              // branch crew work forks from
  /**
   * Whether the workspace supports git worktrees. False for a plain (non-git)
   * folder: isolated lanes then run in-place in `basePath` instead of each
   * getting its own worktree — the crew still works, without isolation on disk.
   */
  worktrees:  boolean
  lanes:      CrewAgentLane[]
  supervisor: CrewSupervisor
  error:      string | null
  createdAt:  number
}

/** No hard cap on lanes — a session can spawn as many crew agents/worktrees as the user wants. */
export const MAX_LANES = Infinity

// ─── Actions ─────────────────────────────────────────────────────────────────

/** The denormalized role fields a lane carries — copied from a crew-roles.ts definition. */
export interface CrewRoleAssignment {
  roleId:       string | null
  roleName:     string
  role:         string
  instructions: string
}

/** A lane with no role adopted — a plain generic worker. */
export const NO_ROLE: CrewRoleAssignment = { roleId: null, roleName: '', role: '', instructions: '' }

export type CrewAction =
  | { type: 'set_name';         name: string }
  | { type: 'set_mode';         mode: CrewMode }
  | { type: 'set_distribution'; distribution: CrewDistribution }
  | { type: 'add_lane';         agentId: string; role?: CrewRoleAssignment; model?: string; effort?: CrewLaneEffort }
  | { type: 'remove_lane';      laneId: string }
  | { type: 'set_lane_agent';   laneId: string; agentId: string }
  | { type: 'set_lane_role';    laneId: string; role: CrewRoleAssignment }
  | { type: 'set_lane_model';   laneId: string; model: string }
  | { type: 'set_lane_effort';  laneId: string; effort: CrewLaneEffort }
  | { type: 'toggle_lane_mute'; laneId: string }
  | { type: 'lane_usage';       laneId: string; tokensIn?: number; tokensOut?: number; elapsedMs?: number }
  | { type: 'lane_reset_runtime'; laneId: string }
  | { type: 'provision' }
  | { type: 'lane_provisioned'; laneId: string; worktreeId: string; path: string; branch: string }
  | { type: 'activate' }
  | { type: 'lane_status';      laneId: string; status: CrewLaneStatus
                                tabId?: string | null; bridgeId?: string | null; paneId?: string | null }
  | { type: 'archive' }
  | { type: 'lane_archived';    laneId: string }
  | { type: 'close' }
  | { type: 'fail';             error: string; laneId?: string }
  | { type: 'set_supervisor_enabled'; enabled: boolean }
  | { type: 'set_supervisor_agent';   agentId: string }
  | { type: 'set_supervisor_model';   model: string }
  | { type: 'set_supervisor_effort';  effort: CrewLaneEffort }
  | { type: 'bind_supervisor';        tabId?: string | null; bridgeId?: string | null; status?: CrewSupervisorStatus }

// ─── Construction ────────────────────────────────────────────────────────────

let seq = 0

function newId(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`
}

/** Branch a lane works on — shared lanes reuse baseBranch; isolated lanes fork. */
function deriveLaneBranch(session: CrewSession, agentId: string, index: number): string {
  if (session.mode === 'shared') return session.baseBranch
  const tag = session.id.split('-').pop() ?? 'crew'
  return `crew/${tag}/${agentId}-${index + 1}`
}

/** Default supervisor agent — the first bridge agent; overridable in config. */
export const DEFAULT_SUPERVISOR_AGENT = 'pi'

export function createSession(opts: {
  wsId:           string
  hostTabId:      string
  basePath:       string
  baseBranch:     string
  mode?:          CrewMode
  name?:          string
  supervisorAgent?: string
  /** Defaults true; pass false for a non-git workspace so isolated runs in-place. */
  worktrees?:     boolean
}): CrewSession {
  return {
    id:         newId('crew'),
    name:       opts.name ?? '',
    mode:       opts.mode ?? 'isolated',
    distribution: 'split',   // divide work by default; broadcast is opt-in
    state:      'configuring',
    wsId:       opts.wsId,
    hostTabId:  opts.hostTabId,
    basePath:   opts.basePath,
    baseBranch: opts.baseBranch,
    worktrees:  opts.worktrees ?? true,
    lanes:      [],
    // Supervisor on by default — opting out is a config toggle.
    supervisor: {
      enabled:  true,
      agentId:  opts.supervisorAgent ?? DEFAULT_SUPERVISOR_AGENT,
      model:    '',
      effort:   null,
      tabId:    null,
      bridgeId: null,
      status:   'idle',
    },
    error:      null,
    createdAt:  Date.now(),
  }
}

// ─── Transition helpers ──────────────────────────────────────────────────────
// Each guards its own legal source state and returns the session unchanged when
// the transition is illegal — the machine never throws on a bad action.

function patchLane(
  session: CrewSession,
  laneId:  string,
  patch:   Partial<CrewAgentLane>,
): CrewSession {
  return {
    ...session,
    lanes: session.lanes.map(l => l.laneId === laneId ? { ...l, ...patch } : l),
  }
}

function withMode(session: CrewSession, mode: CrewMode): CrewSession {
  if (session.state !== 'configuring' || session.mode === mode) return session
  const next = { ...session, mode }
  // Re-derive every lane's branch/path for the new mode.
  next.lanes = session.lanes.map((lane, i) => ({
    ...lane,
    branch:     deriveLaneBranch(next, lane.agentId, i),
    path:       mode === 'shared' ? session.basePath : '',
    worktreeId: null,
  }))
  return next
}

function addLane(
  session: CrewSession,
  agentId: string,
  role:    CrewRoleAssignment,
  model:   string,
  effort:  CrewLaneEffort,
): CrewSession {
  if (session.state !== 'configuring') return session
  if (session.lanes.length >= MAX_LANES)  return session

  const index = session.lanes.length
  const lane: CrewAgentLane = {
    laneId:     newId('lane'),
    agentId,
    model,
    effort,
    roleId:       role.roleId,
    roleName:     role.roleName,
    role:         role.role,
    instructions: role.instructions,
    status:     'pending',
    branch:     deriveLaneBranch(session, agentId, index),
    path:       session.mode === 'shared' ? session.basePath : '',
    worktreeId: null,
    tabId:      null,
    bridgeId:   null,
    paneId:     null,
    muted:      false,
    usage:      { tokensIn: 0, tokensOut: 0, elapsedMs: 0 },
    error:      null,
  }
  return { ...session, lanes: [...session.lanes, lane] }
}

function provision(session: CrewSession): CrewSession {
  if (session.state !== 'configuring' || session.lanes.length === 0) return session
  // Lanes run in-place (immediately ready on the base workspace) for shared mode
  // OR when the workspace has no git — there are no worktrees to create. Only
  // isolated + git lanes wait for the git layer's `lane_provisioned`.
  const inPlace = session.mode === 'shared' || !session.worktrees
  const lanes = session.lanes.map(lane => inPlace
    ? { ...lane, status: 'ready' as const, path: session.basePath, branch: session.baseBranch }
    : { ...lane, status: 'provisioning' as const })
  return { ...session, state: 'provisioning', lanes }
}

function activate(session: CrewSession): CrewSession {
  if (session.state !== 'provisioning') return session
  if (!session.lanes.every(l => l.status === 'ready')) return session
  return { ...session, state: 'active' }
}

function archive(session: CrewSession): CrewSession {
  if (session.state !== 'active') return session
  // No worktrees to tear down (shared, or non-git isolated) → lanes finish the
  // moment we archive; only isolated + git lanes await `lane_archived`.
  const inPlace = session.mode === 'shared' || !session.worktrees
  const lanes = inPlace
    ? session.lanes.map(l => ({ ...l, status: 'done' as const }))
    : session.lanes
  return { ...session, state: 'archiving', lanes }
}

function close(session: CrewSession): CrewSession {
  if (session.state !== 'archiving') return session
  return {
    ...session,
    state: 'closed',
    lanes: session.lanes.map(l => ({ ...l, status: 'done' as const })),
  }
}

function fail(session: CrewSession, error: string, laneId?: string): CrewSession {
  const lanes = laneId
    ? session.lanes.map(l => l.laneId === laneId ? { ...l, status: 'error' as const, error } : l)
    : session.lanes
  return { ...session, state: 'error', error, lanes }
}

// ─── Reducer ─────────────────────────────────────────────────────────────────

export function crewReducer(session: CrewSession, action: CrewAction): CrewSession {
  switch (action.type) {
    case 'set_name':
      // Name is metadata — editable at any phase, including a live crew.
      return { ...session, name: action.name }

    case 'set_mode':
      return withMode(session, action.mode)

    case 'set_distribution':
      // Distribution is a live setting — editable at any phase, even mid-run,
      // so toggling it in the header takes effect on the next prompt.
      return { ...session, distribution: action.distribution }

    case 'add_lane':
      return addLane(
        session,
        action.agentId,
        action.role   ?? NO_ROLE,
        action.model  ?? '',
        action.effort ?? null,
      )

    case 'remove_lane':
      if (session.state !== 'configuring') return session
      return { ...session, lanes: session.lanes.filter(l => l.laneId !== action.laneId) }

    case 'set_lane_agent': {
      if (session.state !== 'configuring') return session
      const index = session.lanes.findIndex(l => l.laneId === action.laneId)
      if (index < 0) return session
      // Branch derives from the agent in isolated mode — re-derive on swap.
      // Models are provider-specific, so the picked model resets with the agent.
      return patchLane(session, action.laneId, {
        agentId: action.agentId,
        model:   '',
        branch:  deriveLaneBranch(session, action.agentId, index),
      })
    }

    case 'set_lane_role':
      // A role bundles name/role/instructions, all of which prime the worker
      // per-spawn (like model/effort) — editable live on an active crew; the
      // lane respawns on its next prompt.
      if (session.state !== 'configuring' && session.state !== 'active') return session
      return patchLane(session, action.laneId, {
        roleId:       action.role.roleId,
        roleName:     action.role.roleName,
        role:         action.role.role,
        instructions: action.role.instructions,
      })

    case 'set_lane_model':
      // Model is not structural — editable on a launched crew, not just in config.
      if (session.state !== 'configuring' && session.state !== 'active') return session
      return patchLane(session, action.laneId, { model: action.model })

    case 'set_lane_effort':
      // Effort, like model, is per-spawn — editable live; bridge respawns on next prompt.
      if (session.state !== 'configuring' && session.state !== 'active') return session
      return patchLane(session, action.laneId, { effort: action.effort })

    case 'toggle_lane_mute': {
      const lane = session.lanes.find(l => l.laneId === action.laneId)
      if (!lane) return session
      return patchLane(session, action.laneId, { muted: !lane.muted })
    }

    case 'lane_usage': {
      const lane = session.lanes.find(l => l.laneId === action.laneId)
      if (!lane) return session
      const usage: CrewLaneUsage = {
        tokensIn:  lane.usage.tokensIn  + (action.tokensIn  ?? 0),
        tokensOut: lane.usage.tokensOut + (action.tokensOut ?? 0),
        elapsedMs: lane.usage.elapsedMs + (action.elapsedMs ?? 0),
      }
      return patchLane(session, action.laneId, { usage })
    }

    case 'lane_reset_runtime':
      // Drops bridge/pane refs so the next prompt respawns the agent.
      // Lane stays bound to its tab and worktree.
      if (session.state !== 'active') return session
      return patchLane(session, action.laneId, {
        bridgeId: null,
        paneId:   null,
        status:   'ready',
      })

    case 'provision':
      return provision(session)

    case 'lane_provisioned':
      if (session.state !== 'provisioning') return session
      return patchLane(session, action.laneId, {
        status:     'ready',
        worktreeId: action.worktreeId,
        path:       action.path,
        branch:     action.branch,
        error:      null,
      })

    case 'activate':
      return activate(session)

    case 'lane_status': {
      if (session.state !== 'active') return session
      const patch: Partial<CrewAgentLane> = { status: action.status }
      if (action.tabId    !== undefined) patch.tabId    = action.tabId
      if (action.bridgeId !== undefined) patch.bridgeId = action.bridgeId
      if (action.paneId   !== undefined) patch.paneId   = action.paneId
      return patchLane(session, action.laneId, patch)
    }

    case 'archive':
      return archive(session)

    case 'lane_archived':
      if (session.state !== 'archiving') return session
      return patchLane(session, action.laneId, { status: 'done' })

    case 'close':
      return close(session)

    case 'fail':
      return fail(session, action.error, action.laneId)

    case 'set_supervisor_enabled':
      // Structural-ish but cheap to flip at any phase; the orchestration layer
      // only spins a bridge up when enabled on an active crew.
      return { ...session, supervisor: { ...session.supervisor, enabled: action.enabled } }

    case 'set_supervisor_agent':
      if (session.state !== 'configuring') return session
      // Agent swap resets the picked model (models are provider-specific).
      return { ...session, supervisor: { ...session.supervisor, agentId: action.agentId, model: '' } }

    case 'set_supervisor_model':
      if (session.state !== 'configuring' && session.state !== 'active') return session
      return { ...session, supervisor: { ...session.supervisor, model: action.model } }

    case 'set_supervisor_effort':
      if (session.state !== 'configuring' && session.state !== 'active') return session
      return { ...session, supervisor: { ...session.supervisor, effort: action.effort } }

    case 'bind_supervisor': {
      const patch: Partial<CrewSupervisor> = {}
      if (action.tabId    !== undefined) patch.tabId    = action.tabId
      if (action.bridgeId !== undefined) patch.bridgeId = action.bridgeId
      if (action.status   !== undefined) patch.status   = action.status
      return { ...session, supervisor: { ...session.supervisor, ...patch } }
    }

    default: {
      // Exhaustiveness guard — a new action type will fail the build here.
      const _never: never = action
      return _never
    }
  }
}

// ─── Selectors ───────────────────────────────────────────────────────────────

export function canProvision(session: CrewSession): boolean {
  return session.state === 'configuring' && session.lanes.length > 0
}

export function canActivate(session: CrewSession): boolean {
  return session.state === 'provisioning' && session.lanes.every(l => l.status === 'ready')
}

export function isSettled(session: CrewSession): boolean {
  return session.state === 'closed' || session.state === 'error'
}

/** Distribution with a safe default for sessions hydrated before the field existed. */
export function crewDistribution(session: CrewSession): CrewDistribution {
  return session.distribution ?? 'split'
}

/**
 * Surfaces the tradeoffs of the chosen mode so the UI can warn before launch.
 * The headline shared-mode risk: concurrent agents editing the same files.
 */
export function crewWarnings(session: CrewSession): string[] {
  const warnings: string[] = []
  if (session.mode === 'shared' && session.lanes.length > 1) {
    warnings.push(
      `${session.lanes.length} agents share "${session.baseBranch}" — ` +
      `concurrent edits to the same file can overwrite each other.`,
    )
  }
  if (session.mode === 'isolated' && session.lanes.length > 1) {
    warnings.push(
      `${session.lanes.length} isolated worktrees will be created — ` +
      `each branch must be merged or discarded separately.`,
    )
  }
  return warnings
}

// ─── Git driver contract ─────────────────────────────────────────────────────

/**
 * The effectful boundary the orchestration hook depends on. App wires a real
 * implementation over the existing `worktree:*` IPC; tests pass a fake. Keeping
 * this an interface is what lets the hook stay unit-testable without Electron.
 */
export interface CrewGitDriver {
  /** Create an isolated worktree for a lane on `branch`, forked from `fromRef`. */
  provisionLane: (wsId: string, branch: string, fromRef: string) =>
    Promise<{ worktreeId: string; path: string } | { error: string }>
  /** Remove a lane's worktree once the session is archived. */
  archiveLane: (wsId: string, worktreeId: string) =>
    Promise<{ ok: true } | { error: string }>
}

// ─── Registry view ───────────────────────────────────────────────────────────

export interface CrewRosterEntry {
  laneId:  string
  agentId: string
  role:    string              // the lane's role name (display label)
  status:  CrewLaneStatus
  branch:  string
  path:    string
  tabId:   string | null
  muted:   boolean
  usage:   CrewLaneUsage
}

/**
 * The live registry: which agents are provisioned or running, and the exact
 * directory + branch each one occupies. Lanes still pending in config are
 * excluded — they own nothing on disk yet.
 */
export function crewRoster(session: CrewSession): CrewRosterEntry[] {
  return session.lanes
    .filter(lane => lane.status !== 'pending')
    .map(lane => ({
      laneId:  lane.laneId,
      agentId: lane.agentId,
      role:    lane.roleName,
      status:  lane.status,
      branch:  lane.branch,
      path:    lane.path,
      tabId:   lane.tabId,
      muted:   lane.muted,
      usage:   lane.usage,
    }))
}

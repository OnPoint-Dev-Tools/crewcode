/**
 * useMissionData — derives Mission Control state from live CrewCode sources:
 *
 *   workspaces  → projects
 *   crew lanes  → MCAgents (multi-agent sessions)
 *   chat sessions (persisted to localStorage) → MCAgents (solo chats)
 *   message threads → derived status (running/idle/blocked) + lastLine
 *   recent activity → feed events
 *
 * Pure derivation — no IPC, no side effects. Re-runs whenever any input changes.
 */
import { useMemo } from 'react'
import type {
  AgentInfo, AgentUserRequest, Message, Session, Workspace, ModeLevel, ToolCallMessage,
} from '../../types'
import type { CrewSession } from '../../orchestrator/crew-session'
import type {
  MCAgent, MCProject, FeedEvent, FeedKind, AgentKind, AgentMode, AgentStatus,
  BlockingQuestion,
} from './missionTypes'

// ─── helpers ────────────────────────────────────────────────────────────────

function classifyAgentKind(agentId: string): AgentKind {
  return agentId === 'claude' ? 'claude' : 'codex'
}

function modeToLabel(mode: ModeLevel | undefined): AgentMode {
  switch (mode) {
    case 'ask':   return 'Ask'
    case 'plan':  return 'Plan'
    case 'full':  return 'Full'
    default:      return 'Build'
  }
}

function truncate(s: string, n = 120): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

function relativeTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 5)   return 'just now'
  if (seconds < 60)  return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)  return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24)    return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function parseTimestamp(time: string): number | null {
  // Messages store wall-clock strings like "3:42 PM". Parse against today's
  // date so deltas work for the current session.
  const m = time.match(/^(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  const ampm = m[3]?.toUpperCase()
  if (ampm === 'PM' && h < 12) h += 12
  if (ampm === 'AM' && h === 12) h = 0
  const d = new Date()
  d.setHours(h, min, 0, 0)
  // Time-only strings have no date, so a time later than "now" must be from a
  // previous day — roll it back so it never reads as a future "just now".
  if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1)
  return d.getTime()
}

/** Pull a short status line from the most recent message in the thread. */
function lastLineFromMessages(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    switch (msg.kind) {
      case 'user':
        return `> ${truncate(msg.text, 90)}`
      case 'agent':
        if (msg.text) return truncate(msg.text.replace(/\s+/g, ' ').trim(), 90)
        return 'agent reply'
      case 'thinking':
        return msg.text ? `thinking: ${truncate(msg.text, 80)}` : 'thinking…'
      case 'toolcall':
        return `${msg.toolName}${msg.status === 'running' ? ' · running' : ''}`
      case 'worklog':
        return msg.command
      case 'system':
        return truncate(msg.text, 90)
    }
  }
  return 'Idle — no activity yet'
}

// Tool names that should trigger a destructive (red) confirmation flow.
// Pattern matches the tool name or a string arg; conservative — false negatives
// are fine, false positives would scare the user.
const DESTRUCTIVE_TOOL_PATTERNS: RegExp[] = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bdestroy\b/i,
  /\brm\s+-rf?\b/i,
  /push\s+--force/i,
  /reset\s+--hard/i,
  /\bdrop\s+(table|database)/i,
]

function isDestructive(tool: ToolCallMessage): boolean {
  if (DESTRUCTIVE_TOOL_PATTERNS.some(re => re.test(tool.toolName))) return true
  const args = typeof tool.args === 'string' ? tool.args : JSON.stringify(tool.args ?? '')
  return DESTRUCTIVE_TOOL_PATTERNS.some(re => re.test(args))
}

function summarizeToolCall(tool: ToolCallMessage): string {
  if (tool.title) return tool.title
  const args = tool.args
  if (typeof args === 'string') return `${tool.toolName} · ${truncate(args, 120)}`
  if (args && typeof args === 'object') {
    const command = (args as Record<string, unknown>).command
      ?? (args as Record<string, unknown>).cmd
      ?? (args as Record<string, unknown>).path
    if (typeof command === 'string') return `${tool.toolName} · ${truncate(command, 120)}`
  }
  return `${tool.toolName} — approve this tool call?`
}

/** Find the most recent toolcall awaiting user confirmation, if any. */
function pendingApproval(messages: Message[]): ToolCallMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === 'toolcall' && m.status === 'pending') return m
  }
  return null
}

function blockingFromTool(tool: ToolCallMessage): BlockingQuestion {
  const dest = isDestructive(tool)
  return {
    kind:        'approval',
    text:        summarizeToolCall(tool),
    choices:     dest ? ['approve', 'deny', 'always allow'] : ['approve', 'deny'],
    destructive: dest,
  }
}

/** Derive a status for a solo chat session from runtime state, not token churn. */
function deriveSoloStatus(messages: Message[], runtimeRunning?: boolean): AgentStatus {
  if (messages.length === 0) return runtimeRunning ? 'running' : 'idle'
  if (pendingApproval(messages)) return 'blocked'
  if (runtimeRunning !== undefined) return runtimeRunning ? 'running' : 'idle'
  const last = messages[messages.length - 1]
  if (last.kind === 'agent' && last.streaming) return 'running'
  if (last.kind === 'thinking' && last.streaming) return 'running'
  if (last.kind === 'toolcall' && last.status === 'running') return 'running'
  return 'idle'
}

/** Map crew lane status to Mission Control status. */
function mapLaneStatus(laneStatus: string): AgentStatus {
  switch (laneStatus) {
    case 'running': return 'running'
    case 'done':    return 'done'
    case 'error':   return 'blocked'
    default:        return 'idle'
  }
}

function timeOfLatestMessage(messages: Message[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = (messages[i] as { time?: string }).time
    if (t) {
      const parsed = parseTimestamp(t)
      if (parsed !== null) return parsed
    }
  }
  return null
}

// ─── inputs ─────────────────────────────────────────────────────────────────

interface SoloSessionsInput {
  /** Persisted sessionsByTab from useChatSessions / localStorage. */
  sessionsByTab: Record<string, Session[]>
  /** Workspaces the user has loaded; sessions tabIds start with `${wsId}-`. */
  workspaces:    Workspace[]
}

export interface UseMissionDataOpts {
  workspaces:    Workspace[]
  crewSessions:  Record<string, CrewSession>      // keyed by host tab id
  chatSessions:  Record<string, Session[]>        // keyed by tab id
  messagesByTab: Record<string, Message[]>
  /** Real last-activity epoch (ms) per scope id, from transcript file mtimes.
   *  Authoritative for "N ago" — messages carry only a dateless time string. */
  scopeMtimes?:  Record<string, number>
  agents:        AgentInfo[]
  /**
   * Live interactive provider pauses, keyed by the same tab key as messages
   * (solo: session id, crew lane: lane tabId). Lets MC/menulet answer requests.
   */
  userRequestsByTab?: Record<string, AgentUserRequest[]>
  /** Runtime liveness for bridge-backed sessions. Used to keep Control Center
   *  live only during an active turn, not every transcript append. */
  isBridgeRunning?: (sessionId: string, agentId: string) => boolean
}

export interface MissionData {
  projects: MCProject[]
  agents:   MCAgent[]
  feed:     FeedEvent[]
}

// ─── derivation ─────────────────────────────────────────────────────────────

function projectsFromWorkspaces(workspaces: Workspace[]): MCProject[] {
  return workspaces.map(w => ({ id: w.id, name: w.name, path: w.path }))
}

function workspaceForTabId(tabId: string, workspaces: Workspace[]): Workspace | undefined {
  // Tab ids are `${wsId}-...`. Match by the longest workspace id prefix to
  // tolerate ws ids that share a prefix.
  let best: Workspace | undefined
  for (const w of workspaces) {
    if (tabId === w.id || tabId.startsWith(`${w.id}-`)) {
      if (!best || w.id.length > best.id.length) best = w
    }
  }
  return best
}

function soloMCAgents({ sessionsByTab, workspaces }: SoloSessionsInput,
                       messagesByTab: Record<string, Message[]>,
                       scopeMtimes:   Record<string, number>,
                       agents:        AgentInfo[],
                       requestsByKey: Record<string, AgentUserRequest[]>,
                       isBridgeRunning?: (sessionId: string, agentId: string) => boolean): MCAgent[] {
  const out: MCAgent[] = []
  for (const [tabId, sessions] of Object.entries(sessionsByTab)) {
    const ws = workspaceForTabId(tabId, workspaces)
    if (!ws) continue
    for (const session of sessions) {
      // Archived chats are parked, not live agents — keep them out of Mission Control.
      if (session.archived) continue
      const messages = messagesByTab[session.id] ?? []
      // Skip empty sessions in the default tab — they're virtual placeholders.
      if (messages.length === 0 && sessions.length === 1) continue
      // Prefer the transcript file's real mtime (has a true date) over the
      // message time-of-day string, which parseTimestamp can only pin to "today".
      const lastT  = scopeMtimes[session.id] ?? timeOfLatestMessage(messages)
      const agentInfo = agents.find(a => a.id === session.agentId)
      const tokens = messages.reduce((sum, m) => {
        if (m.kind === 'agent' && m.text) return sum + Math.ceil(m.text.length / 4)
        if (m.kind === 'user') return sum + Math.ceil(m.text.length / 4)
        return sum
      }, 0)
      const tool = pendingApproval(messages)
      // A live request takes precedence: it's actionable and pins the agent to
      // blocked so it surfaces in the menulet/MC blocking lanes.
      const request = requestsByKey[session.id]?.[0]
      const runtimeRunning = isBridgeRunning?.(session.id, session.agentId)
      const status = request ? 'blocked' : deriveSoloStatus(messages, runtimeRunning)
      out.push({
        id:       `solo:${session.id}`,
        name:     session.label === 'Session 1' ? ws.name : `${ws.name} · ${session.label}`,
        agent:    classifyAgentKind(session.agentId),
        model:    session.model || agentInfo?.name || session.agentId,
        mode:     modeToLabel(session.mode),
        projectId: ws.id,
        branch:    ws.branch ?? 'main',
        worktree:  ws.branch ? `wt-${ws.branch}` : 'wt-main',
        status,
        lastActivity: lastT !== null ? relativeTime(Date.now() - lastT) : 'idle',
        lastActivityMs: lastT ?? 0,
        tokens,
        cost:     0,
        blocking: tool ? blockingFromTool(tool) : undefined,
        request,
        lastLine: lastLineFromMessages(messages),
        progress: null,
      })
    }
  }
  return out
}

function crewMCAgents(crewSessions: Record<string, CrewSession>,
                      workspaces:   Workspace[],
                      messagesByTab: Record<string, Message[]>,
                      scopeMtimes:   Record<string, number>,
                      requestsByKey: Record<string, AgentUserRequest[]>): MCAgent[] {
  const out: MCAgent[] = []
  for (const cs of Object.values(crewSessions)) {
    const ws = workspaces.find(w => w.id === cs.wsId)
    const projectId = ws?.id ?? cs.wsId
    const projectFallbackBranch = ws?.branch ?? cs.baseBranch
    for (const lane of cs.lanes) {
      // Crew lane tabIds are `crew/<laneId>`; messages live under that key.
      const messages = lane.tabId ? messagesByTab[lane.tabId] ?? [] : []
      const tool   = pendingApproval(messages)
      const request = lane.tabId ? requestsByKey[lane.tabId]?.[0] : undefined
      const baseStatus = mapLaneStatus(lane.status)
      const status: AgentStatus = (tool || request) ? 'blocked' : baseStatus
      const tokens = lane.usage.tokensIn + lane.usage.tokensOut
      const lastT  = (lane.tabId ? scopeMtimes[lane.tabId] : undefined) ?? timeOfLatestMessage(messages)
      const wtBranch = lane.branch || projectFallbackBranch || 'main'
      const crewName = cs.name?.trim() || ws?.name || 'crew'
      out.push({
        id:        `crew:${lane.laneId}`,
        name:      `${crewName} · ${lane.roleName || 'no role'}`,
        agent:     classifyAgentKind(lane.agentId),
        model:     lane.model || lane.agentId,
        mode:      modeToLabel(undefined),
        projectId,
        branch:    wtBranch,
        worktree:  lane.worktreeId ?? (cs.mode === 'shared' ? 'shared' : `wt-${wtBranch}`),
        status,
        lastActivity:
          status === 'running' ? 'live'
          : lastT !== null     ? relativeTime(Date.now() - lastT)
          : relativeTime(Date.now() - cs.createdAt),
        lastActivityMs: lastT ?? cs.createdAt,
        tokens,
        cost:      0,
        blocking:  tool ? blockingFromTool(tool) : undefined,
        request,
        lastLine:  messages.length > 0 ? lastLineFromMessages(messages)
                                       : `${lane.status} on ${wtBranch}`,
        progress:  null,
      })
    }
  }
  return out
}

function feedFromState(mcAgents: MCAgent[],
                       crewSessions: Record<string, CrewSession>): FeedEvent[] {
  const events: FeedEvent[] = []
  let n = 0

  // Running agents → "live" rows so the feed isn't empty in normal use.
  for (const a of mcAgents) {
    if (a.status === 'running') {
      events.push({
        id:        `f-run-${++n}`,
        kind:      'cmd',
        time:      a.lastActivity,
        projectId: a.projectId,
        agentId:   a.id,
        text:      `${a.name} — ${a.lastLine}`,
      })
    }
  }

  // Done / blocked agents.
  for (const a of mcAgents) {
    if (a.status === 'done') {
      events.push({
        id:        `f-done-${++n}`,
        kind:      'done',
        time:      a.lastActivity,
        projectId: a.projectId,
        agentId:   a.id,
        text:      `${a.name} finished — awaiting review.`,
      })
    } else if (a.status === 'blocked') {
      events.push({
        id:        `f-block-${++n}`,
        kind:      'block',
        time:      a.lastActivity,
        projectId: a.projectId,
        agentId:   a.id,
        text:      `${a.name} hit a blocker — needs attention.`,
      })
    }
  }

  // Worktree creation events from crew sessions.
  for (const cs of Object.values(crewSessions)) {
    for (const lane of cs.lanes) {
      if (!lane.worktreeId) continue
      const kind: FeedKind = 'worktree'
      events.push({
        id:        `f-wt-${++n}`,
        kind,
        time:      relativeTime(Date.now() - cs.createdAt),
        projectId: cs.wsId,
        agentId:   null,
        text:      `Crew worktree \`${lane.branch}\` provisioned for ${lane.agentId}.`,
      })
    }
  }

  return events
}

export function useMissionData(opts: UseMissionDataOpts): MissionData {
  const { workspaces, crewSessions, chatSessions, messagesByTab, scopeMtimes, agents, userRequestsByTab, isBridgeRunning } = opts

  return useMemo<MissionData>(() => {
    const requestsByKey = userRequestsByTab ?? {}
    const mtimes = scopeMtimes ?? {}
    const projects = projectsFromWorkspaces(workspaces)
    const solo  = soloMCAgents({ sessionsByTab: chatSessions, workspaces }, messagesByTab, mtimes, agents, requestsByKey, isBridgeRunning)
    const crew  = crewMCAgents(crewSessions, workspaces, messagesByTab, mtimes, requestsByKey)
    const allAgents = [...crew, ...solo]
    const feed  = feedFromState(allAgents, crewSessions)
    return { projects, agents: allAgents, feed }
  }, [workspaces, crewSessions, chatSessions, messagesByTab, scopeMtimes, agents, userRequestsByTab, isBridgeRunning])
}

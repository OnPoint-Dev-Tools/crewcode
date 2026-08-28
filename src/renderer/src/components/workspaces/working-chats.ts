import type { AgentActivityState } from '../ui/AgentActivityIndicator'
import type { WorkingChatEntry } from './WorkspacesDrawer'

interface RunningWorkspace {
  id: string
  name: string
}

interface RunningSession {
  id: string
  tabId: string
  label: string
  agentId: string
}

/** Merge live running scopes onto the drawer's per-session activity. A Grok
 *  (or other ACP) turn that acknowledged prompt() before turn_end must still
 *  appear as working here, even if App last rendered before the registry map
 *  committed. */
export function liveSessionAgentStatus(
  sessionAgentStatus: Record<string, AgentActivityState | undefined>,
  sessionsByWorkspace: Record<string, RunningSession[]>,
  runningByScope: Record<string, boolean>,
): Record<string, AgentActivityState | undefined> {
  let changed = false
  const next: Record<string, AgentActivityState | undefined> = { ...sessionAgentStatus }
  for (const sessions of Object.values(sessionsByWorkspace)) {
    for (const session of sessions) {
      if (!runningByScope[session.id]) continue
      if (next[session.id] === 'working') continue
      next[session.id] = 'working'
      changed = true
    }
  }
  return changed ? next : sessionAgentStatus
}

export function liveWorkingChats(
  workspaces: RunningWorkspace[],
  sessionsByWorkspace: Record<string, RunningSession[]>,
  runningByScope: Record<string, boolean>,
  fallback: WorkingChatEntry[],
): WorkingChatEntry[] {
  const entries: WorkingChatEntry[] = []
  for (const workspace of workspaces) {
    for (const session of sessionsByWorkspace[workspace.id] ?? []) {
      if (!runningByScope[session.id]) continue
      entries.push({
        sessionId: session.id,
        tabId: session.tabId,
        wsId: workspace.id,
        label: session.label,
        wsName: workspace.name,
        agentId: session.agentId,
      })
    }
  }
  if (entries.length === 0) return fallback
  return entries.slice(0, 6)
}

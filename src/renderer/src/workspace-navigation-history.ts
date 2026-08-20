export interface WorkspaceVisit {
  wsId: string
  tabId: string
  sessionId?: string
}

export interface WorkspaceNavigationHistory {
  entries: WorkspaceVisit[]
  index: number
}

export const EMPTY_WORKSPACE_NAVIGATION_HISTORY: WorkspaceNavigationHistory = {
  entries: [],
  index: -1,
}

/**
 * Record a tab visit inside one workspace. Changing chat sessions within the
 * same tab updates that tab's destination; changing tabs creates a history step.
 */
export function recordTabVisit(
  history: WorkspaceNavigationHistory,
  visit: WorkspaceVisit,
): WorkspaceNavigationHistory {
  if (!visit.wsId || !visit.tabId) return history

  const current = history.entries[history.index]
  if (current?.tabId === visit.tabId) {
    if (current.sessionId === visit.sessionId) return history
    const entries = history.entries.slice()
    entries[history.index] = visit
    return { entries, index: history.index }
  }

  const entries = [...history.entries.slice(0, history.index + 1), visit]
  return { entries, index: entries.length - 1 }
}

/** Move backward or forward through existing tabs in one workspace. */
export function moveInTabHistory(
  history: WorkspaceNavigationHistory,
  delta: -1 | 1,
  validTabIds: ReadonlySet<string>,
): { history: WorkspaceNavigationHistory; visit: WorkspaceVisit | null } {
  for (let index = history.index + delta; index >= 0 && index < history.entries.length; index += delta) {
    const visit = history.entries[index]
    if (validTabIds.has(visit.tabId)) {
      return { history: { entries: history.entries, index }, visit }
    }
  }
  return { history, visit: null }
}

/**
 * Record the currently visible workspace destination. Moving between tabs or
 * chat sessions updates the current workspace entry; only changing workspaces
 * creates a new back/forward history entry.
 */
export function recordWorkspaceVisit(
  history: WorkspaceNavigationHistory,
  visit: WorkspaceVisit,
): WorkspaceNavigationHistory {
  if (!visit.wsId || !visit.tabId) return history

  const current = history.entries[history.index]
  if (current?.wsId === visit.wsId) {
    if (current.tabId === visit.tabId && current.sessionId === visit.sessionId) return history
    const entries = history.entries.slice()
    entries[history.index] = visit
    return { entries, index: history.index }
  }

  const entries = [...history.entries.slice(0, history.index + 1), visit]
  return { entries, index: entries.length - 1 }
}

/** Move backward or forward, skipping workspaces that no longer exist. */
export function moveInWorkspaceHistory(
  history: WorkspaceNavigationHistory,
  delta: -1 | 1,
  validWorkspaceIds: ReadonlySet<string>,
): { history: WorkspaceNavigationHistory; visit: WorkspaceVisit | null } {
  for (let index = history.index + delta; index >= 0 && index < history.entries.length; index += delta) {
    const visit = history.entries[index]
    if (validWorkspaceIds.has(visit.wsId)) {
      return { history: { entries: history.entries, index }, visit }
    }
  }
  return { history, visit: null }
}

// Which tab ids are allowed to own chat sessions.
//
// Chat sessions are keyed by tab id, and the workspace they belong to is
// recovered from that id's prefix. Surfaces that embed a real `ChatPane` must be
// listed here or their sessions look like orphans to the reconciliation prune in
// `App.tsx` (deleted on the next render) and never appear in the workspaces
// drawer. Workbench panes deliberately mint ids under the `-chat` namespace, so
// they need no entry; Writer Workspace tabs carry their own `-writer` id.
export const CHAT_SESSION_TAB_SEGMENTS = ['chat', 'writer'] as const

export function isChatSessionTabId(tabId: string, workspaceId: string): boolean {
  for (const segment of CHAT_SESSION_TAB_SEGMENTS) {
    const canonical = `${workspaceId}-${segment}`
    if (tabId === canonical || tabId.startsWith(`${canonical}-`)) return true
  }
  return false
}

// Which surface a chat session belongs to, for UI that lists sessions from every
// tab side by side (the drawer) and must not make a Writer thread look like a
// plain chat. Derived from the id alone because those lists are workspace-blind
// at the row level; a workspace id ending in `-writer` would false-positive, which
// is acceptable for a label.
export function chatSessionSurface(tabId: string): 'writer' | 'chat' {
  return /-writer(-|$)/.test(tabId) ? 'writer' : 'chat'
}

// Longest workspace id wins: workspace ids can be prefixes of one another, and
// the more specific one is the real owner.
export function chatSessionOwnerWorkspaceId(tabId: string, workspaceIds: readonly string[]): string | null {
  let owner: string | null = null
  for (const workspaceId of workspaceIds) {
    if (!isChatSessionTabId(tabId, workspaceId)) continue
    if (!owner || workspaceId.length > owner.length) owner = workspaceId
  }
  return owner
}

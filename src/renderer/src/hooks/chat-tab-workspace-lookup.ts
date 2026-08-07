// Resolves which workspace owns a chat tab, and a session id back to its tab.
//
// Extracted because the matching rule is subtle and repeated: chat tab ids are
// `<wsId>-chat`, and session ids are either the tab id itself (the first session
// reuses it) or `<tabId>::sN`. Getting either wrong sends the user to the wrong
// workspace, or to a tab that doesn't exist.

export interface WorkspaceRef { id: string }

/** Tab that hosts a session. The first session in a tab reuses the tab's id. */
export function tabIdForSessionId(sessionId: string): string {
  return sessionId.includes('::') ? sessionId.split('::')[0] : sessionId
}

/**
 * Workspace owning a chat tab, or undefined when none matches.
 *
 * Matches `<wsId>` exactly or the `<wsId>-` prefix. Prefers the **longest**
 * matching id: with workspaces `a` and `a-b`, the tab `a-b-chat` belongs to
 * `a-b`, but a plain prefix scan would hand it to `a`.
 */
export function workspaceForChatTab<T extends WorkspaceRef>(tabId: string, workspaces: T[]): T | undefined {
  let best: T | undefined
  for (const workspace of workspaces) {
    if (tabId !== workspace.id && !tabId.startsWith(`${workspace.id}-`)) continue
    if (!best || workspace.id.length > best.id.length) best = workspace
  }
  return best
}

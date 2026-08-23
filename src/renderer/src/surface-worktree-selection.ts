import type { TabKind, Worktree } from './types'

/**
 * Chat threads own branch/worktree selection independently. Other surfaces,
 * including Git Workspace tabs, own selection by tab instance.
 */
export function worktreeSelectionKey(
  tabId: string,
  tabKind: TabKind | undefined,
  chatSessionId?: string | null,
): string {
  if (!tabId) return ''
  return tabKind === 'chat' && chatSessionId
    ? `chat:${chatSessionId}`
    : `tab:${tabId}`
}

/** Missing/stale selections intentionally fall back to the primary checkout. */
export function resolveSelectedWorktree(
  selectedId: string | null | undefined,
  worktrees: readonly Worktree[],
): Worktree | null {
  if (!selectedId) return null
  return worktrees.find(worktree => worktree.id === selectedId) ?? null
}

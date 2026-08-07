export const COMPLETED_CHAT_LIFETIME_MS = 60 * 60 * 1000

/** Completed is a transient shortcut; the underlying chat remains untouched. */
export function isCompletedChatShortcutVisible(completedAt: number, now: number): boolean {
  return now - completedAt < COMPLETED_CHAT_LIFETIME_MS
}

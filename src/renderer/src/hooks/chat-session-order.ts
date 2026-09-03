import type { Session } from '../types'

/** Timestamp encoded in `nextTabId` (`${ws}-${kind}-${Date.now().toString(36)}-${n}`).
 * Canonical `${ws}-chat` tabs have no stamp and sort as the oldest. */
export function chatTabCreatedAt(tabId: string): number {
  const match = tabId.match(/-([0-9a-z]+)-(\d+)$/i)
  if (!match) return 0
  const stamp = Number.parseInt(match[1]!, 36)
  return Number.isFinite(stamp) && stamp >= 1_000_000_000_000 ? stamp : 0
}

export function sessionCreatedOrdinal(sessionId: string, tabId: string): number {
  if (sessionId === tabId) return 1
  const match = sessionId.match(/::s(\d+)$/)
  const ordinal = match ? Number(match[1]) : Number.NaN
  return Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : Number.MAX_SAFE_INTEGER
}

/** Newest extra chat tabs first, matching desktop's reverse of oldest-first storage. */
export function sortOwnSessionsForDrawer(sessions: Session[]): Session[] {
  return [...sessions].sort((left, right) => {
    const byTab = chatTabCreatedAt(right.tabId) - chatTabCreatedAt(left.tabId)
    if (byTab !== 0) return byTab
    const byOrdinal = sessionCreatedOrdinal(right.id, right.tabId) - sessionCreatedOrdinal(left.id, left.tabId)
    if (byOrdinal !== 0) return byOrdinal
    const leftAt = left.createdAt ?? left.lastUsedAt ?? 0
    const rightAt = right.createdAt ?? right.lastUsedAt ?? 0
    return rightAt - leftAt
  })
}

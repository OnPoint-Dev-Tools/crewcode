import type { Tab } from '../../types'

export const SESSION_DRAG_MIME = 'application/x-crewcode-session'

export interface SessionDragPayload {
  sessionId: string
  tabId: string
}

export interface SplitGroupLike {
  id: string
  primary: string
  tabs: string[]
}

export type SessionSplitPlan =
  | { type: 'noop' }
  | { type: 'reuse'; tabId: string }
  | { type: 'viewport' }

export function encodeSessionDrag(payload: SessionDragPayload): string {
  return JSON.stringify({ sessionId: payload.sessionId, tabId: payload.tabId })
}

export function decodeSessionDrag(raw: string): SessionDragPayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const sessionId = (parsed as { sessionId?: unknown }).sessionId
    const tabId = (parsed as { tabId?: unknown }).tabId
    if (typeof sessionId !== 'string' || !sessionId) return null
    if (typeof tabId !== 'string' || !tabId) return null
    return { sessionId, tabId }
  } catch {
    return null
  }
}

export function isSessionDrag(types: ArrayLike<string> | Iterable<string> | null | undefined): boolean {
  if (!types) return false
  const withContains = types as { contains?: (type: string) => boolean; includes?: (type: string) => boolean }
  if (typeof withContains.contains === 'function') return withContains.contains(SESSION_DRAG_MIME)
  if (typeof withContains.includes === 'function') return withContains.includes(SESSION_DRAG_MIME)
  return Array.from(types as Iterable<string>).includes(SESSION_DRAG_MIME)
}

export function readSessionDrag(dataTransfer: DataTransfer | null): SessionDragPayload | null {
  if (!dataTransfer || !isSessionDrag(dataTransfer.types)) return null
  return decodeSessionDrag(dataTransfer.getData(SESSION_DRAG_MIME))
}

export function isSessionViewTab(tab: Pick<Tab, 'sessionOwnerTabId' | 'pinnedSessionId'>): boolean {
  return !!tab.sessionOwnerTabId && !!tab.pinnedSessionId
}

export function tabDisplaysSession(
  tab: Tab,
  sessionId: string,
  ownerTabId: string,
  ownerActiveSessionId: string | null,
): boolean {
  if (tab.pinnedSessionId === sessionId && (tab.sessionOwnerTabId ?? tab.id) === ownerTabId) return true
  if (tab.id === ownerTabId && !tab.pinnedSessionId && ownerActiveSessionId === sessionId) return true
  return false
}

function tabInOtherSplit(
  tabId: string,
  visibleIds: readonly string[],
  splitGroups: readonly SplitGroupLike[],
): boolean {
  return splitGroups.some(group => group.tabs.includes(tabId) && !visibleIds.includes(tabId))
}

export function planSessionSplit(args: {
  sessionId: string
  ownerTabId: string
  anchorTabId: string
  tabs: Tab[]
  splitGroups: readonly SplitGroupLike[]
  ownerActiveSessionId: string | null
}): SessionSplitPlan {
  const { sessionId, ownerTabId, anchorTabId, tabs, splitGroups, ownerActiveSessionId } = args
  const tabsById = new Map(tabs.map(tab => [tab.id, tab]))
  const anchor = tabsById.get(anchorTabId)
  if (!anchor) return { type: 'noop' }

  const group = splitGroups.find(item => item.tabs.includes(anchorTabId))
  const visibleIds = group ? group.tabs : [anchorTabId]

  for (const id of visibleIds) {
    const tab = tabsById.get(id)
    if (tab && tabDisplaysSession(tab, sessionId, ownerTabId, ownerActiveSessionId)) {
      return { type: 'noop' }
    }
  }

  const existingViews = tabs.filter(tab =>
    tab.pinnedSessionId === sessionId && (tab.sessionOwnerTabId ?? tab.id) === ownerTabId,
  )
  const reusableView = existingViews.find(tab => !tabInOtherSplit(tab.id, visibleIds, splitGroups) && tab.id !== anchorTabId)
  if (reusableView) return { type: 'reuse', tabId: reusableView.id }

  if (visibleIds.includes(ownerTabId) || tabInOtherSplit(ownerTabId, visibleIds, splitGroups)) {
    return { type: 'viewport' }
  }

  if (ownerTabId !== anchorTabId) return { type: 'reuse', tabId: ownerTabId }
  return { type: 'viewport' }
}

export function insertTabAfter(tabs: readonly string[], anchorTabId: string, incomingTabId: string): string[] {
  if (tabs.includes(incomingTabId)) return [...tabs]
  const idx = tabs.indexOf(anchorTabId)
  if (idx === -1) return [...tabs, incomingTabId]
  return [...tabs.slice(0, idx + 1), incomingTabId, ...tabs.slice(idx + 1)]
}

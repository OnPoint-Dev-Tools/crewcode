/**
 * Live agent activity, keyed by bridge (running / status / queued follow-ups)
 * and by tab (pending user requests).
 *
 * This used to be four `useState`s inside `useBridgeRegistry`, which lives in
 * App. Consumers like ChatPane read it off the `bridges` prop *during render*,
 * so their correctness silently depended on that bundle getting a fresh object
 * identity every App render — an accident of the hook returning an object
 * literal, not a design. Anything that stabilized the bundle (a `React.memo`,
 * a `useMemo`) would have frozen Stop buttons, spinners, and permission prompts
 * with no type or test to catch it.
 *
 * Now the state lives here and each surface subscribes to the slice it actually
 * reads. `useBridgeRegistry` still subscribes to `runningByBridge`, because
 * `isBridgeRunning` feeds the workspace drawer and Mission Control; it does NOT
 * subscribe to status/follow-ups, so that churn no longer re-renders the shell.
 */

import { create } from 'zustand'
import type { AgentUserRequest, CustodyHaltPayload } from '../types'

export interface QueuedFollowUp {
  id: string
  text: string
}

// Shared empties so untouched scopes keep a stable reference through selectors.
const EMPTY_FOLLOW_UPS: QueuedFollowUp[] = []
const EMPTY_REQUESTS: AgentUserRequest[] = []

interface BridgeActivityState {
  runningByBridge:   Record<string, boolean>
  statusByBridge:    Record<string, string>
  followUpsByBridge: Record<string, QueuedFollowUp[]>
  userRequestsByTab: Record<string, AgentUserRequest[]>
  // A tripped execution-custody invariant, per tab. Deliberately NOT cleared by
  // bridge teardown: the halt outlives the process that raised it and only a
  // successful reauthorization removes it.
  custodyHaltsByTab: Record<string, CustodyHaltPayload>
}

export const useBridgeActivityStore = create<BridgeActivityState>(() => ({
  runningByBridge:   {},
  statusByBridge:    {},
  followUpsByBridge: {},
  userRequestsByTab: {},
  custodyHaltsByTab: {},
}))

const setState = useBridgeActivityStore.setState
const getState = useBridgeActivityStore.getState

/** Delete `keys` from `map`, returning null when nothing changed (keeps the
 *  store's identity stable so selectors don't fire spuriously). */
function withoutKeys<T>(map: Record<string, T>, keys: Iterable<string>): Record<string, T> | null {
  let changed = false
  const next = { ...map }
  for (const key of keys) {
    if (key in next) {
      delete next[key]
      changed = true
    }
  }
  return changed ? next : null
}

/** Drop every pending request raised by one of `bridgeIds`. */
function requestsWithoutBridges(
  byTab: Record<string, AgentUserRequest[]>,
  bridgeIds: Set<string>,
): Record<string, AgentUserRequest[]> | null {
  let changed = false
  const next: Record<string, AgentUserRequest[]> = {}
  for (const [tabId, requests] of Object.entries(byTab)) {
    const kept = requests.filter((request) => !bridgeIds.has(request.bridgeId))
    if (kept.length !== requests.length) changed = true
    if (kept.length > 0) next[tabId] = kept
  }
  return changed ? next : null
}

/**
 * Imperative actions. Called from `useBridgeRegistry` callbacks and bridge event
 * handlers, i.e. outside React's render phase.
 */
export const bridgeActivity = {
  setRunning(bridgeId: string, running: boolean): void {
    setState((s) => {
      if (running) {
        if (s.runningByBridge[bridgeId]) return s
        return { runningByBridge: { ...s.runningByBridge, [bridgeId]: true } }
      }
      const next = withoutKeys(s.runningByBridge, [bridgeId])
      return next ? { runningByBridge: next } : s
    })
  },

  setStatus(bridgeId: string, message: string | null): void {
    setState((s) => {
      if (message === null) {
        const next = withoutKeys(s.statusByBridge, [bridgeId])
        return next ? { statusByBridge: next } : s
      }
      if (s.statusByBridge[bridgeId] === message) return s
      return { statusByBridge: { ...s.statusByBridge, [bridgeId]: message } }
    })
  },

  addUserRequest(tabId: string, request: AgentUserRequest): void {
    setState((s) => {
      const current = s.userRequestsByTab[tabId] ?? EMPTY_REQUESTS
      if (current.some((item) => item.requestId === request.requestId)) return s
      return { userRequestsByTab: { ...s.userRequestsByTab, [tabId]: [...current, request] } }
    })
  },

  /** Resolve one request on a known tab (bridge `user_request_resolved`). */
  removeUserRequest(tabId: string, requestId: string): void {
    setState((s) => {
      const current = s.userRequestsByTab[tabId] ?? EMPTY_REQUESTS
      const kept = current.filter((item) => item.requestId !== requestId)
      if (kept.length === current.length) return s
      const next = { ...s.userRequestsByTab }
      if (kept.length > 0) next[tabId] = kept
      else delete next[tabId]
      return { userRequestsByTab: next }
    })
  },

  /** Resolve a request whose tab we don't know (the user answered it directly). */
  removeUserRequestById(requestId: string): void {
    setState((s) => {
      let changed = false
      const next: Record<string, AgentUserRequest[]> = {}
      for (const [tabId, requests] of Object.entries(s.userRequestsByTab)) {
        const kept = requests.filter((item) => item.requestId !== requestId)
        if (kept.length !== requests.length) changed = true
        if (kept.length > 0) next[tabId] = kept
      }
      return changed ? { userRequestsByTab: next } : s
    })
  },

  /** A turn ended — any prompt that bridge was blocking on is moot. */
  removeRequestsForBridge(bridgeId: string): void {
    setState((s) => {
      const next = requestsWithoutBridges(s.userRequestsByTab, new Set([bridgeId]))
      return next ? { userRequestsByTab: next } : s
    })
  },

  addFollowUp(bridgeId: string, followUpId: string, text: string): void {
    setState((s) => {
      const current = s.followUpsByBridge[bridgeId] ?? EMPTY_FOLLOW_UPS
      if (current.some((item) => item.id === followUpId)) return s
      return { followUpsByBridge: { ...s.followUpsByBridge, [bridgeId]: [...current, { id: followUpId, text }] } }
    })
  },

  removeFollowUp(bridgeId: string, followUpId: string): void {
    setState((s) => {
      const current = s.followUpsByBridge[bridgeId]
      if (!current) return s
      const kept = current.filter((item) => item.id !== followUpId)
      if (kept.length === current.length) return s
      const next = { ...s.followUpsByBridge }
      if (kept.length > 0) next[bridgeId] = kept
      else delete next[bridgeId]
      return { followUpsByBridge: next }
    })
  },

  /** Forget the bridge-keyed slices for these ids (drop/release/reset/idle-stop).
   *  Deliberately does NOT touch user requests — callers decide, because an
   *  idle-stopped bridge keeps its tab's requests while a dropped one does not. */
  clearBridges(bridgeIds: Iterable<string>): void {
    const ids = [...bridgeIds]
    if (ids.length === 0) return
    setState((s) => {
      const running   = withoutKeys(s.runningByBridge, ids)
      const status    = withoutKeys(s.statusByBridge, ids)
      const followUps = withoutKeys(s.followUpsByBridge, ids)
      if (!running && !status && !followUps) return s
      return {
        ...(running   ? { runningByBridge:   running }   : null),
        ...(status    ? { statusByBridge:    status }    : null),
        ...(followUps ? { followUpsByBridge: followUps } : null),
      }
    })
  },

  /** Drop pending requests raised by any of `bridgeIds` (tab release). */
  dropRequestsForBridges(bridgeIds: Iterable<string>): void {
    const ids = new Set(bridgeIds)
    if (ids.size === 0) return
    setState((s) => {
      const next = requestsWithoutBridges(s.userRequestsByTab, ids)
      return next ? { userRequestsByTab: next } : s
    })
  },

  /** Drop every pending request on a tab (the tab itself is going away). */
  clearTabRequests(tabId: string): void {
    setState((s) => {
      const next = withoutKeys(s.userRequestsByTab, [tabId])
      return next ? { userRequestsByTab: next } : s
    })
  },

  /** Record a tripped custody invariant for a tab. Overwrites any earlier halt:
   *  the newest failed invariant is the one the user has to answer for. */
  setCustodyHalt(tabId: string, halt: CustodyHaltPayload): void {
    setState((s) => ({ custodyHaltsByTab: { ...s.custodyHaltsByTab, [tabId]: halt } }))
  },

  /** Clear after explicit reauthorization. Never called on bridge teardown. */
  clearCustodyHalt(tabId: string): void {
    setState((s) => {
      const next = withoutKeys(s.custodyHaltsByTab, [tabId])
      return next ? { custodyHaltsByTab: next } : s
    })
  },

  /** Clear every halt sharing a custody scope (reauthorization is scope-wide). */
  clearCustodyHaltsForScope(scopeKey: string): void {
    setState((s) => {
      const drop = Object.entries(s.custodyHaltsByTab)
        .filter(([, halt]) => halt.scopeKey === scopeKey)
        .map(([tabId]) => tabId)
      const next = withoutKeys(s.custodyHaltsByTab, drop)
      return next ? { custodyHaltsByTab: next } : s
    })
  },

  /** Non-reactive snapshot for callbacks that must not subscribe. */
  snapshot(): BridgeActivityState {
    return getState()
  },

  /** Test-only. */
  reset(): void {
    setState({ runningByBridge: {}, statusByBridge: {}, followUpsByBridge: {}, userRequestsByTab: {}, custodyHaltsByTab: {} })
  },
}

// ─── Selector hooks ──────────────────────────────────────────────────────────
// Each subscribes to exactly one slice, so a status tick doesn't repaint a pane
// that only cares about follow-ups (and vice versa).

export function useIsBridgeRunning(bridgeId: string | null): boolean {
  return useBridgeActivityStore((s) => (bridgeId ? !!s.runningByBridge[bridgeId] : false))
}

export function useBridgeStatus(bridgeId: string | null): string | null {
  return useBridgeActivityStore((s) => (bridgeId ? s.statusByBridge[bridgeId] ?? null : null))
}

export function useQueuedFollowUps(bridgeId: string | null): QueuedFollowUp[] {
  return useBridgeActivityStore((s) => (bridgeId ? s.followUpsByBridge[bridgeId] ?? EMPTY_FOLLOW_UPS : EMPTY_FOLLOW_UPS))
}

export function useUserRequestsForTab(tabId: string): AgentUserRequest[] {
  return useBridgeActivityStore((s) => s.userRequestsByTab[tabId] ?? EMPTY_REQUESTS)
}

/** Whole-map subscriptions — only for surfaces that genuinely fan out over every
 *  tab/bridge (Mission Control, the workspaces drawer, crew lanes). */
export function useUserRequestsByTab(): Record<string, AgentUserRequest[]> {
  return useBridgeActivityStore((s) => s.userRequestsByTab)
}

export function useRunningByBridge(): Record<string, boolean> {
  return useBridgeActivityStore((s) => s.runningByBridge)
}

export function useCustodyHalt(tabId: string): CustodyHaltPayload | null {
  return useBridgeActivityStore((s) => s.custodyHaltsByTab[tabId] ?? null)
}

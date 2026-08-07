/**
 * Reports from delegated worker threads that finished while their parent chat
 * was idle, held until the parent's next prompt.
 *
 * A module store rather than App state for the usual reason: a worker finishing
 * must not re-render the workspace shell. Only surfaces that read a specific
 * parent's pending count subscribe.
 *
 * Persisted because the whole point is surviving the gap between "worker
 * finished" and "user comes back" — which can include an app restart.
 */

import { create } from 'zustand'
import { MAX_AUTONOMOUS_WAKES, MAX_BUFFERED_REPORTS, type DelegationReport } from '../hooks/delegation-report'

const STORAGE_KEY = 'crewcode:delegationInbox:v1'

type Inbox = Record<string, DelegationReport[]>

function loadInitial(): Inbox {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Inbox = {}
    for (const [parentId, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue
      const reports = list.filter((r): r is DelegationReport =>
        !!r && typeof r === 'object'
        && typeof (r as DelegationReport).threadId === 'string'
        && typeof (r as DelegationReport).reply === 'string')
      if (reports.length > 0) out[parentId] = reports.slice(-MAX_BUFFERED_REPORTS)
    }
    return out
  } catch {
    /* corrupt — start empty rather than blocking every send */
    return {}
  }
}

/** Per-parent coordination for autonomous waking. Not persisted: a restart means
 *  the user is back, so generation and depth both start fresh. */
export interface ParentWakeState {
  /** Bumped on every user message. Threads spawned since share this cohort, so a
   *  fan-out reports as one group rather than N unrelated pings. */
  generation: number
  /** Autonomous rounds spent since the user's last message. Only a wake caused
   *  by threads that a WOKEN turn spawned increments this — a wide fan-out from
   *  a turn the user drove is free however many threads it contains. */
  autonomousDepth: number
  /** True while a turn started by a wake is still running, so threads spawned
   *  during it can be stamped as auto-spawned. */
  inAutonomousTurn: boolean
}

const FRESH_WAKE_STATE: ParentWakeState = { generation: 0, autonomousDepth: 0, inAutonomousTurn: false }

interface DelegationInboxState {
  reportsByParent: Inbox
  wakeByParent: Record<string, ParentWakeState>
  push: (report: DelegationReport) => void
  /** Remove and return one parent's pending reports. Called by the send path, so
   *  it must never throw and must be safe on an unknown parent. */
  take: (parentSessionId: string) => DelegationReport[]
  patchWake: (parentSessionId: string, patch: Partial<ParentWakeState>) => void
  /** Called when the USER sends to this chat — never when a wake does. Opens a
   *  new cohort and refills the autonomous budget. */
  startUserGeneration: (parentSessionId: string) => void
  clear: (parentSessionId: string) => void
}

export const useDelegationInboxStore = create<DelegationInboxState>((set, get) => ({
  reportsByParent: loadInitial(),
  wakeByParent: {},
  push: (report) =>
    set((s) => {
      const prev = s.reportsByParent[report.parentSessionId] ?? []
      // Oldest-first, newest kept: a runaway spawner drops stale reports rather
      // than growing the parent's next prompt without bound.
      const next = [...prev, report].slice(-MAX_BUFFERED_REPORTS)
      return { reportsByParent: { ...s.reportsByParent, [report.parentSessionId]: next } }
    }),
  take: (parentSessionId) => {
    const pending = get().reportsByParent[parentSessionId] ?? []
    if (pending.length === 0) return []
    set((s) => {
      const next = { ...s.reportsByParent }
      delete next[parentSessionId]
      return { reportsByParent: next }
    })
    return pending
  },
  patchWake: (parentSessionId, patch) =>
    set((s) => ({
      wakeByParent: {
        ...s.wakeByParent,
        [parentSessionId]: { ...(s.wakeByParent[parentSessionId] ?? FRESH_WAKE_STATE), ...patch },
      },
    })),
  startUserGeneration: (parentSessionId) =>
    set((s) => {
      const prev = s.wakeByParent[parentSessionId] ?? FRESH_WAKE_STATE
      return {
        wakeByParent: {
          ...s.wakeByParent,
          [parentSessionId]: {
            generation: prev.generation + 1,
            autonomousDepth: 0,
            inAutonomousTurn: false,
          },
        },
      }
    }),
  clear: (parentSessionId) =>
    set((s) => {
      if (!(parentSessionId in s.reportsByParent)) return s
      const next = { ...s.reportsByParent }
      delete next[parentSessionId]
      return { reportsByParent: next }
    }),
}))

// ── Persistence (debounced; flushed on teardown) ─────────────────────────────
let persistTimer: ReturnType<typeof setTimeout> | null = null

function persistNow(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(useDelegationInboxStore.getState().reportsByParent))
  } catch {
    /* quota — the report also lands as a visible row in the parent transcript */
  }
}

useDelegationInboxStore.subscribe((state, prev) => {
  if (state.reportsByParent === prev.reportsByParent) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistNow()
  }, 300)
})

if (typeof window !== 'undefined') {
  const flush = (): void => {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    persistNow()
  }
  window.addEventListener('beforeunload', flush)
  window.addEventListener('pagehide', flush)
}

/** Non-reactive access for the send path and the turn-end listener, neither of
 *  which may subscribe to inbox churn. */
export const delegationInbox = {
  push: (report: DelegationReport): void => useDelegationInboxStore.getState().push(report),
  take: (parentSessionId: string): DelegationReport[] => useDelegationInboxStore.getState().take(parentSessionId),
  clear: (parentSessionId: string): void => useDelegationInboxStore.getState().clear(parentSessionId),
  peek: (parentSessionId: string): DelegationReport[] =>
    useDelegationInboxStore.getState().reportsByParent[parentSessionId] ?? [],

  wakeState: (parentSessionId: string): ParentWakeState =>
    useDelegationInboxStore.getState().wakeByParent[parentSessionId] ?? FRESH_WAKE_STATE,
  /** The cohort every thread spawned right now belongs to. */
  runId: (parentSessionId: string): string =>
    `${parentSessionId}::g${useDelegationInboxStore.getState().wakeByParent[parentSessionId]?.generation ?? 0}`,
  /** Whether a thread spawned right now is being spawned by an autonomous turn —
   *  the recursive case the budget bounds. */
  isAutonomousTurn: (parentSessionId: string): boolean =>
    useDelegationInboxStore.getState().wakeByParent[parentSessionId]?.inAutonomousTurn === true,
  spendAutonomousRound: (parentSessionId: string): void => {
    const state = useDelegationInboxStore.getState()
    const prev = state.wakeByParent[parentSessionId] ?? FRESH_WAKE_STATE
    state.patchWake(parentSessionId, { autonomousDepth: prev.autonomousDepth + 1 })
  },
  setAutonomousTurn: (parentSessionId: string, active: boolean): void =>
    useDelegationInboxStore.getState().patchWake(parentSessionId, { inAutonomousTurn: active }),
  /** A real user message: new cohort, refilled budget. Never called by a wake. */
  startUserGeneration: (parentSessionId: string): void =>
    useDelegationInboxStore.getState().startUserGeneration(parentSessionId),
}

/** Reactive pending count for one parent chat. */
export function usePendingReportCount(parentSessionId: string): number {
  return useDelegationInboxStore((s) => (s.reportsByParent[parentSessionId] ?? []).length)
}

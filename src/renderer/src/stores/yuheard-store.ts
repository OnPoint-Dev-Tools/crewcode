/**
 * YuHeard renderer store.
 *
 * Receives state transitions from the main-process socket server and
 * dispatches a knock sound + optional OS notification on every
 * `complete` transition. The store never plays a sound on `running` —
 * that's the "agent is doing work" signal, not a finished-turn signal.
 *
 * Dedupe: a single `complete` fires per (paneId, dedupe window). The
 * bridge turn-end callback and a direct socket `complete` can race for
 * the same turn; the dedupe catches it.
 *
 * Reads settings at fire-time (not at hook time) so the toggles stay
 * live without a re-mount.
 */

import { create } from 'zustand'
import type { YuHeardState } from '../../../shared/yuheard-types'
import { playNotificationSound } from '../notifications/notification-sounds'
import { getCurrentSettings } from '../hooks/useSettings'

interface YuHeardEntry {
  state: YuHeardState
  message: string | null
  source: string
  at: number
}

export interface YuHeardRendererEvent {
  paneId: string
  state: YuHeardState
  message: string | null
  source: string
  at: number
}

interface YuHeardStoreShape {
  stateByPane: Record<string, YuHeardEntry>
  /** Last time we fired the alert for this pane. Used to dedupe bridge
   *  turn-end + socket complete arriving near-simultaneously. */
  lastNotifiedAt: Record<string, number>
  /** Apply a state event from any source. */
  applyReport: (event: YuHeardRendererEvent) => void
  /** Convenience: fire a synthetic complete (used by bridge turn-end). */
  applyComplete: (paneId: string, message?: string | null, source?: string) => void
  /** Drop a pane's state (called on pane close). */
  clearPane: (paneId: string) => void
}

const NOTIFY_DEBOUNCE_MS = 500

let wired = false
function ensureWired(): void {
  if (wired) return
  if (typeof window === 'undefined') return
  const api = (window as { electronAPI?: { onYuheardState?: (cb: (event: YuHeardRendererEvent) => void) => () => void } }).electronAPI
  if (!api?.onYuheardState) return
  wired = true
  api.onYuheardState((event) => {
    useYuHeardStore.getState().applyReport(event)
  })
}

/** Mount the listener. Idempotent; safe to call from a React effect. */
export function useYuHeardSync(): void {
  ensureWired()
}

export const useYuHeardStore = create<YuHeardStoreShape>((set, get) => ({
  stateByPane: {},
  lastNotifiedAt: {},

  applyReport: (event) => {
    set((s) => ({
      stateByPane: {
        ...s.stateByPane,
        [event.paneId]: {
          state: event.state,
          message: event.message,
          source: event.source,
          at: event.at,
        },
      },
    }))
    if (event.state !== 'complete') return

    // Dedupe: a turn can fire `complete` once from the bridge and once
    // from a Claude hook. The first wins.
    const last = get().lastNotifiedAt[event.paneId] ?? 0
    if (Date.now() - last < NOTIFY_DEBOUNCE_MS) return

    // Read settings live so the toggle works without a re-mount.
    const settings = getCurrentSettings()
    if (!settings.yuheardEnabled) return

    playNotificationSound('knock')

    if (typeof document !== 'undefined' && !document.hasFocus() && settings.nativeNotifications) {
      const entry = get().stateByPane[event.paneId]
      const title = entry?.message ? 'Agent finished' : 'CrewCode'
      const body = entry?.message ?? ''
      const api = (window as { electronAPI?: { notify?: (payload: { title: string; body: string; scopeId?: string; silent?: boolean }) => void } }).electronAPI
      api?.notify?.({
        title,
        body,
        scopeId: `pane:${event.paneId}`,
        silent: true, // we already played knock; OS stays quiet
      })
    }
    set((s) => ({
      lastNotifiedAt: { ...s.lastNotifiedAt, [event.paneId]: Date.now() },
    }))
  },

  applyComplete: (paneId, message = null, source = 'bridge') => {
    get().applyReport({
      paneId,
      state: 'complete',
      message,
      source,
      at: Date.now(),
    })
  },

  clearPane: (paneId) => set((s) => {
    if (!s.stateByPane[paneId] && !s.lastNotifiedAt[paneId]) return s
    const nextState = { ...s.stateByPane }
    const nextLast = { ...s.lastNotifiedAt }
    delete nextState[paneId]
    delete nextLast[paneId]
    return { stateByPane: nextState, lastNotifiedAt: nextLast }
  }),
}))

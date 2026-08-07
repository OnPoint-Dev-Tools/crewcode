/**
 * Terminal "unread output" badges, isolated from the App shell.
 *
 * A pane accrues unread output when its PTY emits data while its tab is NOT the
 * active tab. This used to live in useState inside App.tsx, so every background
 * terminal burst re-rendered the whole shell — and, on the Workbench page, the
 * entire (unmemoized) canvas pane tree along with it. That is the "Workbench
 * lags while a claude/codex agent runs in another tab" bug: claude and codex are
 * PTY agents, so their hidden output was driving full App re-renders at ~1.4Hz.
 *
 * Now the count lives in this store and only components that call
 * `useUnreadByPane` (the workspaces drawer badges) re-render on a background
 * pane's output. App feeds inputs via `useTerminalUnreadSync` without ever
 * subscribing to the counts.
 */

import { useEffect } from 'react'
import { create } from 'zustand'
import type { PtyPane } from '../types'

// Collapse rapid output (same pane, <700ms apart) into a single unread burst so
// a streaming CLI doesn't inflate the badge to triple digits.
const BURST_WINDOW_MS = 700

interface TerminalUnreadState {
  unreadByPane: Record<string, number>
  clearPane: (paneId: string) => void
}

export const useTerminalUnreadStore = create<TerminalUnreadState>((set) => ({
  unreadByPane: {},
  clearPane: (paneId) =>
    set((s) => {
      if (!s.unreadByPane[paneId]) return s
      const next = { ...s.unreadByPane }
      delete next[paneId]
      return { unreadByPane: next }
    }),
}))

// Module-scoped listener inputs, mutated by the sync hook and read by the single
// global pty:data listener. Kept outside React so bumping a badge never forces a
// render of whatever component happens to own the tab/pane state.
let activeTabId = ''
const paneToTab = new Map<string, string>()
const lastBurstAt = new Map<string, number>()
let wired = false

function ensureWired(): void {
  if (wired) return
  wired = true
  // One shared listener for all panes; badge logic filters by tab. (XTermPane
  // uses the routed onPtyDataForPane for its own output — this one needs to see
  // every pane, so it stays on the broadcast channel.)
  window.electronAPI?.onPtyData?.(({ paneId }) => {
    const tabId = paneToTab.get(paneId)
    if (!tabId || tabId === activeTabId) return // on-screen → nothing to flag
    const now = Date.now()
    if (now - (lastBurstAt.get(paneId) ?? 0) < BURST_WINDOW_MS) return
    lastBurstAt.set(paneId, now)
    useTerminalUnreadStore.setState((s) => ({
      unreadByPane: { ...s.unreadByPane, [paneId]: (s.unreadByPane[paneId] ?? 0) + 1 },
    }))
  })
}

/**
 * Feed the badge tracker the current panes + active tab WITHOUT subscribing the
 * caller to unread counts. Only `useUnreadByPane` consumers re-render on output.
 */
export function useTerminalUnreadSync(panes: PtyPane[], activeTab: string): void {
  ensureWired()
  // Idempotent assignments mirror the previous ref-in-render pattern; kept in
  // sync eagerly so the listener always sees the current tab/pane mapping.
  activeTabId = activeTab
  paneToTab.clear()
  for (const p of panes) paneToTab.set(p.paneId, p.tabId)

  // Clear unread for every pane in the active tab whenever the tab changes.
  useEffect(() => {
    useTerminalUnreadStore.setState((s) => {
      let changed = false
      const next = { ...s.unreadByPane }
      for (const p of panes) {
        if (p.tabId === activeTab && next[p.paneId]) {
          delete next[p.paneId]
          changed = true
        }
      }
      return changed ? { unreadByPane: next } : s
    })
  }, [activeTab, panes])

  // Drop counts (and burst timestamps) for panes that no longer exist.
  useEffect(() => {
    const live = new Set(panes.map((p) => p.paneId))
    useTerminalUnreadStore.setState((s) => {
      let changed = false
      const next: Record<string, number> = {}
      for (const [paneId, count] of Object.entries(s.unreadByPane)) {
        if (live.has(paneId)) next[paneId] = count
        else changed = true
      }
      return changed ? { unreadByPane: next } : s
    })
    for (const key of [...lastBurstAt.keys()]) if (!live.has(key)) lastBurstAt.delete(key)
  }, [panes])
}

/** Subscribe to unread counts. Only badge UIs should call this. */
export function useUnreadByPane(): Record<string, number> {
  return useTerminalUnreadStore((s) => s.unreadByPane)
}

/** Stable clear callback; safe to read from App without a badge subscription. */
export function useClearPane(): (paneId: string) => void {
  return useTerminalUnreadStore((s) => s.clearPane)
}

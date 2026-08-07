/**
 * Per-tab chat composer drafts, isolated from the App shell.
 *
 * The composer text used to live in App's `chatUiByTab` state, so every
 * keystroke re-rendered App — and on the Workbench page, every mounted ChatPane
 * along with it. Now typing updates this store and only the pane being typed in
 * (which subscribes to its own draft) re-renders; other panes and the shell stay
 * put.
 *
 * Drafts persist to localStorage (debounced + flushed on teardown) so a pane
 * refresh or tab switch never drops unsent text — matching the existing draft
 * retention guarantee.
 */

import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { create } from 'zustand'

const STORAGE_KEY = 'crewcode:composerDraftByTab:v1'
// The old combined store; drafts are migrated out of it once on first load.
const LEGACY_CHAT_UI_KEY = 'crewcode:chatUiByTab:v1'

function loadInitial(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
    }
    // One-time migration from the legacy `{ composer, threadView }` shape so an
    // upgrade doesn't discard an in-progress draft.
    const legacy = localStorage.getItem(LEGACY_CHAT_UI_KEY)
    if (legacy) {
      const parsed = JSON.parse(legacy) as Record<string, { composer?: unknown }> | null
      const out: Record<string, string> = {}
      for (const [tabId, entry] of Object.entries(parsed ?? {})) {
        if (typeof entry?.composer === 'string' && entry.composer) out[tabId] = entry.composer
      }
      return out
    }
  } catch {
    /* corrupt — start empty */
  }
  return {}
}

interface ComposerDraftState {
  draftByTab: Record<string, string>
  setDraft: (tabId: string, value: string | ((prev: string) => string)) => void
  clearDraft: (tabId: string) => void
}

export const useComposerDraftStore = create<ComposerDraftState>((set) => ({
  draftByTab: loadInitial(),
  setDraft: (tabId, value) =>
    set((s) => {
      const prev = s.draftByTab[tabId] ?? ''
      const next = typeof value === 'function' ? value(prev) : value
      if (next === prev) return s
      return { draftByTab: { ...s.draftByTab, [tabId]: next } }
    }),
  clearDraft: (tabId) =>
    set((s) => {
      if (!(tabId in s.draftByTab)) return s
      const next = { ...s.draftByTab }
      delete next[tabId]
      return { draftByTab: next }
    }),
}))

// ── Persistence (debounced; flushed on teardown) ─────────────────────────────
let persistTimer: ReturnType<typeof setTimeout> | null = null

function persistNow(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(useComposerDraftStore.getState().draftByTab))
  } catch {
    /* quota — drafts are best-effort cache, not source of truth for sent turns */
  }
}

useComposerDraftStore.subscribe((state, prev) => {
  if (state.draftByTab === prev.draftByTab) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistNow()
  }, 500)
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

/** Non-reactive read/write for programmatic injection sites (prompt insert, ask
 *  agent) that must not subscribe to draft changes. */
export function composerDraftActions() {
  return {
    get: (tabId: string): string => useComposerDraftStore.getState().draftByTab[tabId] ?? '',
    set: (tabId: string, value: string | ((prev: string) => string)): void =>
      useComposerDraftStore.getState().setDraft(tabId, value),
  }
}

/**
 * Reactive per-tab draft + a stable setter (useState-compatible). Only
 * components reading THIS tab's draft re-render on its keystrokes.
 */
export function useComposerDraft(tabId: string): [string, Dispatch<SetStateAction<string>>] {
  const value = useComposerDraftStore((s) => s.draftByTab[tabId] ?? '')
  const setValue = useCallback<Dispatch<SetStateAction<string>>>(
    (v) => useComposerDraftStore.getState().setDraft(tabId, v as string | ((prev: string) => string)),
    [tabId],
  )
  return [value, setValue]
}

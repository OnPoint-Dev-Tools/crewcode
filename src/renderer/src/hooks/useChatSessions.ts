/**
 * useChatSessions — owns per-tab chat sessions and their persisted agent state.
 *
 * Each solo chat tab can host multiple sessions. A session carries its own
 * agentId/model/effort so revisiting a session restores the picker selections
 * rather than snapping back to the global default. Message threads in App are
 * keyed by sessionId (the first session in a tab reuses the tabId so existing
 * messagesByTab entries remain valid — no destructive migration).
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

import type { Session, ModeLevel } from '../types'
import { normalizeModeLevel } from '../app-constants'
import type { EffortLevel } from '../components/composer/EffortPicker'

type SessionsByTab = Record<string, Session[]>
type ActiveByTab   = Record<string, string>

const STORAGE_SESSIONS = 'crewcode:sessionsByTab'
const STORAGE_ACTIVE   = 'crewcode:activeSessionByTab'

export interface SessionDefaults {
  agentId: string
  model:   string
  mode:    ModeLevel
  effort:  EffortLevel
}

/** What the delegation API supplies when an agent spawns a thread. */
export interface DelegatedSpawn {
  title: string
  parentSessionId: string
  mode: ModeLevel
  agentId?: string
  model?: string
  /** Write-capable spawns only — read-only children share the parent worktree. */
  worktreePath?: string
  branch?: string
  base?: string
  /** Cohort id, so threads spawned for one request report as one group. */
  runId?: string
  /** True when the parent was in an autonomous (report-started) turn — the
   *  recursive case the wake budget bounds. */
  duringWake?: boolean
}

function newSessionId(tabId: string, n: number): string {
  // First session reuses the tabId so legacy messagesByTab[tabId] entries
  // continue to address its thread without a write-side migration.
  return n === 1 ? tabId : `${tabId}::s${n}`
}

// Archived sessions stay in the list, so plain length-based numbering can
// collide with an existing (archived or live) session id. Walk forward until
// the id is free — reusing an id would alias two threads onto one transcript.
function nextSessionNumber(tabId: string, list: Session[]): number {
  const taken = new Set(list.map(s => s.id))
  let n = list.length + 1
  while (taken.has(newSessionId(tabId, n))) n += 1
  return n
}

function liveSessions(list: Session[]): Session[] {
  return list.filter(s => !s.archived)
}

function freshSession(tabId: string, n: number, d: SessionDefaults, projectName?: string): Session {
  return {
    id:      newSessionId(tabId, n),
    tabId,
    label:   projectName?.trim() || `Session ${n}`,
    agentId: d.agentId,
    model:   d.model,
    mode:    normalizeModeLevel(d.mode),
    effort:  d.effort,
    mcpServerIds: [],
    enabledSkillIds: [],
    modePromptsEnabled: true,
  }
}

const TITLE_STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'can', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'please', 'the', 'this', 'to', 'with'])

export function titleFromFirstMessage(text: string): string {
  const words = text
    .replace(/`{1,3}[^`]*`{1,3}/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .map(w => w.trim().replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .filter(w => !TITLE_STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 4)

  return words.join(' ')
}

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return JSON.parse(raw) as T
  } catch { /* corrupt entry — start fresh */ }
  return fallback
}

function writeJSON(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* quota */ }
}

type PersistedSession = Omit<Session, 'effort' | 'enabledSkillIds'> & {
  effort: Session['effort'] | 'minimal'
  enabledSkillIds?: string[]
}

export function migratePersistedSessions(sessionsByTab: Record<string, PersistedSession[]>): SessionsByTab {
  return Object.fromEntries(Object.entries(sessionsByTab).map(([tabId, sessions]) => [
    tabId,
    sessions.map(({ effort, ...session }): Session => ({
      ...session,
      // Sessions created before provider-native effort used Pi's "minimal" id.
      effort: effort === 'minimal' ? 'low' : effort,
      // Sessions saved before the rename carry mode 'yolo'.
      mode: normalizeModeLevel(session.mode),
      enabledSkillIds: session.enabledSkillIds ?? [],
      modePromptsEnabled: session.modePromptsEnabled ?? true,
    })),
  ]))
}

export function useChatSessions(defaults: SessionDefaults) {
  const [sessionsByTab, setSessionsByTab] = useState<SessionsByTab>(() => migratePersistedSessions(readJSON(STORAGE_SESSIONS, {})))
  const [activeByTab,   setActiveByTab]   = useState<ActiveByTab>(()   => readJSON(STORAGE_ACTIVE,   {}))
  const persistedStateRef = useRef({ sessionsByTab, activeByTab })
  persistedStateRef.current = { sessionsByTab, activeByTab }
  // Mirror of `sessionsByTab` used only to allocate delegated session ids. React
  // state is not readable between synchronous calls, so a burst of spawns in one
  // turn would otherwise all compute the same "next" id.
  const idAllocationRef = useRef<SessionsByTab>(sessionsByTab)
  idAllocationRef.current = sessionsByTab

  useEffect(() => {
    writeJSON(STORAGE_SESSIONS, sessionsByTab)
  }, [sessionsByTab])
  useEffect(() => {
    writeJSON(STORAGE_ACTIVE, activeByTab)
  }, [activeByTab])
  useEffect(() => {
    const flush = () => {
      const latest = persistedStateRef.current
      writeJSON(STORAGE_SESSIONS, latest.sessionsByTab)
      writeJSON(STORAGE_ACTIVE, latest.activeByTab)
    }
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush()
    }
    const canListenToWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
    const canListenToDocument = typeof document !== 'undefined' && typeof document.addEventListener === 'function'
    if (canListenToWindow) {
      window.addEventListener('pagehide', flush)
      window.addEventListener('beforeunload', flush)
    }
    if (canListenToDocument) document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      if (canListenToWindow) {
        window.removeEventListener('pagehide', flush)
        window.removeEventListener('beforeunload', flush)
      }
      if (canListenToDocument) document.removeEventListener('visibilitychange', onVisibilityChange)
      flush()
    }
  }, [])

  // Defaults can change while agent registry loads; read the latest at session
  // creation time without re-creating callbacks on every default change.
  const defaultsRef = useRef(defaults)
  defaultsRef.current = defaults

  // Archived sessions are excluded everywhere except the archive list itself,
  // which reads `sessionsByTab` directly.
  const getSessions = useCallback((tabId: string) => liveSessions(sessionsByTab[tabId] ?? []), [sessionsByTab])
  const getAllSessions = useCallback((tabId: string) => sessionsByTab[tabId] ?? [], [sessionsByTab])

  const getActiveId = useCallback((tabId: string) => {
    const list = liveSessions(sessionsByTab[tabId] ?? [])
    const saved = activeByTab[tabId]
    // Persisted active ids can outlive a removed/renumbered/archived session;
    // fall back to the first live session instead of pointing the UI at an
    // archived or empty thread.
    return (saved && list.some(s => s.id === saved)) ? saved : (list[0]?.id ?? tabId)
  }, [sessionsByTab, activeByTab])

  const getActiveSession = useCallback((tabId: string) => {
    const list = liveSessions(sessionsByTab[tabId] ?? [])
    const saved = activeByTab[tabId]
    const id = (saved && list.some(s => s.id === saved)) ? saved : (list[0]?.id ?? tabId)
    return list.find(s => s.id === id) ?? null
  }, [sessionsByTab, activeByTab])

  const ensureTab = useCallback((tabId: string, projectName?: string) => {
    if (!tabId) return
    setSessionsByTab(prev => {
      const list = prev[tabId] ?? []
      // An all-archived tab is treated as empty: archiving your last chat
      // leaves the tab on a fresh thread rather than an archived one.
      if (liveSessions(list).length) return prev
      const sess = freshSession(tabId, nextSessionNumber(tabId, list), defaultsRef.current, projectName)
      return { ...prev, [tabId]: [...list, sess] }
    })
    setActiveByTab(prev => {
      const current = prev[tabId]
      const existing = liveSessions(sessionsByTab[tabId] ?? [])
      if (current && existing.some(s => s.id === current)) return prev
      return { ...prev, [tabId]: existing[0]?.id ?? tabId }
    })
  }, [sessionsByTab])

  const add = useCallback((tabId: string, projectName?: string): Session | null => {
    if (!tabId) return null
    const list = sessionsByTab[tabId] ?? []
    const n    = nextSessionNumber(tabId, list)
    const sess = freshSession(tabId, n, defaultsRef.current, projectName)
    setSessionsByTab(prev => ({ ...prev, [tabId]: [...(prev[tabId] ?? []), sess] }))
    setActiveByTab(prev => ({ ...prev, [tabId]: sess.id }))
    return sess
  }, [sessionsByTab])

  // Duplicate an existing session in a tab — copies agent/model/mode/effort
  // so the new thread starts in the same configuration. The new session
  // becomes the active one. Returns null when the source session is missing.
  const duplicate = useCallback((tabId: string, sourceId: string): Session | null => {
    if (!tabId) return null
    const list = sessionsByTab[tabId] ?? []
    const src  = list.find(s => s.id === sourceId)
    if (!src) return null
    const n    = nextSessionNumber(tabId, list)
    const copy: Session = {
      ...freshSession(tabId, n, defaultsRef.current),
      agentId: src.agentId,
      model:   src.model,
      mode:    src.mode,
      effort:  src.effort,
      mcpServerIds: [...(src.mcpServerIds ?? [])],
      enabledSkillIds: [...(src.enabledSkillIds ?? [])],
      modePromptsEnabled: src.modePromptsEnabled ?? true,
    }
    setSessionsByTab(prev => ({ ...prev, [tabId]: [...(prev[tabId] ?? []), copy] }))
    setActiveByTab(prev => ({ ...prev, [tabId]: copy.id }))
    return copy
  }, [sessionsByTab])

  /**
   * Create a thread on an agent's behalf. Two things differ from `add`:
   *
   * 1. It does NOT activate the new session. A delegating turn can spawn several
   *    threads while you are reading a different one; stealing focus mid-turn
   *    would yank the view out from under you.
   * 2. Ids are allocated against `idAllocationRef`, not the render-time
   *    `sessionsByTab` closure. A fan-out calls this several times in one tick,
   *    where the closure is still stale — allocating from it would hand two
   *    threads the same id and alias them onto one transcript.
   */
  const addDelegated = useCallback((tabId: string, spawn: DelegatedSpawn): Session | null => {
    if (!tabId) return null
    const list = idAllocationRef.current[tabId] ?? sessionsByTab[tabId] ?? []
    const n    = nextSessionNumber(tabId, list)
    const sess: Session = {
      ...freshSession(tabId, n, defaultsRef.current),
      label:   spawn.title.trim() || `Session ${n}`,
      agentId: spawn.agentId ?? defaultsRef.current.agentId,
      model:   spawn.model ?? defaultsRef.current.model,
      mode:    normalizeModeLevel(spawn.mode),
      origin:  'delegated',
      delegatedBy: spawn.parentSessionId,
      delegatedAt: Date.now(),
      ...(spawn.worktreePath ? { delegatedWorktreePath: spawn.worktreePath } : {}),
      ...(spawn.branch       ? { delegatedBranch: spawn.branch } : {}),
      ...(spawn.base         ? { delegationBase: spawn.base } : {}),
      ...(spawn.runId        ? { delegationRunId: spawn.runId } : {}),
      ...(spawn.duringWake   ? { delegatedDuringWake: true } : {}),
    }
    // Reserve the id synchronously so the next spawn in this same tick sees it.
    idAllocationRef.current = { ...idAllocationRef.current, [tabId]: [...list, sess] }
    setSessionsByTab(prev => ({ ...prev, [tabId]: [...(prev[tabId] ?? []), sess] }))
    return sess
  }, [sessionsByTab])

  const activate = useCallback((tabId: string, sessionId: string) => {
    if (!tabId) return
    setActiveByTab(prev => ({ ...prev, [tabId]: sessionId }))
  }, [])

  const update = useCallback((tabId: string, sessionId: string, patch: Partial<Pick<Session, 'agentId' | 'model' | 'mode' | 'effort' | 'label' | 'mcpServerIds' | 'enabledSkillIds' | 'modePromptsEnabled' | 'delegationEnabled' | 'delegationClosedAt' | 'pinned' | 'externalDirectories'>>) => {
    if (!tabId) return
    setSessionsByTab(prev => {
      const list = prev[tabId] ?? []
      const next = list.map(s => s.id === sessionId ? { ...s, ...patch } : s)
      return { ...prev, [tabId]: next }
    })
  }, [])

  // Tear down all sessions belonging to a tab. Returns the session ids so the
  // caller can purge their message threads + release their bridges.
  const releaseTab = useCallback((tabId: string): string[] => {
    const ids = (sessionsByTab[tabId] ?? []).map(s => s.id)
    setSessionsByTab(prev => { const n = { ...prev }; delete n[tabId]; return n })
    setActiveByTab(prev => { const n = { ...prev }; delete n[tabId]; return n })
    return ids
  }, [sessionsByTab])

  const pruneTabs = useCallback((validTabIds: Set<string>): string[] => {
    const invalid = Object.entries(sessionsByTab).filter(([tabId]) => !validTabIds.has(tabId))
    if (invalid.length === 0) return []
    const removed = invalid.flatMap(([, list]) => list.map(s => s.id))

    setSessionsByTab(prev => {
      let changed = false
      const next: SessionsByTab = {}
      for (const [tabId, list] of Object.entries(prev)) {
        if (validTabIds.has(tabId)) next[tabId] = list
        else changed = true
      }
      return changed ? next : prev
    })
    setActiveByTab(prev => {
      let changed = false
      const next: ActiveByTab = {}
      for (const [tabId, id] of Object.entries(prev)) {
        if (validTabIds.has(tabId)) next[tabId] = id
        else changed = true
      }
      return changed ? next : prev
    })
    return removed
  }, [sessionsByTab])

  // Archive / unarchive a single session. Archiving hides it from every live
  // surface but keeps its record (and its on-disk transcript) intact.
  // Returns the session the tab should activate next, when the archived one
  // was active — null means "nothing left, let ensureTab seed a fresh thread".
  const setArchived = useCallback((tabId: string, sessionId: string, archived: boolean): { changed: boolean; nextActive: string | null } => {
    if (!tabId) return { changed: false, nextActive: null }
    const list = sessionsByTab[tabId] ?? []
    const target = list.find(s => s.id === sessionId)
    if (!target || !!target.archived === archived) return { changed: false, nextActive: null }

    // Archiving starts the retention clock; unarchiving clears it so a later
    // re-archive gets a full window rather than inheriting the old timestamp.
    const applyFlag = (s: Session): Session => s.id === sessionId
      ? { ...s, archived, archivedAt: archived ? Date.now() : undefined }
      : s
    const next = list.map(applyFlag)
    setSessionsByTab(prev => ({ ...prev, [tabId]: (prev[tabId] ?? []).map(applyFlag) }))

    if (archived) {
      const nextActive = activeByTab[tabId] === sessionId
        ? (liveSessions(next)[0]?.id ?? null)
        : (activeByTab[tabId] ?? null)
      if (nextActive) setActiveByTab(prev => ({ ...prev, [tabId]: nextActive }))
      return { changed: true, nextActive }
    }
    // Unarchiving focuses the restored session — the user just asked for it.
    setActiveByTab(prev => ({ ...prev, [tabId]: sessionId }))
    return { changed: true, nextActive: sessionId }
  }, [sessionsByTab, activeByTab])

  // Stamp `archivedAt` on sessions archived before that field existed. Their
  // real archive date is unknowable, so they start their retention clock now:
  // enabling a 30-day policy must never instantly expire old history.
  const backfillArchivedAt = useCallback(() => {
    setSessionsByTab(prev => {
      let changed = false
      const next: SessionsByTab = {}
      for (const [tabId, list] of Object.entries(prev)) {
        next[tabId] = list.map(s => {
          if (!s.archived || typeof s.archivedAt === 'number') return s
          changed = true
          return { ...s, archivedAt: Date.now() }
        })
      }
      return changed ? next : prev
    })
  }, [])

  // Remove a single session from a tab. Refuses to drop a tab's last LIVE
  // session — the chat surface assumes at least one always exists, and the
  // caller uses the refusal to close the now-empty tab instead. Archived
  // sessions have no such constraint and are always deletable.
  // Returns the next session id the tab should activate, or null on a no-op.
  const remove = useCallback((tabId: string, sessionId: string): { nextActive: string | null; removed: boolean } => {
    if (!tabId) return { nextActive: null, removed: false }
    const list = sessionsByTab[tabId] ?? []
    const target = list.find(s => s.id === sessionId)
    if (!target) return { nextActive: null, removed: false }
    if (!target.archived && liveSessions(list).length <= 1) return { nextActive: null, removed: false }
    const idx = list.findIndex(s => s.id === sessionId)
    if (idx === -1) return { nextActive: null, removed: false }
    const next = list.filter(s => s.id !== sessionId)
    const currentActive = activeByTab[tabId]
    // Never hand activation to an archived neighbour.
    const liveNext = liveSessions(next)
    const nextActive = currentActive === sessionId
      ? ((next[idx] && !next[idx].archived ? next[idx].id : undefined)
        ?? (next[idx - 1] && !next[idx - 1].archived ? next[idx - 1].id : undefined)
        ?? liveNext[0]?.id ?? null)
      : currentActive
    setSessionsByTab(prev => ({ ...prev, [tabId]: next }))
    if (nextActive) setActiveByTab(prev => ({ ...prev, [tabId]: nextActive }))
    return { nextActive, removed: true }
  }, [sessionsByTab, activeByTab])

  return useMemo(() => ({
    sessionsByTab, activeByTab,
    getSessions, getAllSessions, getActiveId, getActiveSession,
    ensureTab, add, addDelegated, duplicate, activate, update, setArchived, backfillArchivedAt, remove, releaseTab, pruneTabs,
  }), [sessionsByTab, activeByTab, getSessions, getAllSessions, getActiveId, getActiveSession, ensureTab, add, addDelegated, duplicate, activate, update, setArchived, backfillArchivedAt, remove, releaseTab, pruneTabs])
}

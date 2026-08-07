import { useState, useEffect, useCallback, useMemo, useRef } from 'react'

export interface CodeFile {
  rel: string
  name: string
  text: string
  originalText: string
  size: number
  /** True when this tab was restored from persistence and hasn't been re-read from disk yet. */
  needsLoad?: boolean
}

export interface CodeEditorSession {
  tabs: CodeFile[]
  activeRel: string | null
  cursor: Record<string, { start: number; end: number }>
  scroll: Record<string, { top: number; left: number }>
  /** File-tree directories the user left expanded, so the tree restores its shape on remount. */
  expandedDirs: string[]
}

const STORAGE_KEY = 'crewcode:codeEditorSessions:v3'

/** Dirty-buffer guardrails */
const FILE_MAX = 100_000   // chars per file
const TOTAL_MAX = 500_000  // chars per editor session

interface PersistedFile {
  rel: string
  name: string
  text?: string // only present when dirty and within size limits
}

interface PersistedSession {
  tabs: PersistedFile[]
  activeRel: string | null
  cursor: Record<string, { start: number; end: number }>
  scroll: Record<string, { top: number; left: number }>
  expandedDirs?: string[]
}

function loadPersisted(): Record<string, PersistedSession> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return null
}

function persistSessions(sessions: Record<string, CodeEditorSession>): void {
  try {
    const toStore: Record<string, PersistedSession> = {}
    for (const [tabId, sess] of Object.entries(sessions)) {
      let total = 0
      const tabs: PersistedFile[] = sess.tabs.map(t => {
        const dirty = t.text !== t.originalText
        const include = dirty && t.text.length <= FILE_MAX && total + t.text.length <= TOTAL_MAX
        if (include) total += t.text.length
        return { rel: t.rel, name: t.name, text: include ? t.text : undefined }
      })
      toStore[tabId] = {
        tabs,
        activeRel: sess.activeRel,
        cursor: sess.cursor,
        scroll: sess.scroll,
        expandedDirs: sess.expandedDirs,
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore))
  } catch { /* quota — non-fatal */ }
}

export function useCodeEditorSessions() {
  const [sessions, setSessions] = useState<Record<string, CodeEditorSession>>({})
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

  // Load persisted sessions on mount. Dirty buffers restore their text;
  // clean buffers are re-read from disk (needsLoad: true).
  useEffect(() => {
    const persisted = loadPersisted()
    if (!persisted) return
    setSessions(prev => {
      const next = { ...prev }
      for (const [tabId, sess] of Object.entries(persisted)) {
        next[tabId] = {
          tabs: sess.tabs.map(t => {
            // Bind a definite string so `text`/`originalText` aren't widened to
            // `string | undefined` (TS won't narrow t.text via a separate flag).
            const text = typeof t.text === 'string' && t.text.length > 0 ? t.text : ''
            const hasText = text.length > 0
            return {
              rel: t.rel,
              name: t.name,
              text,
              originalText: text,
              size: hasText ? new Blob([text]).size : 0,
              needsLoad: !hasText,
            }
          }),
          activeRel: sess.activeRel,
          cursor: sess.cursor ?? {},
          scroll: sess.scroll ?? {},
          expandedDirs: sess.expandedDirs ?? [],
        }
      }
      return next
    })
  }, [])

  // Persist tab lists, activeRel, cursor, scroll, and dirty buffer text.
  // Clean files store only metadata; dirty files store text when under limits.
  useEffect(() => {
    persistSessions(sessions)
  }, [sessions])

  useEffect(() => {
    const flush = () => persistSessions(sessionsRef.current)
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

  const ensureTab = useCallback((tabId: string) => {
    setSessions(prev => {
      if (prev[tabId]) return prev
      return { ...prev, [tabId]: { tabs: [], activeRel: null, cursor: {}, scroll: {}, expandedDirs: [] } }
    })
  }, [])

  const openFile = useCallback((tabId: string, file: Omit<CodeFile, 'originalText'>) => {
    setSessions(prev => {
      const sess = prev[tabId] ?? { tabs: [], activeRel: null, cursor: {}, scroll: {}, expandedDirs: [] }
      const existing = sess.tabs.find(t => t.rel === file.rel)
      if (existing) {
        return { ...prev, [tabId]: { ...sess, activeRel: file.rel, tabs: sess.tabs.map(t => t.rel === file.rel ? { ...t, ...file, originalText: file.text, needsLoad: false } : t) } }
      }
      const newFile: CodeFile = { ...file, originalText: file.text, needsLoad: false }
      return { ...prev, [tabId]: { ...sess, tabs: [...sess.tabs, newFile], activeRel: file.rel } }
    })
  }, [])

  const closeFile = useCallback((tabId: string, rel: string) => {
    setSessions(prev => {
      const sess = prev[tabId]
      if (!sess) return prev
      const nextTabs = sess.tabs.filter(t => t.rel !== rel)
      let nextActive = sess.activeRel
      if (sess.activeRel === rel) {
        const idx = sess.tabs.findIndex(t => t.rel === rel)
        const fallback = nextTabs[idx] ?? nextTabs[idx - 1] ?? nextTabs[0] ?? null
        nextActive = fallback?.rel ?? null
      }
      const nextCursor = { ...sess.cursor }
      delete nextCursor[rel]
      const nextScroll = { ...sess.scroll }
      delete nextScroll[rel]
      return { ...prev, [tabId]: { ...sess, tabs: nextTabs, activeRel: nextActive, cursor: nextCursor, scroll: nextScroll } }
    })
  }, [])

  const setActiveRel = useCallback((tabId: string, rel: string | null) => {
    setSessions(prev => {
      const sess = prev[tabId]
      if (!sess) return prev
      return { ...prev, [tabId]: { ...sess, activeRel: rel } }
    })
  }, [])

  const updateText = useCallback((tabId: string, rel: string, text: string) => {
    setSessions(prev => {
      const sess = prev[tabId]
      if (!sess) return prev
      return { ...prev, [tabId]: { ...sess, tabs: sess.tabs.map(t => t.rel === rel ? { ...t, text } : t) } }
    })
  }, [])

  const markSaved = useCallback((tabId: string, rel: string, size: number) => {
    setSessions(prev => {
      const sess = prev[tabId]
      if (!sess) return prev
      return { ...prev, [tabId]: { ...sess, tabs: sess.tabs.map(t => t.rel === rel ? { ...t, originalText: t.text, size } : t) } }
    })
  }, [])

  // Replace a tab's content with what's freshly on disk (live-reload). Resets
  // originalText so the buffer reads clean, matching the file it now mirrors.
  const applyDiskContent = useCallback((tabId: string, rel: string, text: string, size: number) => {
    setSessions(prev => {
      const sess = prev[tabId]
      if (!sess) return prev
      return { ...prev, [tabId]: { ...sess, tabs: sess.tabs.map(t => t.rel === rel ? { ...t, text, originalText: text, size, needsLoad: false } : t) } }
    })
  }, [])

  const setCursor = useCallback((tabId: string, rel: string, cursor: { start: number; end: number }) => {
    setSessions(prev => {
      const sess = prev[tabId]
      if (!sess) return prev
      return { ...prev, [tabId]: { ...sess, cursor: { ...sess.cursor, [rel]: cursor } } }
    })
  }, [])

  const setScroll = useCallback((tabId: string, rel: string, scroll: { top: number; left: number }) => {
    setSessions(prev => {
      const sess = prev[tabId]
      if (!sess) return prev
      return { ...prev, [tabId]: { ...sess, scroll: { ...sess.scroll, [rel]: scroll } } }
    })
  }, [])

  const setExpandedDirs = useCallback((tabId: string, expandedDirs: string[]) => {
    setSessions(prev => {
      const sess = prev[tabId]
      if (!sess) return prev
      return { ...prev, [tabId]: { ...sess, expandedDirs } }
    })
  }, [])

  const removeTab = useCallback((tabId: string) => {
    setSessions(prev => {
      const next = { ...prev }
      delete next[tabId]
      return next
    })
  }, [])

  // Remove editor sessions whose tab IDs no longer exist in the workspace.
  const prune = useCallback((validTabIds: Set<string>) => {
    setSessions(prev => {
      const next = { ...prev }
      let changed = false
      for (const tabId of Object.keys(next)) {
        if (!validTabIds.has(tabId)) {
          delete next[tabId]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [])

  return useMemo(() => ({
    sessions, ensureTab, openFile, closeFile, setActiveRel, updateText, markSaved, applyDiskContent, setCursor, setScroll, setExpandedDirs, removeTab, prune,
  }), [sessions, ensureTab, openFile, closeFile, setActiveRel, updateText, markSaved, applyDiskContent, setCursor, setScroll, setExpandedDirs, removeTab, prune])
}

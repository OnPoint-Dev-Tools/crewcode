/**
 * useTerminalSessions — owns PTY panes, per-tab layout (columns/rows/weights),
 * split direction, and column width/height.
 *
 * Terminal pane metadata and layouts are persisted to localStorage so the
 * exact grid structure survives app restarts. Live PTY processes are NOT
 * restored; panes are recreated from their metadata on load.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import type { PtyPane } from '../types'
import { getCurrentSettings } from './useSettings'

let counter = 0
function nextPaneId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter}`
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface Layout {
  columns:    string[][]
  colWeights: number[]
  rowWeights: number[][]
}

interface PersistedPaneMeta {
  type:    'shell' | 'agent' | 'ssh'
  wsId:    string
  agentId?: string | null
  shell?:  string
  argv?:   string[]
  title:   string
  sub:     string
  cwd:     string
}

interface PersistedTabSession {
  panes:      PersistedPaneMeta[]
  columns:    number[][]
  colWeights: number[]
  rowWeights: number[][]
  split:      'right' | 'down'
  width:      number
  height:     number
}

const STORAGE_KEY = 'crewcode:terminalSessions:v1'
const EMPTY_LAYOUT: Layout = { columns: [], colWeights: [], rowWeights: [] }

function createShellPane(wsId: string, tabId: string, cwd: string, shell?: string): PtyPane {
  return {
    paneId:  nextPaneId(`${wsId}-sh`),
    wsId,
    tabId,
    agentId: null,
    title:   shell && shell !== 'auto' ? shell : 'shell',
    sub:     cwd,
    cwd,
    live:    true,
    shell,
  }
}

function reconcileLayout(layout: Layout | undefined, paneIds: string[]): Layout {
  const paneIdSet = new Set(paneIds)
  const current = layout ?? EMPTY_LAYOUT
  const inLayout = new Set(current.columns.flat().filter(id => paneIdSet.has(id)))

  const cleaned = current.columns
    .map(col => col.filter(id => paneIdSet.has(id)))
    .filter(col => col.length > 0)

  const missing = paneIds.filter(id => !inLayout.has(id))
  const columns = missing.length === 0
    ? cleaned
    : cleaned.length > 0
      ? [...cleaned, ...missing.map(id => [id])]
      : [missing]

  if (columns.length === 0) return EMPTY_LAYOUT

  const colWeights = columns.map((_, i) => current.colWeights[i] ?? 1)
  const rowWeights = columns.map((col, i) => col.map((_, j) => current.rowWeights[i]?.[j] ?? 1))
  return { columns, colWeights, rowWeights }
}

function loadPersisted(): Record<string, PersistedTabSession> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* corrupt — start fresh */ }
  return {}
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useTerminalSessions() {
  const persistedRef = useRef(loadPersisted())
  const restoredTabsRef = useRef(new Set<string>())

  const [panes,       setPanes]       = useState<PtyPane[]>([])
  const [layouts,     setLayouts]     = useState<Record<string, Layout>>({})
  const [tabSplits,   setTabSplits]   = useState<Record<string, 'right' | 'down'>>({})
  const [tabWidths,   setTabWidths]   = useState<Record<string, number>>({})
  const [tabHeights,  setTabHeights]  = useState<Record<string, number>>({})
  const panesRef = useRef<PtyPane[]>([])
  panesRef.current = panes

  // ── Getters ──────────────────────────────────────────────────────────────

  const getTabPanes = useCallback((tabId: string) => panes.filter(p => p.tabId === tabId), [panes])

  const getTabLayout = useCallback((tabId: string) => layouts[tabId] ?? EMPTY_LAYOUT, [layouts])

  const getTabSplit = useCallback((tabId: string) => tabSplits[tabId] ?? 'right', [tabSplits])

  const getTabWidth = useCallback((tabId: string) => tabWidths[tabId] ?? 340, [tabWidths])

  const getTabHeight = useCallback((tabId: string) => tabHeights[tabId] ?? 320, [tabHeights])

  // ── Pane creation ────────────────────────────────────────────────────────

  const startPty = useCallback((pane: PtyPane) => {
    // Start on creation, not xterm mount: hidden tabs/workspaces must keep
    // shell and agent work running until the user explicitly closes them.
    // YuHeard: read settings live (no subscription) so toggles take effect
    // without a re-mount. The main process decides what to inject based on
    // these flags.
    const settings = getCurrentSettings()
    const wrapAgentIds = settings.yuheardAutoWrap
      ? Object.entries(settings.connections).filter(([, on]) => on).map(([id]) => id)
      : []
    void window.electronAPI?.ptyCreate?.({
      paneId: pane.paneId,
      cwd: pane.cwd,
      shell: pane.shell,
      argv: pane.argv,
      agentId: pane.agentId ?? null,
      autoWrap: settings.yuheardAutoWrap && !pane.agentId && pane.shell !== 'ssh',
      wrapAgentIds,
    })
  }, [])

  const addShell = useCallback((wsId: string, tabId: string, cwd: string, shell?: string) => {
    const pane = createShellPane(wsId, tabId, cwd, shell)
    startPty(pane)
    setPanes(p => [...p, pane])
    return pane
  }, [startPty])

  const addSsh = useCallback((wsId: string, tabId: string, target: string, cwd: string) => {
    const portMatch = target.match(/^(.+):(\d+)$/)
    const host = portMatch ? portMatch[1] : target
    const argv = portMatch ? ['-p', portMatch[2], host] : [host]
    const pane: PtyPane = {
      paneId:  nextPaneId(`${wsId}-ssh`),
      wsId,
      tabId,
      agentId: null,
      title:   `ssh · ${target}`,
      sub:     target,
      cwd,
      live:    true,
      shell:   'ssh',
      argv,
    }
    startPty(pane)
    setPanes(p => [...p, pane])
    return pane
  }, [startPty])

  const addAgent = useCallback((wsId: string, tabId: string, agentId: string, agentName: string, cwd: string, shell?: string | null) => {
    const pane: PtyPane = {
      paneId:  nextPaneId(`${wsId}-${agentId}`),
      wsId,
      tabId,
      agentId,
      title:   agentName,
      sub:     `${agentId} · ${cwd}`,
      cwd,
      live:    true,
      shell:   shell ?? undefined,
    }
    startPty(pane)
    setPanes(p => [...p, pane])
    return pane
  }, [startPty])

  // ── Pane close / write ───────────────────────────────────────────────────

  const close = useCallback((paneId: string) => {
    setPanes(prev => {
      const pane = prev.find(p => p.paneId === paneId)
      if (pane) {
        window.electronAPI?.ptyKill(paneId)
        const tabId = pane.tabId
        setLayouts(prevLayouts => {
          const layout = prevLayouts[tabId]
          if (!layout) return prevLayouts

          const columns: string[][] = []
          const colWeights: number[] = []
          const rowWeights: number[][] = []

          for (let ci = 0; ci < layout.columns.length; ci++) {
            const col = layout.columns[ci]
            const rowIdx = col.indexOf(paneId)
            if (rowIdx !== -1) {
              const nextCol = col.filter(id => id !== paneId)
              const nextRw = (layout.rowWeights[ci] ?? []).filter((_, ri) => ri !== rowIdx)
              if (nextCol.length > 0) {
                columns.push(nextCol)
                colWeights.push(layout.colWeights[ci] ?? 1)
                rowWeights.push(nextRw.length ? nextRw : nextCol.map(() => 1))
              }
              // empty column → drop it (and its weights)
            } else {
              columns.push(col)
              colWeights.push(layout.colWeights[ci] ?? 1)
              rowWeights.push(layout.rowWeights[ci] ?? col.map(() => 1))
            }
          }

          if (columns.length === 0) {
            const next = { ...prevLayouts }
            delete next[tabId]
            return next
          }
          return { ...prevLayouts, [tabId]: { columns, colWeights, rowWeights } }
        })
      }
      return prev.filter(p => p.paneId !== paneId)
    })
  }, [])

  const write = useCallback((paneId: string, data: string) => {
    window.electronAPI?.ptyWrite(paneId, data)
  }, [])

  // ── Layout / dimension setters ───────────────────────────────────────────

  const setTabLayout = useCallback((tabId: string, layout: Layout) => {
    setLayouts(prev => ({ ...prev, [tabId]: layout }))
  }, [])

  const setTabSplit = useCallback((tabId: string, split: 'right' | 'down') => {
    setTabSplits(prev => ({ ...prev, [tabId]: split }))
  }, [])

  const setTabWidth = useCallback((tabId: string, width: number | ((prev: number) => number)) => {
    setTabWidths(prev => {
      const current = prev[tabId] ?? 340
      const next = typeof width === 'function' ? width(current) : width
      return { ...prev, [tabId]: next }
    })
  }, [])

  const setTabHeight = useCallback((tabId: string, height: number | ((prev: number) => number)) => {
    setTabHeights(prev => {
      const current = prev[tabId] ?? 320
      const next = typeof height === 'function' ? height(current) : height
      return { ...prev, [tabId]: next }
    })
  }, [])

  // ── Restore / clear / prune ──────────────────────────────────────────────

  const restoreTab = useCallback((tabId: string) => {
    if (restoredTabsRef.current.has(tabId)) return
    restoredTabsRef.current.add(tabId)

    const saved = persistedRef.current[tabId]
    if (!saved || saved.panes.length === 0) return
    if (panesRef.current.some(p => p.tabId === tabId)) return

    const newPaneIds: string[] = []
    const newPanes: PtyPane[] = []

    for (const meta of saved.panes) {
      let pane: PtyPane
      switch (meta.type) {
        case 'agent':
          pane = {
            paneId:  nextPaneId(`${meta.wsId}-${meta.agentId}`),
            wsId:    meta.wsId,
            tabId,
            agentId: meta.agentId ?? null,
            title:   meta.title,
            sub:     meta.sub,
            cwd:     meta.cwd,
            live:    true,
          }
          break
        case 'ssh':
          pane = {
            paneId:  nextPaneId(`${meta.wsId}-ssh`),
            wsId:    meta.wsId,
            tabId,
            agentId: null,
            title:   meta.title,
            sub:     meta.sub,
            cwd:     meta.cwd,
            live:    true,
            shell:   'ssh',
            argv:    meta.argv,
          }
          break
        default:
          pane = {
            paneId:  nextPaneId(`${meta.wsId}-sh`),
            wsId:    meta.wsId,
            tabId,
            agentId: null,
            title:   meta.title,
            sub:     meta.sub,
            cwd:     meta.cwd,
            live:    true,
            shell:   meta.shell,
          }
      }
      newPaneIds.push(pane.paneId)
      newPanes.push(pane)
    }

    // Sanitize restored layout: drop empty columns and align weight arrays.
    const rawColumns = saved.columns
      .map(col => col.map(idx => newPaneIds[idx]).filter(Boolean) as string[])
      .filter(col => col.length > 0)

    const colWeights = saved.colWeights.slice(0, rawColumns.length)
    while (colWeights.length < rawColumns.length) colWeights.push(1)

    const rowWeights = rawColumns.map((col, i) => {
      const rw = (saved.rowWeights[i] ?? []).slice(0, col.length)
      while (rw.length < col.length) rw.push(1)
      return rw
    })

    const layout: Layout = { columns: rawColumns, colWeights, rowWeights }

    setPanes(prev => {
      if (prev.some(p => p.tabId === tabId)) return prev
      setLayouts(prevLayouts => ({ ...prevLayouts, [tabId]: layout }))
      if (saved.split) setTabSplits(prevSplits => ({ ...prevSplits, [tabId]: saved.split }))
      if (saved.width) setTabWidths(prevWidths => ({ ...prevWidths, [tabId]: saved.width }))
      if (saved.height) setTabHeights(prevHeights => ({ ...prevHeights, [tabId]: saved.height }))
      return [...prev, ...newPanes]
    })
  }, [])

  const clearTab = useCallback((tabId: string) => {
    setPanes(prev => {
      for (const pane of prev) {
        if (pane.tabId === tabId) window.electronAPI?.ptyKill(pane.paneId)
      }
      return prev.filter(p => p.tabId !== tabId)
    })
    setLayouts(prev => { const n = { ...prev }; delete n[tabId]; return n })
    setTabSplits(prev => { const n = { ...prev }; delete n[tabId]; return n })
    setTabWidths(prev => { const n = { ...prev }; delete n[tabId]; return n })
    setTabHeights(prev => { const n = { ...prev }; delete n[tabId]; return n })
  }, [])

  const prune = useCallback((validTabIds: Set<string>) => {
    setPanes(prev => {
      const next = prev.filter(p => validTabIds.has(p.tabId))
      if (next.length !== prev.length) {
        for (const pane of prev) {
          if (!validTabIds.has(pane.tabId)) window.electronAPI?.ptyKill(pane.paneId)
        }
      }
      return next.length === prev.length ? prev : next
    })
    const pruneMap = (prev: Record<string, any>) => {
      const n = { ...prev }
      let changed = false
      for (const tabId of Object.keys(n)) {
        if (!validTabIds.has(tabId)) { delete n[tabId]; changed = true }
      }
      return changed ? n : prev
    }
    setLayouts(prev => pruneMap(prev))
    setTabSplits(prev => pruneMap(prev))
    setTabWidths(prev => pruneMap(prev))
    setTabHeights(prev => pruneMap(prev))
  }, [])

  const ensurePane = useCallback((tabId: string, wsId: string, cwd: string, shell?: string) => {
    // Startup restore and active-terminal auto-open run in the same effect pass;
    // defer to persisted metadata so we don't append a bonus shell while restoring.
    if (!restoredTabsRef.current.has(tabId) && persistedRef.current[tabId]?.panes.length) return
    setPanes(prev => {
      if (prev.some(p => p.tabId === tabId)) return prev
      const pane = createShellPane(wsId, tabId, cwd, shell)
      startPty(pane)
      return [...prev, pane]
    })
  }, [startPty])

  // Split the active tab's terminal: spawn a new shell pane and place it to the
  // right (new column) or below (new row) of the tab's last pane. If the tab has
  // no panes yet, a source pane is created first so a single keypress yields a
  // real split. Layout for both chat and terminal tabs lives here, so this is
  // the one place that can drive the split from a global shortcut. Mirrors the
  // setLayouts-inside-setPanes pattern used by `close` so the new pane and its
  // layout slot land in the same commit.
  const splitTab = useCallback((tabId: string, wsId: string, cwd: string, dir: 'right' | 'down', shell?: string) => {
    const mkShell = (): PtyPane => ({
      paneId:  nextPaneId(`${wsId}-sh`),
      wsId,
      tabId,
      agentId: null,
      title:   shell && shell !== 'auto' ? shell : 'shell',
      sub:     cwd,
      cwd,
      live:    true,
      shell,
    })

    setPanes(prevPanes => {
      const tabPanes = prevPanes.filter(p => p.tabId === tabId)
      const additions: PtyPane[] = []
      let fromPaneId: string
      if (tabPanes.length === 0) {
        const src = mkShell()
        additions.push(src)
        fromPaneId = src.paneId
      } else {
        fromPaneId = tabPanes[tabPanes.length - 1].paneId
      }
      const newPane = mkShell()
      additions.push(newPane)
      for (const pane of additions) startPty(pane)

      setLayouts(prevLayouts => {
        const layout = prevLayouts[tabId] ?? EMPTY_LAYOUT
        const colIdx = layout.columns.findIndex(c => c.includes(fromPaneId))

        // Source not in the layout yet (freshly created, or empty tab): seed the
        // base column(s) explicitly so direction is honored from the first split.
        if (colIdx === -1) {
          const next: Layout = dir === 'right'
            ? {
                columns:    [...layout.columns, [fromPaneId], [newPane.paneId]],
                colWeights: [...layout.colWeights, 1, 1],
                rowWeights: [...layout.rowWeights, [1], [1]],
              }
            : {
                columns:    [...layout.columns, [fromPaneId, newPane.paneId]],
                colWeights: [...layout.colWeights, 1],
                rowWeights: [...layout.rowWeights, [1, 1]],
              }
          return { ...prevLayouts, [tabId]: next }
        }

        if (dir === 'right') {
          return {
            ...prevLayouts,
            [tabId]: {
              columns:    [...layout.columns.slice(0, colIdx + 1), [newPane.paneId], ...layout.columns.slice(colIdx + 1)],
              colWeights: [...layout.colWeights.slice(0, colIdx + 1), layout.colWeights[colIdx] ?? 1, ...layout.colWeights.slice(colIdx + 1)],
              rowWeights: [...layout.rowWeights.slice(0, colIdx + 1), [1], ...layout.rowWeights.slice(colIdx + 1)],
            },
          }
        }

        const rowIdx = layout.columns[colIdx].indexOf(fromPaneId)
        return {
          ...prevLayouts,
          [tabId]: {
            columns: layout.columns.map((col, i) =>
              i !== colIdx ? col : [...col.slice(0, rowIdx + 1), newPane.paneId, ...col.slice(rowIdx + 1)]),
            colWeights: layout.colWeights,
            rowWeights: layout.rowWeights.map((rw, i) =>
              i !== colIdx ? rw : [...rw.slice(0, rowIdx + 1), rw[rowIdx] ?? 1, ...rw.slice(rowIdx + 1)]),
          },
        }
      })

      return [...prevPanes, ...additions]
    })

    setTabSplits(prev => ({ ...prev, [tabId]: dir }))
  }, [startPty])

  // Keep persisted/external layouts in sync with pane creation/removal.
  // TermColumn only auto-reconciles its internal layout, so terminal tabs that
  // store layout in this hook need the same repair path here.
  useEffect(() => {
    setLayouts(prev => {
      const next: Record<string, Layout> = {}
      let changed = false
      const tabIds = new Set<string>([
        ...Object.keys(prev),
        ...panes.map(p => p.tabId),
      ])

      for (const tabId of tabIds) {
        const paneIds = panes.filter(p => p.tabId === tabId).map(p => p.paneId)
        const reconciled = reconcileLayout(prev[tabId], paneIds)
        if (reconciled.columns.length > 0) next[tabId] = reconciled
        const before = prev[tabId]
        const beforeJson = before ? JSON.stringify(before) : ''
        const afterJson = reconciled.columns.length > 0 ? JSON.stringify(reconciled) : ''
        if (beforeJson !== afterJson) changed = true
      }

      return changed ? next : prev
    })
  }, [panes])

  // ── Persistence ──────────────────────────────────────────────────────────

  useEffect(() => {
    try {
      const toStore: Record<string, PersistedTabSession> = {}

      // Collect every tabId that has either panes or a stored layout.
      const tabIds = new Set<string>([
        ...panes.map(p => p.tabId),
        ...Object.keys(layouts),
      ])

      for (const tabId of tabIds) {
        const tabPanes = panes.filter(p => p.tabId === tabId)
        const paneIndexMap = new Map(tabPanes.map((p, i) => [p.paneId, i]))
        const layout = layouts[tabId]

        let columns: number[][]
        let colWeights: number[]
        let rowWeights: number[][]

        if (layout && layout.columns.length > 0) {
          columns = layout.columns
            .map(col => col.map(paneId => paneIndexMap.get(paneId)).filter(i => i !== undefined) as number[])
            .filter(col => col.length > 0)
          colWeights = layout.colWeights.slice(0, columns.length)
          while (colWeights.length < columns.length) colWeights.push(1)
          rowWeights = columns.map((col, i) => {
            const rw = (layout.rowWeights[i] ?? []).slice(0, col.length)
            while (rw.length < col.length) rw.push(1)
            return rw
          })
        } else if (tabPanes.length > 0) {
          // No explicit layout yet — default to a single column.
          columns = [tabPanes.map((_, i) => i)]
          colWeights = [1]
          rowWeights = [tabPanes.map(() => 1)]
        } else {
          continue
        }

        toStore[tabId] = {
          panes: tabPanes.map(p => ({
            type: p.agentId ? 'agent' : p.shell === 'ssh' ? 'ssh' : 'shell',
            wsId: p.wsId,
            agentId: p.agentId,
            shell: p.shell,
            argv: p.argv,
            title: p.title,
            sub: p.sub,
            cwd: p.cwd,
          })),
          columns,
          colWeights,
          rowWeights,
          split: tabSplits[tabId] ?? 'right',
          width: tabWidths[tabId] ?? 340,
          height: tabHeights[tabId] ?? 320,
        }
      }

      localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore))
    } catch { /* quota — non-fatal */ }
  }, [panes, layouts, tabSplits, tabWidths, tabHeights])

  return useMemo(() => ({
    panes,
    getTabPanes,
    addShell,
    addSsh,
    addAgent,
    close,
    write,
    getTabLayout,
    setTabLayout,
    getTabSplit,
    setTabSplit,
    getTabWidth,
    setTabWidth,
    getTabHeight,
    setTabHeight,
    restoreTab,
    clearTab,
    prune,
    ensurePane,
    splitTab,
  }), [panes, getTabPanes, addShell, addSsh, addAgent, close, write, getTabLayout, setTabLayout, getTabSplit, setTabSplit, getTabWidth, setTabWidth, getTabHeight, setTabHeight, restoreTab, clearTab, prune, ensurePane, splitTab])
}

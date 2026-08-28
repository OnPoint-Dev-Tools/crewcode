/**
 * useWorkspaceTabs — owns the per-workspace tab list and the active tab.
 *
 * Pure tab-state logic, extracted from App. Bridge teardown on close is left to
 * the caller (App composes it) so this hook stays independent of the bridge
 * registry — the two extractions don't depend on each other.
 *
 * Persistence: wsTabs, active tab per workspace, and split state are saved to
 * localStorage so the window nav restores exactly after restart.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { BrowserSessionMode, Tab, TabKind } from '../types'
import type { PluginOpenContext, RegisteredPluginTab } from '../../../shared/plugin-types'
import { insertTabAfter, planSessionSplit } from '../components/thread/session-drag'

let tabIdCounter = 0
function nextTabId(wsId: string, kind: TabKind): string {
  tabIdCounter += 1
  return `${wsId}-${kind}-${Date.now().toString(36)}-${tabIdCounter}`
}

function dedupeTabIds(tabs: Tab[], wsId: string): Tab[] {
  const seen = new Set<string>()
  const seenSingletonPlugins = new Set<string>()
  const out: Tab[] = []
  for (const tab of tabs) {
    if (tab.kind === 'plugin' && tab.pluginSingleton && tab.pluginRegistrationId) {
      if (seenSingletonPlugins.has(tab.pluginRegistrationId)) continue
      seenSingletonPlugins.add(tab.pluginRegistrationId)
    }
    if (!seen.has(tab.id)) {
      seen.add(tab.id)
      out.push(tab)
      continue
    }
    const nextId = nextTabId(wsId, tab.kind)
    seen.add(nextId)
    out.push({ ...tab, id: nextId })
  }
  return out
}

const KIND_LABEL: Record<TabKind, string> = {
  chat: 'Chat', crew: 'Crew', canvas: 'Workbench Mode', git: 'Git', code: 'CrewCode Editor', writer: 'Writers Workspace', terminal: 'Terminal', browser: 'Browser', settings: 'Settings', plugins: 'Plugins', prompts: 'Studio', mission: 'Control Center', archive: 'Archive', plugin: 'Plugin',
}

// Tab kinds that should only ever have one open at a time (per workspace).
const SINGLETON_KINDS: TabKind[] = ['settings', 'plugins', 'prompts', 'mission', 'archive', 'code', 'git']

function defaultChatTab(wsId: string, name: string): Tab {
  return { id: `${wsId}-chat`, kind: 'chat', label: name, live: false }
}

function materializeTabList(prev: Record<string, Tab[]>, wsId: string, workspaceName: string): Tab[] {
  const existing = prev[wsId]
  if (existing?.length) return existing
  return wsId ? [defaultChatTab(wsId, workspaceName)] : []
}

interface UseWorkspaceTabsOpts {
  activeWs:      string
  workspaceName: string   // active workspace name — used as the chat tab label
}

// ── Persistence ────────────────────────────────────────────────────────────

const STORAGE_KEY = 'crewcode:workspaceTabs:v1'
const VALID_KINDS: TabKind[] = ['chat', 'crew', 'canvas', 'git', 'code', 'writer', 'terminal', 'browser', 'settings', 'plugins', 'prompts', 'mission', 'archive', 'plugin']

type SplitGroup = { id: string; primary: string; tabs: string[] }

type PersistedSplitValue = Array<Record<string, unknown>> | Record<string, unknown> | null

function isValidTab(t: unknown): t is Tab {
  if (!t || typeof t !== 'object') return false
  const tab = t as Record<string, unknown>
  const baseValid = (
    typeof tab.id === 'string' &&
    typeof tab.kind === 'string' &&
    VALID_KINDS.includes(tab.kind as TabKind) &&
    typeof tab.label === 'string'
  )
  if (!baseValid) return false
  if (tab.kind !== 'plugin') return true
  return (
    typeof tab.pluginId === 'string' &&
    typeof tab.pluginTabId === 'string' &&
    typeof tab.pluginRegistrationId === 'string' &&
    typeof tab.pluginEntry === 'string'
  )
}

function persistWorkspaceTabs(wsTabs: Record<string, Tab[]>, activeByWs: Record<string, string>, splitMap: Record<string, SplitGroup[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ wsTabs, activeByWs, splitMap }))
  } catch { /* quota — non-fatal */ }
}

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const wsTabs: Record<string, Tab[]> = {}
        const activeByWs: Record<string, string> = {}
        const splitMap: Record<string, SplitGroup[]> = {}

        if (parsed.wsTabs && typeof parsed.wsTabs === 'object') {
          for (const [wsId, tabs] of Object.entries(parsed.wsTabs)) {
            if (Array.isArray(tabs)) {
              const valid = tabs.filter(isValidTab)
              if (valid.length) wsTabs[wsId] = dedupeTabIds(valid, wsId)
            }
          }
        }

        if (parsed.activeByWs && typeof parsed.activeByWs === 'object') {
          for (const [wsId, id] of Object.entries(parsed.activeByWs)) {
            if (typeof id !== 'string') continue
            const list = wsTabs[wsId] ?? []
            if (list.find(t => t.id === id)) activeByWs[wsId] = id
            else if (list.length) activeByWs[wsId] = list[0].id
          }
        }

        if (parsed.splitMap && typeof parsed.splitMap === 'object') {
          for (const [wsId, val] of Object.entries(parsed.splitMap) as Array<[string, PersistedSplitValue]>) {
            if (val === null) { splitMap[wsId] = []; continue }
            const values = Array.isArray(val) ? val : [val]
            const list = wsTabs[wsId] ?? []
            const groups: SplitGroup[] = []
            for (const raw of values) {
              if (!raw || typeof raw !== 'object' || typeof raw.primary !== 'string') continue
              const rawTabs = Array.isArray(raw.tabs)
                ? raw.tabs.filter((id): id is string => typeof id === 'string')
                : (typeof raw.secondary === 'string' ? [raw.primary, raw.secondary] : [])
              const validTabs = [...new Set(rawTabs.filter(id => list.some(t => t.id === id)))]
              if (validTabs.includes(raw.primary) && validTabs.length >= 2) {
                groups.push({
                  id: typeof raw.id === 'string' ? raw.id : `split-${groups.length + 1}`,
                  primary: raw.primary,
                  tabs: validTabs,
                })
              }
            }
            splitMap[wsId] = groups
          }
        }

        return { wsTabs, activeByWs, splitMap }
      }
    }
  } catch { /* corrupt or missing — start fresh */ }
  return { wsTabs: {}, activeByWs: {}, splitMap: {} }
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useWorkspaceTabs({ activeWs, workspaceName }: UseWorkspaceTabsOpts) {
  const persisted = useMemo(() => loadPersisted(), [])
  const [wsTabs, setWsTabs] = useState<Record<string, Tab[]>>(persisted.wsTabs)
  const [activeByWs, setActiveByWs] = useState<Record<string, string>>(persisted.activeByWs)
  const [splitMap, setSplitMap] = useState<Record<string, SplitGroup[]>>(persisted.splitMap)
  const persistedStateRef = useRef({ wsTabs, activeByWs, splitMap })
  persistedStateRef.current = { wsTabs, activeByWs, splitMap }

  // The active workspace's tabs — falling back to a virtual default chat tab
  // that isn't stored until the user actually opens a second tab.
  const tabs = useMemo(() => (
    (wsTabs[activeWs]?.length)
      ? wsTabs[activeWs]
      : (activeWs ? [defaultChatTab(activeWs, workspaceName)] : [])
  ), [activeWs, workspaceName, wsTabs])

  const activeTabId = activeByWs[activeWs] ?? tabs[0]?.id ?? ''
  const activeTab = useMemo(() => tabs.find(t => t.id === activeTabId) ?? tabs[0], [activeTabId, tabs])
  const splitGroups = useMemo(() => splitMap[activeWs] ?? [], [activeWs, splitMap])
  const activeSplitGroup = useMemo(() => splitGroups.find(group => group.tabs.includes(activeTabId)) ?? null, [activeTabId, splitGroups])
  const splitTabIds = useMemo(() => activeSplitGroup?.tabs ?? [], [activeSplitGroup])
  const splitTabId = useMemo(() => splitTabIds.find(id => id !== activeSplitGroup?.primary) ?? null, [activeSplitGroup?.primary, splitTabIds])
  const splitPrimaryTabId = activeSplitGroup?.primary ?? null

  const setActiveTabId = useCallback((id: string) => {
    if (!activeWs) return
    setActiveByWs(prev => prev[activeWs] === id ? prev : { ...prev, [activeWs]: id })
  }, [activeWs])

  // Workspace-explicit active-tab setter — needed when activating a tab in a
  // workspace that isn't the active one yet (the closure-bound setActiveTabId
  // would otherwise write to the stale active workspace).
  const setActiveTabInWorkspace = useCallback((wsId: string, id: string) => {
    if (!wsId) return
    setActiveByWs(prev => prev[wsId] === id ? prev : { ...prev, [wsId]: id })
  }, [])

  // Keep active tab valid when the workspace changes.
  useEffect(() => {
    if (!activeWs) return
    const list = wsTabs[activeWs] ?? []
    const current = activeByWs[activeWs]
    if (!current) {
      setActiveByWs(prev => ({ ...prev, [activeWs]: list[0]?.id ?? `${activeWs}-chat` }))
    } else if (list.length > 0 && !list.find(t => t.id === current)) {
      setActiveByWs(prev => ({ ...prev, [activeWs]: list[0].id }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWs, wsTabs])

  const getActiveTabIdForWorkspace = useCallback((wsId: string) => {
    if (!wsId) return ''
    const latest = persistedStateRef.current
    const list = latest.wsTabs[wsId] ?? []
    const current = latest.activeByWs[wsId]
    return current && (list.some(tab => tab.id === current) || current === `${wsId}-chat`)
      ? current
      : (list[0]?.id ?? `${wsId}-chat`)
  }, [])

  /** Point the active tab at a workspace's last active tab. */
  const selectWorkspace = useCallback((wsId: string) => {
    const latest = persistedStateRef.current
    const list = latest.wsTabs[wsId] ?? []
    const current = latest.activeByWs[wsId]
    const valid = current && (list.find(t => t.id === current) || current === `${wsId}-chat`)
    const nextActive = valid ? current : (list[0]?.id ?? `${wsId}-chat`)
    setActiveByWs(prev => prev[wsId] === nextActive ? prev : { ...prev, [wsId]: nextActive })
  }, [])

  const openTabInWorkspace = useCallback((wsId: string, wsName: string, kind: TabKind, opts?: { url?: string }) => {
    if (!wsId) return undefined
    if (SINGLETON_KINDS.includes(kind)) {
      const existing = (wsTabs[wsId] ?? []).find(t => t.kind === kind)
      if (existing) {
        setActiveByWs(prev => ({ ...prev, [wsId]: existing.id }))
        return existing.id
      }
      const id = `${wsId}-${kind}`
      const label = KIND_LABEL[kind]
      setWsTabs(prev => {
        const existingList = materializeTabList(prev, wsId, wsName)
        return { ...prev, [wsId]: [...existingList, { id, kind, label, live: false }] }
      })
      setActiveByWs(prev => ({ ...prev, [wsId]: id }))
      return id
    }
    const id    = nextTabId(wsId, kind)
    const label = kind === 'chat' ? wsName : KIND_LABEL[kind]
    setWsTabs(prev => {
      const existing = materializeTabList(prev, wsId, wsName)
      return { ...prev, [wsId]: [...existing, { id, kind, label, live: false, url: opts?.url }] }
    })
    setActiveByWs(prev => ({ ...prev, [wsId]: id }))
    return id
  }, [wsTabs])

  const openTab = useCallback((kind: TabKind, opts?: { url?: string }) => openTabInWorkspace(activeWs, workspaceName, kind, opts), [activeWs, openTabInWorkspace, workspaceName])

  const openPluginTabInWorkspace = useCallback((wsId: string, wsName: string, pluginTab: RegisteredPluginTab, openContext?: PluginOpenContext) => {
    if (!wsId) return undefined
    const singletonId = `${wsId}-plugin-${pluginTab.registrationId.replace(/[^a-z0-9_-]+/gi, '-')}`
    const existingSingleton = pluginTab.singleton
      ? (wsTabs[wsId] ?? []).find(t => t.kind === 'plugin' && t.pluginRegistrationId === pluginTab.registrationId)
      : undefined
    if (existingSingleton) {
      setActiveByWs(prev => ({ ...prev, [wsId]: existingSingleton.id }))
      return existingSingleton.id
    }

    const id = pluginTab.singleton ? singletonId : nextTabId(wsId, 'plugin')

    setWsTabs(prev => {
      const existing = materializeTabList(prev, wsId, wsName)
      const currentSingleton = pluginTab.singleton
        ? existing.find(t => t.kind === 'plugin' && t.pluginRegistrationId === pluginTab.registrationId)
        : undefined
      if (currentSingleton) return { ...prev, [wsId]: existing }
      return {
        ...prev,
        [wsId]: [...existing, {
          id,
          kind: 'plugin',
          label: pluginTab.title,
          live: false,
          pluginId: pluginTab.pluginId,
          pluginTabId: pluginTab.id,
          pluginRegistrationId: pluginTab.registrationId,
          pluginEntry: pluginTab.entry,
          pluginIcon: pluginTab.icon,
          pluginSingleton: pluginTab.singleton === true,
          pluginOpenContext: openContext,
        }],
      }
    })
    setActiveByWs(prev => ({ ...prev, [wsId]: id }))
    return id
  }, [wsTabs])

  const openPluginTab = useCallback((pluginTab: RegisteredPluginTab, openContext?: PluginOpenContext) => openPluginTabInWorkspace(activeWs, workspaceName, pluginTab, openContext), [activeWs, openPluginTabInWorkspace, workspaceName])

  const pinTab = useCallback((tabId: string) => {
    setWsTabs(prev => {
      const list = materializeTabList(prev, activeWs, workspaceName)
      return {
        ...prev,
        [activeWs]: list.map(t => t.id === tabId ? { ...t, pinned: true } : t),
      }
    })
  }, [activeWs, workspaceName])

  const unpinTab = useCallback((tabId: string) => {
    setWsTabs(prev => {
      const list = materializeTabList(prev, activeWs, workspaceName)
      return {
        ...prev,
        [activeWs]: list.map(t => t.id === tabId ? { ...t, pinned: false } : t),
      }
    })
  }, [activeWs, workspaceName])

  const renameTab = useCallback((tabId: string, label: string) => {
    setWsTabs(prev => {
      const list = materializeTabList(prev, activeWs, workspaceName)
      return {
        ...prev,
        [activeWs]: list.map(t => t.id === tabId ? { ...t, label } : t),
      }
    })
  }, [activeWs, workspaceName])

  const setTabColor = useCallback((tabId: string, color: string | undefined) => {
    setWsTabs(prev => {
      const list = materializeTabList(prev, activeWs, workspaceName)
      return {
        ...prev,
        [activeWs]: list.map(t => t.id === tabId ? { ...t, color } : t),
      }
    })
  }, [activeWs, workspaceName])

  const setTabUrl = useCallback((tabId: string, url: string | undefined) => {
    setWsTabs(prev => {
      const next: Record<string, Tab[]> = { ...prev }
      for (const [wsId, list] of Object.entries(prev)) {
        const hasTab = list.some(t => t.id === tabId)
        if (!hasTab) continue
        next[wsId] = list.map(t => t.id === tabId ? { ...t, url } : t)
        break
      }
      return next
    })
  }, [])

  const setBrowserSessionMode = useCallback((tabId: string, browserSessionMode: BrowserSessionMode) => {
    setWsTabs(prev => {
      const next: Record<string, Tab[]> = { ...prev }
      for (const [wsId, list] of Object.entries(prev)) {
        const hasTab = list.some(t => t.id === tabId)
        if (!hasTab) continue
        next[wsId] = list.map(t => t.id === tabId ? { ...t, browserSessionMode } : t)
        break
      }
      return next
    })
  }, [])

  const reorderTab = useCallback((tabId: string, beforeTabId: string | null) => {
    if (!activeWs || tabId === beforeTabId) return
    setWsTabs(prev => {
      const list = materializeTabList(prev, activeWs, workspaceName)
      const moving = list.find(t => t.id === tabId)
      if (!moving || moving.splitCloneOf) return prev

      const without = list.filter(t => t.id !== tabId)
      const beforeIdx = beforeTabId ? without.findIndex(t => t.id === beforeTabId) : -1
      const next = [...without]
      next.splice(beforeIdx >= 0 ? beforeIdx : next.length, 0, moving)
      return { ...prev, [activeWs]: next }
    })
  }, [activeWs, workspaceName])

  const closeSplitGroup = useCallback((groupId: string) => {
    if (!activeWs) return
    setSplitMap(prev => ({
      ...prev,
      [activeWs]: (prev[activeWs] ?? []).filter(group => group.id !== groupId),
    }))
  }, [activeWs])

  const setSplitTab = useCallback((tabId: string | null) => {
    if (!activeWs) return
    if (!tabId) {
      const currentGroup = (splitMap[activeWs] ?? []).find(group => group.tabs.includes(activeTabId))
      if (currentGroup) closeSplitGroup(currentGroup.id)
      return
    }
    if (tabId === activeTabId) return

    const list = materializeTabList(wsTabs, activeWs, workspaceName).filter(tab => !tab.splitCloneOf)
    if (!list.some(t => t.id === activeTabId) || !list.some(t => t.id === tabId)) return

    const groups = splitMap[activeWs] ?? []
    const activeGroup = groups.find(group => group.tabs.includes(activeTabId)) ?? null
    const targetAlreadySplit = groups.some(group => group.tabs.includes(tabId))
    if (targetAlreadySplit) return

    const nextGroup: SplitGroup = activeGroup
      ? { ...activeGroup, tabs: [...new Set([...activeGroup.tabs, tabId])] }
      : { id: `split-${Date.now().toString(36)}-${tabId}`, primary: activeTabId, tabs: [activeTabId, tabId] }

    setWsTabs(prev => {
      const existing = materializeTabList(prev, activeWs, workspaceName)
      // Remove stale split clones created by older split behavior; split now
      // groups existing tabs and supports multiple independent groups.
      return { ...prev, [activeWs]: existing.filter(tab => !tab.splitCloneOf) }
    })
    setSplitMap(prev => {
      const existingGroups = prev[activeWs] ?? []
      const nextGroups = activeGroup
        ? existingGroups.map(group => group.id === activeGroup.id ? nextGroup : group)
        : [...existingGroups, nextGroup]
      return { ...prev, [activeWs]: nextGroups }
    })
    setActiveByWs(prev => prev[activeWs] === nextGroup.primary ? prev : { ...prev, [activeWs]: nextGroup.primary })
  }, [activeTabId, activeWs, closeSplitGroup, splitMap, workspaceName, wsTabs])

  const splitAnchorWithSession = useCallback((
    anchorTabId: string,
    spec: { sessionId: string; ownerTabId: string; label: string },
    ownerActiveSessionId: string | null,
  ): { viewTabId: string; activateOwner: boolean } | null => {
    if (!activeWs || !anchorTabId || !spec.sessionId || !spec.ownerTabId) return null
    const latest = persistedStateRef.current
    const list = materializeTabList(latest.wsTabs, activeWs, workspaceName).filter(tab => !tab.splitCloneOf)
    if (!list.some(tab => tab.id === anchorTabId)) return null
    const groups = latest.splitMap[activeWs] ?? []
    const plan = planSessionSplit({
      sessionId: spec.sessionId,
      ownerTabId: spec.ownerTabId,
      anchorTabId,
      tabs: list,
      splitGroups: groups,
      ownerActiveSessionId,
    })
    if (plan.type === 'noop') return { viewTabId: anchorTabId, activateOwner: false }

    const isWriterOwner = spec.ownerTabId === `${activeWs}-writer` || spec.ownerTabId.startsWith(`${activeWs}-writer-`)
    const incomingId = plan.type === 'reuse' ? plan.tabId : nextTabId(activeWs, 'chat')
    if (incomingId === anchorTabId) return { viewTabId: anchorTabId, activateOwner: false }

    const incomingTab: Tab = plan.type === 'viewport'
      ? {
          id: incomingId,
          kind: 'chat',
          label: spec.label,
          live: false,
          sessionOwnerTabId: spec.ownerTabId,
          pinnedSessionId: spec.sessionId,
        }
      : list.find(tab => tab.id === incomingId) ?? (
        isWriterOwner
          ? { id: incomingId, kind: 'writer', label: KIND_LABEL.writer, live: false }
          : { id: incomingId, kind: 'chat', label: workspaceName, live: false }
      )

    setWsTabs(prev => {
      const existing = materializeTabList(prev, activeWs, workspaceName).filter(tab => !tab.splitCloneOf)
      if (existing.some(tab => tab.id === incomingTab.id)) return prev
      return { ...prev, [activeWs]: [...existing, incomingTab] }
    })
    setSplitMap(prev => {
      const existingGroups = prev[activeWs] ?? []
      if (existingGroups.some(group => group.tabs.includes(incomingId) && !group.tabs.includes(anchorTabId))) {
        return prev
      }
      const activeGroup = existingGroups.find(group => group.tabs.includes(anchorTabId)) ?? null
      if (activeGroup?.tabs.includes(incomingId)) return prev
      const nextGroup: SplitGroup = activeGroup
        ? { ...activeGroup, tabs: insertTabAfter(activeGroup.tabs, anchorTabId, incomingId) }
        : { id: `split-${Date.now().toString(36)}-${incomingId}`, primary: anchorTabId, tabs: [anchorTabId, incomingId] }
      const nextGroups = activeGroup
        ? existingGroups.map(group => group.id === activeGroup.id ? nextGroup : group)
        : [...existingGroups, nextGroup]
      return { ...prev, [activeWs]: nextGroups }
    })
    const primary = groups.find(group => group.tabs.includes(anchorTabId))?.primary ?? anchorTabId
    setActiveByWs(prev => prev[activeWs] === primary ? prev : { ...prev, [activeWs]: primary })
    return {
      viewTabId: incomingId,
      activateOwner: plan.type === 'reuse' && incomingId === spec.ownerTabId,
    }
  }, [activeWs, workspaceName])

  const restoreChatTabInWorkspace = useCallback((wsId: string, wsName: string, tabId: string) => {
    if (!wsId || !tabId) return
    setWsTabs(prev => {
      const list = materializeTabList(prev, wsId, wsName)
      if (list.some(t => t.id === tabId)) return prev
      // Closed chat tabs are just hidden from the tab strip; drawer activation
      // rehydrates the same tab id so its saved sessions and bridges keep routing.
      // Writer tabs own chat sessions too, so restore them as writer tabs or the
      // rehydrated tab renders the wrong surface for its own id.
      const isWriter = tabId === `${wsId}-writer` || tabId.startsWith(`${wsId}-writer-`)
      const restored: Tab = isWriter
        ? { id: tabId, kind: 'writer', label: KIND_LABEL.writer, live: false }
        : { id: tabId, kind: 'chat', label: wsName, live: false }
      return { ...prev, [wsId]: [...list, restored] }
    })
    setActiveByWs(prev => prev[wsId] === tabId ? prev : { ...prev, [wsId]: tabId })
  }, [])

  const closeTabInWorkspace = useCallback((wsId: string, tabId: string) => {
    const list = wsTabs[wsId] ?? []
    const tab = list.find(t => t.id === tabId)
    if (tab?.pinned) return

    const currentSplit = splitMap[wsId]
    const removeIds = new Set([tabId])
    const splitGroup = currentSplit?.find(group => group.tabs.includes(tabId)) ?? null
    const splitSiblings = splitGroup?.tabs.filter(id => id !== tabId && list.some(tab => tab.id === id)) ?? []

    const remaining = list.filter(t => !removeIds.has(t.id))
    setWsTabs(prev => ({
      ...prev,
      [wsId]: remaining,
    }))
    if (splitGroup) {
      setSplitMap(prev => ({
        ...prev,
        [wsId]: (prev[wsId] ?? []).flatMap(group => {
          if (group.id !== splitGroup.id) return [group]
          const nextTabs = group.tabs.filter(id => id !== tabId)
          return nextTabs.length >= 2
            ? [{ ...group, primary: nextTabs.includes(group.primary) ? group.primary : nextTabs[0], tabs: nextTabs }]
            : []
        }),
      }))
    }
    const currentActive = activeByWs[wsId]
    if (currentActive && removeIds.has(currentActive)) {
      const nextActive = splitSiblings[0] ?? remaining[remaining.length - 1]?.id ?? `${wsId}-chat`
      setActiveByWs(prev => prev[wsId] === nextActive ? prev : { ...prev, [wsId]: nextActive })
    }
  }, [activeByWs, splitMap, wsTabs])

  const closeTab = useCallback((tabId: string) => closeTabInWorkspace(activeWs, tabId), [activeWs, closeTabInWorkspace])

  // Persist tabs, active tab per workspace, and split state. Structural changes
  // (a tab added or removed) persist IMMEDIATELY: messages are written to their
  // own store the instant a tab is used, and the startup prune deletes any
  // message scope whose tab isn't in wsTabs. Debouncing the tab record opened a
  // window where an abrupt Electron quit (which doesn't reliably deliver the
  // unload flush below) left a fresh conversation's messages orphaned and the
  // prune wiped them. Non-structural churn (active tab, labels) stays debounced.
  const structuralTabSig = useMemo(
    () => Object.entries(wsTabs)
      .map(([wsId, list]) => `${wsId}:${list.map(t => t.id).join(',')}`)
      .sort()
      .join('|'),
    [wsTabs],
  )
  const lastStructuralSigRef = useRef(structuralTabSig)
  useEffect(() => {
    const flushNow = structuralTabSig !== lastStructuralSigRef.current
    lastStructuralSigRef.current = structuralTabSig
    if (flushNow) {
      const latest = persistedStateRef.current
      persistWorkspaceTabs(latest.wsTabs, latest.activeByWs, latest.splitMap)
      return
    }
    const timeout = window.setTimeout(() => {
      const latest = persistedStateRef.current
      persistWorkspaceTabs(latest.wsTabs, latest.activeByWs, latest.splitMap)
    }, 120)
    return () => window.clearTimeout(timeout)
  }, [wsTabs, activeByWs, splitMap, structuralTabSig])

  useEffect(() => {
    const flush = () => {
      const latest = persistedStateRef.current
      persistWorkspaceTabs(latest.wsTabs, latest.activeByWs, latest.splitMap)
    }
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush()
    }

    // Navigation-away must be lossless even though normal writes are debounced.
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

  const allTabIds = useMemo(() => {
    const ids = new Set<string>()
    for (const list of Object.values(wsTabs)) {
      for (const t of list) ids.add(t.id)
    }
    return ids
  }, [wsTabs])

  // Flat tabId → tab info across every workspace, so callers (e.g. the drawer's
  // cross-workspace session list) can resolve a tab's kind/label/owner without
  // the active-workspace-only `tabs` view.
  const tabInfoById = useMemo(() => {
    const map: Record<string, { kind: TabKind; label: string; wsId: string }> = {}
    for (const [wsId, list] of Object.entries(wsTabs)) {
      for (const t of list) map[t.id] = { kind: t.kind, label: t.label, wsId }
    }
    return map
  }, [wsTabs])

  return useMemo(() => ({
    tabs, activeTab, activeTabId, setActiveTabId, setActiveTabInWorkspace, getActiveTabIdForWorkspace, selectWorkspace, openTab, openTabInWorkspace, openPluginTab, openPluginTabInWorkspace, restoreChatTabInWorkspace, closeTab, closeTabInWorkspace,
    splitGroups, splitTabId, splitTabIds, splitPrimaryTabId, setSplitTab, splitAnchorWithSession, closeSplitGroup, pinTab, unpinTab, renameTab, setTabColor, setTabUrl,
    setBrowserSessionMode, reorderTab, allTabIds, tabInfoById,
  }), [tabs, activeTab, activeTabId, setActiveTabId, setActiveTabInWorkspace, getActiveTabIdForWorkspace, selectWorkspace, openTab, openTabInWorkspace, openPluginTab, openPluginTabInWorkspace, restoreChatTabInWorkspace, closeTab, closeTabInWorkspace,
    splitGroups, splitTabId, splitTabIds, splitPrimaryTabId, setSplitTab, splitAnchorWithSession, closeSplitGroup, pinTab, unpinTab, renameTab, setTabColor, setTabUrl,
    setBrowserSessionMode, reorderTab, allTabIds, tabInfoById])
}

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'

import { Icon } from './Icon'
import { getCrewCodeRuntime } from '../../runtime/crewcode-client'
import { AgentActivityIndicator, type AgentActivityState } from './AgentActivityIndicator'
import { AppMenu, type AppMenuAction } from './AppMenu'
import { TabContextMenu } from './TabContextMenu'
import { TAB_COLOR_PALETTE, type BuiltinTabKind, type Tab, type TabKind } from '../../types'
import type { CrewSessionState } from '../../orchestrator/crew-session'
import { PROVIDER_IMAGES, providerImageClass } from '../composer/provider-meta'

export interface WindowTabPluginMenuItem {
  id: string
  pluginId: string
  title: string
  icon?: string
  kind: 'sidebarPanel' | 'tab'
  target: { pluginId: string; sidebarPanel?: string; tab?: string; command?: string }
}

interface WindowTab extends Tab {
  displayIconProviderId?: string
  agentActivity?: AgentActivityState
}

interface WindowTabsProps {
  tabs: WindowTab[]
  activeId: string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  /** Handles app-level actions from the AppMenu (palette, workspaces, etc.). */
  onAppMenuAction: (a: AppMenuAction) => void
  /** Active tab's kind — used by AppMenu to highlight the current destination. */
  activeKind?: TabKind
  /** Footer line for the menu, e.g. "aura@cortex · 3 active sessions". */
  appMenuFootStatus?: string
  /** tab id → crew state, for tabs hosting a crew — drives the distinct styling. */
  crewTabs: Record<string, CrewSessionState>
  splitGroups?: Array<{ id: string; tabs: string[] }>
  splitTabIds?: string[]
  splitPrimaryTabId?: string | null
  onSplit?: (tabId: string | null) => void
  onCloseSplitGroup?: (groupId: string) => void
  onPin?: (tabId: string) => void
  onUnpin?: (tabId: string) => void
  onRename?: (tabId: string, label: string) => void
  onColor?: (tabId: string, color: string | undefined) => void
  onReorder?: (tabId: string, beforeTabId: string | null) => void
  pluginMenuItems?: WindowTabPluginMenuItem[]
  onPluginMenuItem?: (item: WindowTabPluginMenuItem) => void
  onNewTabMenuOpenChange?: (open: boolean) => void
}

const TAB_ICONS: Record<TabKind, string> = {
  chat: 'threads', crew: 'crew', canvas: 'grid', git: 'gitBranch', code: 'code', writer: 'edit', terminal: 'terminal',
  browser: 'globe', settings: 'settings', plugins: 'plug', prompts: 'sparkle', mission: 'grid', archive: 'archive', plugin: 'grid',
}

const PIN_ACCENT_IDS = TAB_COLOR_PALETTE.filter(entry => entry.id !== 'none')

export const NEW_TAB_ACTIONS: Array<{ kind: BuiltinTabKind; icon: string; label: string }> = [
  { kind: 'chat', icon: 'threads', label: 'Chat' },
  { kind: 'terminal', icon: 'terminal', label: 'Terminal' },
  { kind: 'browser', icon: 'globe', label: 'Browser' },
  { kind: 'canvas', icon: 'workbench', label: 'Workbench Mode' },
  { kind: 'code', icon: 'code', label: 'Code Editor' },
  { kind: 'writer', icon: 'edit', label: 'Writers workspace' },
  { kind: 'crew', icon: 'crew', label: 'CrewCode Workers' },
  { kind: 'mission', icon: 'grid', label: 'Control Center' },
  { kind: 'prompts', icon: 'inspection', label: 'Skills & Prompts Studio' },
  { kind: 'git', icon: 'gitBranch', label: 'Git Workspace' },
]

function fallbackPinColor(tabId: string): string {
  let hash = 0
  for (let i = 0; i < tabId.length; i++) hash = ((hash << 5) - hash) + tabId.charCodeAt(i)
  return PIN_ACCENT_IDS[Math.abs(hash) % PIN_ACCENT_IDS.length].value
}

const COLOR_VALUES = new Map<string, string>(TAB_COLOR_PALETTE.map(entry => [entry.id, entry.value]))

interface WindowTabItemProps {
  tab: WindowTab
  displayLabel: string
  active: boolean
  crewState?: CrewSessionState
  split: boolean
  splitGroupId?: string
  colorValue?: string
  pinAccent?: string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onCloseSplitGroup?: (groupId: string) => void
  dragging: boolean
  dropTarget: boolean
  draggable: boolean
  onDragStart: (tabId: string, e: DragEvent<HTMLDivElement>) => void
  onDragOver: (tabId: string, e: DragEvent<HTMLDivElement>) => void
  onDrop: (tabId: string, e: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onContextMenu: (x: number, y: number, tab: Tab) => void
}

const WindowTabItem = memo(function WindowTabItem({
  tab, displayLabel, active, crewState, split, splitGroupId, colorValue, pinAccent,
  dragging, dropTarget, draggable, onDragStart, onDragOver, onDrop, onDragEnd,
  onActivate, onClose, onCloseSplitGroup, onContextMenu,
}: WindowTabItemProps) {
  const isCrew = !!crewState
  const providerIcon = !isCrew && tab.displayIconProviderId ? PROVIDER_IMAGES[tab.displayIconProviderId] : undefined
  const crewDot =
    crewState === 'active'                                          ? 'active'
    : crewState === 'error'                                          ? 'error'
    : (crewState === 'configuring' || crewState === 'provisioning')  ? 'setup'
    : null

  return (
    <div
      data-tab-id={tab.id}
      className={`wintab ${active ? 'on' : ''} ${isCrew ? 'is-crew' : ''} ${crewState === 'error' ? 'has-error' : ''} ${tab.pinned ? 'pinned' : ''} ${split ? 'split' : ''} ${dragging ? 'dragging' : ''} ${dropTarget ? 'drop-before' : ''} ${tab.color ? `color-${tab.color}` : ''}`}
      draggable={draggable}
      onDragStart={(e) => onDragStart(tab.id, e)}
      onDragOver={(e) => onDragOver(tab.id, e)}
      onDrop={(e) => onDrop(tab.id, e)}
      onDragEnd={onDragEnd}
      onClick={() => onActivate(tab.id)}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(e.clientX, e.clientY, tab)
      }}
      title={isCrew ? `crew · ${crewState}` : undefined}
    >
      {tab.pinned && <span className="tab-pin-accent" style={{ background: pinAccent }} />}
      {colorValue && <span className="tab-color-indicator" style={{ background: colorValue }} />}
      <AgentActivityIndicator state={tab.agentActivity} className="wintab-agent-activity" />
      {providerIcon
        ? <img src={providerIcon} alt={tab.displayIconProviderId ?? 'provider'} className={`wintab-provider-icon ${providerImageClass(tab.displayIconProviderId ?? '')}`} />
        : <Icon name={isCrew ? 'crew' : (TAB_ICONS[tab.kind] as any)} size={11} />}
      {crewDot && <span className={`tab-crew-dot dot-${crewDot}`} />}
      {tab.live && !isCrew && <span className="tab-live" />}
      <span className="wintab-label">{displayLabel}</span>
      {!tab.pinned && (
        <span
          className="close"
          title={split ? 'close split view' : 'close tab'}
          onClick={(e) => {
            e.stopPropagation()
            if (splitGroupId) onCloseSplitGroup?.(splitGroupId)
            else onClose(tab.id)
          }}
        >✕</span>
      )}
    </div>
  )
})

export const WindowTabs = memo(function WindowTabs({
  tabs, activeId, onActivate, onClose,
  onAppMenuAction, activeKind, appMenuFootStatus, crewTabs,
  splitGroups = [], splitTabIds = [], splitPrimaryTabId, onSplit, onCloseSplitGroup, onPin, onUnpin, onRename, onColor, onReorder,
  pluginMenuItems = [], onPluginMenuItem, onNewTabMenuOpenChange,
}: WindowTabsProps) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tab: Tab } | null>(null)
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<string | 'end' | null>(null)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const newMenuRef = useRef<HTMLDivElement>(null)
  const tabsScrollRef = useRef<HTMLDivElement>(null)

  const tabsById = useMemo(() => new Map(tabs.map(tab => [tab.id, tab])), [tabs])
  // Number Workbench Mode tabs by open order, but only once a second one exists,
  // so a lone Workbench tab stays unnumbered. Derived (not stored) so closing one
  // renumbers the rest instead of leaving a gap.
  const canvasNumberById = useMemo(() => {
    const canvasTabs = tabs.filter(tab => tab.kind === 'canvas')
    const map = new Map<string, number>()
    if (canvasTabs.length > 1) canvasTabs.forEach((tab, i) => map.set(tab.id, i + 1))
    return map
  }, [tabs])
  const splitIds = useMemo(() => new Set(splitGroups.flatMap(group => group.tabs)), [splitGroups])
  const splitGroupTabs = useMemo(() => splitGroups.map(group => ({
    id: group.id,
    tabs: group.tabs.map(id => tabsById.get(id)).filter((tab): tab is WindowTab => !!tab),
  })).filter(group => group.tabs.length >= 2), [splitGroups, tabsById])
  const { pinnedTabs, unpinnedTabs } = useMemo(() => {
    const pinned: WindowTab[] = []
    const unpinned: WindowTab[] = []
    for (const tab of tabs) {
      if (splitIds.has(tab.id) || tab.splitCloneOf) continue
      ;(tab.pinned ? pinned : unpinned).push(tab)
    }
    return { pinnedTabs: pinned, unpinnedTabs: unpinned }
  }, [tabs, splitIds])
  const separatorLabel = pinnedTabs.length > 0 && unpinnedTabs.length > 0

  const handleTabContextMenu = useCallback((x: number, y: number, tab: Tab) => {
    setCtxMenu({ x, y, tab })
  }, [])

  useEffect(() => {
    onNewTabMenuOpenChange?.(newMenuOpen)
  }, [newMenuOpen, onNewTabMenuOpenChange])

  useEffect(() => () => onNewTabMenuOpenChange?.(false), [onNewTabMenuOpenChange])

  useEffect(() => {
    if (!newMenuOpen) return
    const onMouseDown = (e: MouseEvent): void => {
      if (newMenuRef.current && !newMenuRef.current.contains(e.target as Node)) setNewMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setNewMenuOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [newMenuOpen])

  useEffect(() => {
    const scrollEl = tabsScrollRef.current
    if (!scrollEl || splitTabIds.includes(activeId)) return
    const activeTabEl = scrollEl.querySelector<HTMLElement>(`.wintab[data-tab-id="${CSS.escape(activeId)}"]`)
    if (!activeTabEl) return
    // Keep activation snappy: smooth scrolling made tab switches feel delayed.
    activeTabEl.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' })
  }, [activeId, splitTabIds])

  // React registers onWheel as a passive listener, so preventDefault() throws.
  // Attach natively with { passive: false } to translate vertical wheel into
  // horizontal tab scroll without that warning.
  useEffect(() => {
    const scrollEl = tabsScrollRef.current
    if (!scrollEl) return
    const onWheel = (e: globalThis.WheelEvent): void => {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      if (delta === 0 || scrollEl.scrollWidth <= scrollEl.clientWidth) return
      scrollEl.scrollLeft += delta
      e.preventDefault()
    }
    scrollEl.addEventListener('wheel', onWheel, { passive: false })
    return () => scrollEl.removeEventListener('wheel', onWheel)
  }, [])

  const handleDragStart = useCallback((tabId: string, e: DragEvent<HTMLDivElement>) => {
    if (!onReorder) return
    setDraggingTabId(tabId)
    setDropTarget(null)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', tabId)
  }, [onReorder])

  const handleDragOverTab = useCallback((tabId: string, e: DragEvent<HTMLDivElement>) => {
    if (!onReorder || !draggingTabId || draggingTabId === tabId) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDropTarget(tabId)
  }, [draggingTabId, onReorder])

  const handleDropOnTab = useCallback((tabId: string, e: DragEvent<HTMLDivElement>) => {
    if (!onReorder) return
    e.preventDefault()
    e.stopPropagation()
    const dragged = e.dataTransfer.getData('text/plain') || draggingTabId
    if (dragged && dragged !== tabId) onReorder(dragged, tabId)
    setDraggingTabId(null)
    setDropTarget(null)
  }, [draggingTabId, onReorder])

  const handleDropAtEnd = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!onReorder || !draggingTabId) return
    e.preventDefault()
    const dragged = e.dataTransfer.getData('text/plain') || draggingTabId
    if (dragged) onReorder(dragged, null)
    setDraggingTabId(null)
    setDropTarget(null)
  }, [draggingTabId, onReorder])

  const handleDragEnd = useCallback(() => {
    setDraggingTabId(null)
    setDropTarget(null)
  }, [])

  const renderTab = (tab: WindowTab, splitGroupId?: string) => {
    const colorValue = tab.color ? COLOR_VALUES.get(tab.color) : undefined
    const canvasNumber = canvasNumberById.get(tab.id)
    // Canvas tabs render a canonical base label so pre-rename ('Canvas') persisted
    // tabs also show 'Workbench Mode'; the order number appends only when >1 exist.
    const baseLabel = tab.kind === 'canvas' ? 'Workbench Mode' : tab.label
    const displayLabel = canvasNumber ? `${baseLabel} ${canvasNumber}` : baseLabel
    return (
      <WindowTabItem
        key={tab.id}
        tab={tab}
        displayLabel={displayLabel}
        active={activeId === tab.id}
        crewState={crewTabs[tab.id]}
        split={splitIds.has(tab.id)}
        splitGroupId={splitGroupId}
        colorValue={colorValue}
        pinAccent={tab.pinned ? (colorValue ?? fallbackPinColor(tab.id)) : undefined}
        dragging={draggingTabId === tab.id}
        dropTarget={dropTarget === tab.id}
        draggable={!!onReorder}
        onDragStart={handleDragStart}
        onDragOver={handleDragOverTab}
        onDrop={handleDropOnTab}
        onDragEnd={handleDragEnd}
        onActivate={onActivate}
        onClose={onClose}
        onCloseSplitGroup={onCloseSplitGroup}
        onContextMenu={handleTabContextMenu}
      />
    )
  }
  return (
    <>
      {/* Brand strip — dedicated row for the CrewCode mark and window controls.
          Split off from the tab strip so the logo can scale up without
          inflating tab height. This row is the drag region. */}
      <div className="titlebar">
        <AppMenu
          activeKind={activeKind}
          footStatus={appMenuFootStatus}
          onPick={onAppMenuAction}
        />
        <div className="titlebar-spacer" />
        {getCrewCodeRuntime().kind === 'electron' && (
          <div className="winrt">
            <div className="winctrl" onClick={() => window.electronAPI?.minimize()}><Icon name="min" size={14} stroke={1.5} /></div>
            <div className="winctrl" onClick={() => window.electronAPI?.maximize()}><Icon name="max" size={11} stroke={1.5} /></div>
            <div className="winctrl close" onClick={() => window.electronAPI?.close()}><Icon name="close" size={14} stroke={1.5} /></div>
          </div>
        )}
      </div>

    <div className="wintabs">
      <div className="tabs-scroll" ref={tabsScrollRef}>
        <div
          className={`tabs tabs-main ${dropTarget === 'end' ? 'drop-end' : ''}`}
          onDragOver={(e) => {
            if (!onReorder || !draggingTabId) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (!(e.target as HTMLElement).closest('.wintab')) setDropTarget('end')
          }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null) }}
          onDrop={handleDropAtEnd}
        >
          {pinnedTabs.map(tab => renderTab(tab))}
          {separatorLabel && <div className="wintab-divider" aria-hidden="true"><span /></div>}
          {unpinnedTabs.map(tab => renderTab(tab))}
        </div>
      </div>

      <div className="tab-add-wrap tab-add-fixed" ref={newMenuRef}>
        <button
          type="button"
          className={`wintab-add ${newMenuOpen ? 'open' : ''}`}
          onClick={() => setNewMenuOpen(open => !open)}
          title="Open new tab menu"
          aria-label="Open new tab menu"
          aria-haspopup="menu"
          aria-expanded={newMenuOpen}
        >
          <Icon name="plus" size={14} stroke={2} />
        </button>
        {newMenuOpen && (
          <div className="tab-menu" role="menu" aria-label="New tab">
            {NEW_TAB_ACTIONS.map(item => (
              <button
                key={item.kind}
                type="button"
                className="tab-menu-item"
                role="menuitem"
                onClick={() => {
                  setNewMenuOpen(false)
                  onAppMenuAction({ kind: 'open-tab', tab: item.kind })
                }}
              >
                <Icon name={item.icon as any} size={14} />
                <span>{item.label}</span>
              </button>
            ))}
            {pluginMenuItems.length > 0 && (
              <>
                <div className="tab-menu-section" role="separator">plugins</div>
                {pluginMenuItems.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    className="tab-menu-item"
                    role="menuitem"
                    title={`${item.title} · ${item.pluginId}`}
                    onClick={() => {
                      setNewMenuOpen(false)
                      onPluginMenuItem?.(item)
                    }}
                  >
                    <Icon name={(item.icon as any) ?? (item.kind === 'tab' ? 'grid' : 'sidebar')} size={14} />
                    <span>{item.title}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      {splitGroupTabs.length > 0 && (
        // Split groups stay outside the scroll lane so a long main tab list
        // can't shove active split-view tabs off the visible strip.
        <div className="tabs split-tab-groups">
          <div className="wintab-divider split-divider" aria-hidden="true"><span /></div>
          {splitGroupTabs.map((group, idx) => (
            <Fragment key={group.id}>
              {idx > 0 && <div className="wintab-divider split-group-divider" aria-hidden="true"><span /></div>}
              <div className="split-tab-group" aria-label="split tabs">
                {group.tabs.map(tab => renderTab(tab, group.id))}
              </div>
            </Fragment>
          ))}
        </div>
      )}

      {ctxMenu && onPin && onUnpin && onRename && onColor && (
        <TabContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          tabId={ctxMenu.tab.id}
          label={ctxMenu.tab.label}
          pinned={!!ctxMenu.tab.pinned}
          color={ctxMenu.tab.color}
          canSplit={!!onSplit && activeId !== ctxMenu.tab.id && !splitIds.has(ctxMenu.tab.id) && !ctxMenu.tab.splitCloneOf && !['settings', 'prompts', 'mission', 'archive'].includes(ctxMenu.tab.kind)}
          onRename={onRename}
          onColor={onColor}
          onPin={onPin}
          onUnpin={onUnpin}
          onSplit={(tabId) => onSplit?.(tabId)}
          onClose={onClose}
          onCloseMenu={() => setCtxMenu(null)}
        />
      )}

    </div>
    </>
  )
})

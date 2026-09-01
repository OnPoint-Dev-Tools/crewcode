import { Fragment, useState, useEffect, useMemo, useRef, useCallback, startTransition } from 'react'

import { WindowTabs, type WindowTabPluginMenuItem } from './components/ui/WindowTabs'
import { TooltipHost } from './components/ui/TooltipHost'
import { TermColumn }       from './components/terminal/TermColumn'
import { WorkspacesDrawer, type CompletedChatEntry, type WorkingChatEntry } from './components/workspaces/WorkspacesDrawer'
import type { AppMenuAction } from './components/ui/AppMenu'
import { WorkspaceDock } from './components/workspaces/WorkspaceDock'
import { AddProjectModal }  from './components/workspaces/AddProjectModal'
import { EmptyWorkspaceState } from './components/workspaces/EmptyWorkspaceState'
import { CodeEditor }       from './components/editor/CodeEditor'
import { WriterWorkspace }   from './components/writer/WriterWorkspace'
import { BrowserTab }       from './components/browser/BrowserTab'
import { BrowserGrabSendModal, type BrowserGrabChatTarget } from './components/browser/BrowserGrabSendModal'
import { formatBrowserGrabForChat } from './components/browser/browser-grab-format'
import { CommandPalette }   from './components/CommandPalette'
import { GitSidebar }       from './components/git/GitSidebar'
import { GitAuthModal }     from './components/git/GitAuthModal'
import { GitSigningModal }  from './components/git/GitSigningModal'
import { GitPage }          from './components/git/GitPage'
import { NEW_CHAT_TARGET }  from './components/git/git-state'
import { CrewConfirmDialog } from './components/crew/CrewConfirmDialog'
import { CrewDiffView }      from './components/crew/CrewDiffView'
import { CrewGitSidebar }    from './components/crew/CrewGitSidebar'
import { SettingsScreen }   from './components/settings/SettingsScreen'
import { PromptBuilder }    from './components/promptBuilder/PromptBuilder'
import { MissionDataProvider, MissionControlHost, MenuletHost, MissionActivitySheetHost } from './components/mission/MissionDataContext'
import { PluginTabHost } from './components/plugins/PluginTabHost'
import { PluginsPage } from './components/plugins/PluginsPage'
import { ArchivePage, type ArchivedEntry } from './components/archive/ArchivePage'
import { SystemMonitorMount, type TerminalDaemon } from './components/system/SystemMonitor'
import { PromptPicker }     from './components/promptBuilder/PromptPicker'
import { usePromptLibrary } from './hooks/usePromptLibrary'
import { useCrewcodePromptFiles } from './hooks/useCrewcodePromptFiles'
import { useAppliedSkillsBySession } from './hooks/useAppliedSkillsBySession'
import { useAppliedModesBySession } from './hooks/useAppliedModesBySession'
import { chatSessionOwnerWorkspaceId } from './hooks/chat-session-tab-owner'
import { isSessionViewTab, type SessionDragPayload } from './components/thread/session-drag'
import type { Prompt as PromptDef, Skill as SkillDef } from './types/prompts'
import { Icon }             from './components/ui/Icon'
import { LoadingScreen }    from './components/ui/LoadingScreen'
import { MobileShell, useMobileShell } from './components/ui/MobileShell'
import type { AgentActivityState } from './components/ui/AgentActivityIndicator'
import { Onboarding }       from './components/onboarding/Onboarding'
import { NotificationBar }  from './components/ui/NotificationBar'
import { DialogHost }       from './components/ui/DialogHost'
import { ChatContextMenu }  from './components/chat/ChatContextMenu'
import type { ChatContextMenuItem } from './components/chat/ChatContextMenu'
import { CanvasMode, type CanvasPaneKind } from './components/canvas/CanvasMode'
import { ChatPane }        from './components/chat/ChatPane'
import { Splitter }         from './components/chat/Splitter'
import { SoloChatView }     from './components/chat/SoloChatView'
import { CrewBranch }       from './components/chat/CrewBranch'
import {
  TweaksPanel, TweakSection, TweakRadio, TweakSlider, TweakButton
} from './components/TweaksPanel'

import { useTweaks }      from './hooks/useTweaks'
import { useSettings, getCurrentSettings, effectiveShell } from './hooks/useSettings'
import { useUpdaterNotices } from './hooks/useUpdaterNotices'
import { requestSettingsSection } from './components/settings/settings-section-focus'
import { useMcpFileServers } from './hooks/useMcpFileServers'
import { mergeMcpServers } from './hooks/session-mcp-selection'
import { useNotifications } from './hooks/useNotifications'
import { useSettingsEffects } from './hooks/useSettingsEffects'
import { useWorkspaces }  from './hooks/useWorkspaces'
import { useBridgeRegistry } from './hooks/useBridgeRegistry'
import { useWorkspaceTabs } from './hooks/useWorkspaceTabs'
import { useGitSidebar, type GitAuthCredentials, type GitAuthRequest, type GitSigningRequest } from './hooks/useGitSidebar'
import { titleFromFirstMessage, useChatSessions } from './hooks/useChatSessions'
import { useMessagesStore } from './stores/chat-messages-store'
import { delegationInbox } from './stores/delegation-inbox-store'
import { useCrewOrchestration } from './hooks/useCrewOrchestration'
import { sendChatSessionPrompt } from './hooks/chat-session-send'
import { useDelegatedThreads } from './hooks/useDelegatedThreads'
import { useDelegationReports } from './hooks/useDelegationReports'
import { describeProviders } from './hooks/delegation-provider-selection'
import { workspaceForChatTab } from './hooks/chat-tab-workspace-lookup'
import { branchSuffix, delegatedBranchName } from './hooks/delegated-worktree-naming'
import { knownModelIds } from './hooks/useProviderModels'
import { dockUsageProviderId } from './hooks/dock-usage-provider'
import { ChatNotifications } from './components/thread/ChatNotifications'
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts'
import { useMobileWindowTabsAutoHide } from './hooks/useMobileWindowTabsAutoHide'
import { LOCAL_SHORTCUTS, effectiveChord, matchesChord, type ActionId } from './shortcuts'
import { useTerminalSessions } from './hooks/useTerminalSessions'
import { useTerminalUnreadSync, useClearPane } from './stores/terminal-unread-store'
import { isYuHeardPaneFocused, useYuHeardSync } from './stores/yuheard-store'
import { tabKindAllowsYuHeard } from '../../shared/yuheard-types'
import { composerDraftActions } from './stores/composer-draft-store'
import { useUserRequestsByTab } from './stores/bridge-activity-store'
import { useCompletedChats } from './hooks/useCompletedChats'
import {
  EMPTY_WORKSPACE_NAVIGATION_HISTORY,
  moveInTabHistory,
  moveInWorkspaceHistory,
  recordTabVisit,
  recordWorkspaceVisit,
} from './workspace-navigation-history'
import { useCodeEditorSessions } from './hooks/useEditorSessions'
import { terminalTabDisplay } from './terminal-tab-display'
import { playNotificationSound, usesNativeNotificationSound } from './notifications/notification-sounds'
import { playSelectionSpeech, useSelectionSpeechState } from './voice/selection-speech-playback'
import { resolveSelectedWorktree, worktreeSelectionKey } from './surface-worktree-selection'
import { isSurfaceOpen, setSurfaceOpen, type SurfaceOpenState } from './surface-ui-state'
import { getCrewCodeClient } from './runtime/crewcode-client'

import type { Message, TweakConfig, AgentInfo, AgentProviderId, ModeLevel, Session, Tab, GitHubStatus, Command } from './types'
import type { PluginOpenContext, RegisteredPluginBrowserAction, RegisteredPluginChatAction, RegisteredPluginChatHeaderItem, RegisteredPluginEditorAction, RegisteredPluginGitLens, RegisteredPluginMissionWidget, RegisteredPluginSidebarPanel, RegisteredPluginStatusItem, RegisteredPluginTab, RegisteredPluginTerminalWatcher } from '../../shared/plugin-types'
import type { BrowserGrabSelectionPayload } from '../../shared/browser-grab-types'
import type { Mode } from './components/composer/ModeSegment'
import type { EffortLevel } from './components/composer/EffortPicker'
import { TWEAK_DEFAULTS, MODE_FROM_SETTINGS, MODE_TO_LEVEL, EMPTY_WS, normalizeModeLevel } from './app-constants'

interface PendingBrowserGrabSend {
  selection: BrowserGrabSelectionPayload
}

function selectedTextWithin(container: HTMLElement): string {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return ''
  const common = selection.getRangeAt(0).commonAncestorContainer
  const commonElement = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement
  return commonElement && container.contains(commonElement) ? selection.toString().trim() : ''
}

interface CanvasPaneState {
  id: string
  kind: CanvasPaneKind
  title: string
}

const ACTIVE_WORKSPACE_STORAGE = 'crewcode:activeWorkspaceId'
const SURFACE_WORKTREE_STORAGE = 'crewcode:surfaceWorktreeIds:v1'
const GIT_OPEN_STORAGE = 'crewcode:gitOpenByTab:v1'
const GIT_WIDTH_STORAGE = 'crewcode:gitWidthByTab:v1'
const CHAT_UI_STORAGE = 'crewcode:chatUiByTab:v1'
const WORKBENCH_PANES_STORAGE = 'crewcode:workbenchPanesByTab:v1'
const CHANGES_DRAWER_STORAGE = 'crewcode:changesDrawerOpenBySurface:v1'
const MOBILE_DRAWER_SIDE_STORAGE = 'crewcode:mobileDrawerSide:v1'

function readLastActiveWorkspaceId(): string {
  try { return localStorage.getItem(ACTIVE_WORKSPACE_STORAGE) ?? '' } catch { return '' }
}

function writeLastActiveWorkspaceId(wsId: string): void {
  try { localStorage.setItem(ACTIVE_WORKSPACE_STORAGE, wsId) } catch { /* non-fatal */ }
}

function readStoredJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function writeStoredJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* quota — non-fatal */ }
}

function useLocalStorageJsonState<T>(key: string, fallback: T) {
  const [state, setState] = useState<T>(() => readStoredJson(key, fallback))
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    writeStoredJson(key, state)
  }, [key, state])

  useEffect(() => {
    const flush = () => writeStoredJson(key, stateRef.current)
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush()
    }

    // Flush on navigation boundaries so tab/workspace switches and fast window
    // closes don't strand the latest composer/sidebar state in React memory.
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
  }, [key])

  return [state, setState] as const
}

function now(): string {
  const d = new Date()
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function latestFinalAgentReply(messages: Message[], turnId?: string): Extract<Message, { kind: 'agent' }> | null {
  let reply: Extract<Message, { kind: 'agent' }> | null = null
  let lastAssistantKind: 'agent' | 'thinking' | 'toolcall' | null = null

  for (const msg of messages) {
    const msgTurnId = 'turnId' in msg ? msg.turnId : undefined
    if (turnId && msgTurnId !== turnId) continue
    if (msg.kind === 'agent') {
      if (msg.text?.trim()) reply = msg
      lastAssistantKind = 'agent'
      continue
    }
    if (msg.kind === 'thinking' || msg.kind === 'toolcall') {
      lastAssistantKind = msg.kind
    }
  }

  // A turn that ends on reasoning/tool output has no user-facing final reply.
  // This keeps notification previews restricted to completed assistant text.
  if (!reply || reply.streaming || lastAssistantKind !== 'agent') return null
  return reply
}

function replyPreview(text: string): string {
  const compact = text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return compact.length > 180 ? `${compact.slice(0, 177).trimEnd()}…` : compact
}

function buildKeydownFromChord(chord: string[]): KeyboardEvent | null {
  if (chord.length === 0) return null
  const isMac = navigator.userAgent.includes('Mac')
  const meta  = chord.includes('⌘') && isMac
  const ctrl  = chord.includes('⌃') || (chord.includes('⌘') && !isMac)
  const alt   = chord.includes('⌥')
  const shift = chord.includes('⇧')
  // Main key is the last token that isn't a modifier glyph.
  let main = ''
  for (const ch of chord) {
    if (ch !== '⌘' && ch !== '⌃' && ch !== '⌥' && ch !== '⇧') main = ch
  }
  if (!main) return null
  const key =
      main === '↵' ? 'Enter'
    : main === '⇥' ? 'Tab'
    : main === '⌫' ? 'Backspace'
    : main.length === 1 ? main.toLowerCase()
    : main
  return new KeyboardEvent('keydown', {
    key, metaKey: meta, ctrlKey: ctrl, altKey: alt, shiftKey: shift,
    bubbles: true, cancelable: true,
  })
}

export default function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS)
  const { state: settings, set: setSetting } = useSettings()
  const { show } = useNotifications()
  const selectionSpeech = useSelectionSpeechState()
  useSettingsEffects()

  // MCP servers come from two places: the app-managed registry (Settings UI) and
  // the user-editable ~/.crewcode/mcp.json. Merge them for the composer picker.
  const mcpFile = useMcpFileServers()
  const allMcpServers = useMemo(
    () => mergeMcpServers(settings.mcpServers, mcpFile.servers),
    [settings.mcpServers, mcpFile.servers],
  )

  // ── Workspaces (real storage) ────────────────────────────────────────────
  const ws = useWorkspaces()
  const [loadingIntroComplete, setLoadingIntroComplete] = useState(false)
  const [loadingScreenMounted, setLoadingScreenMounted] = useState(true)
  const showLoadingScreen = ws.loading || !loadingIntroComplete

  useEffect(() => {
    const id = window.setTimeout(() => setLoadingIntroComplete(true), 1350)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    if (showLoadingScreen) {
      setLoadingScreenMounted(true)
      return
    }
    // Keep the splash mounted long enough for the CSS exit fade to finish.
    const id = window.setTimeout(() => setLoadingScreenMounted(false), 460)
    return () => window.clearTimeout(id)
  }, [showLoadingScreen])

  // ── Active workspace ─────────────────────────────────────────────────────
  const [activeWs, setActiveWs] = useState<string>(() => settings.onLaunch === 'last session' ? readLastActiveWorkspaceId() : '')
  useEffect(() => {
    if (activeWs && ws.workspaces.some(w => w.id === activeWs)) return
    if (ws.workspaces.length === 0) return
    const saved = settings.onLaunch === 'last session' ? readLastActiveWorkspaceId() : ''
    const restored = saved && ws.workspaces.some(w => w.id === saved) ? saved : ws.workspaces[0].id
    setActiveWs(restored)
  }, [ws.workspaces, activeWs, settings.onLaunch])

  useEffect(() => {
    if (activeWs) writeLastActiveWorkspaceId(activeWs)
  }, [activeWs])

  const activeWorkspace = ws.workspaces.find(w => w.id === activeWs) ?? EMPTY_WS

  // Worktree choices are keyed by the surface that owns them (chat session or
  // non-chat tab), never by workspace. A missing selection means the primary
  // checkout, so newly-added workspaces naturally start on their main branch.
  const [surfaceWorktreeIds, setSurfaceWorktreeIds] = useLocalStorageJsonState<Record<string, string | null>>(SURFACE_WORKTREE_STORAGE, {})

  const [gitOpenByTab, setGitOpenByTab] = useLocalStorageJsonState<Record<string, boolean>>(GIT_OPEN_STORAGE, {})
  const setGitOpenForTab = useCallback((tabId: string, next: boolean | ((prev: boolean) => boolean)) => {
    if (!tabId) return
    setGitOpenByTab(prev => {
      const current = prev[tabId] ?? false
      const value = typeof next === 'function' ? next(current) : next
      return { ...prev, [tabId]: value }
    })
  }, [setGitOpenByTab])
  const [gitWidthByTab, setGitWidthByTab] = useLocalStorageJsonState<Record<string, number>>(GIT_WIDTH_STORAGE, {})
  const setGitWidthForTab = useCallback((tabId: string, next: number | ((prev: number) => number)) => {
    if (!tabId) return
    setGitWidthByTab(prev => {
      const current = prev[tabId] ?? 380
      const value = typeof next === 'function' ? next(current) : next
      return { ...prev, [tabId]: value }
    })
  }, [setGitWidthByTab])
  // ── Mobile shell ──────────────────────────────────────────────────────────
  const mobile = useMobileShell()
  const [storedMobileDrawerSide, setMobileDrawerSide] = useLocalStorageJsonState<'left' | 'right'>(MOBILE_DRAWER_SIDE_STORAGE, 'left')
  const mobileDrawerSide = storedMobileDrawerSide === 'right' ? 'right' : 'left'
  // A desktop bottom-drawer preference must never turn into a bottom sheet on
  // phones. Mobile keeps its own side preference so desktop layout is untouched.
  const effectiveDrawerPosition = mobile.isMobile ? mobileDrawerSide : tweaks.drawerPosition

  // ── Tabs per workspace ───────────────────────────────────────────────────
  const {
    tabs, activeTab, activeTabId, setActiveTabId, setActiveTabInWorkspace, getActiveTabIdForWorkspace, selectWorkspace, openTab: handleNewTab, openTabInWorkspace, openPluginTab, restoreChatTabInWorkspace, closeTab, closeTabInWorkspace,
    splitGroups, splitTabIds, splitPrimaryTabId, setSplitTab, splitAnchorWithSession, pinTab, unpinTab, renameTab, setTabColor, setTabUrl,
    setBrowserSessionMode, reorderTab, allTabIds, tabInfoById,
  } = useWorkspaceTabs({ activeWs, workspaceName: activeWorkspace.name })
  const activeTabGitOpen = activeTabId ? (gitOpenByTab[activeTabId] ?? false) : false
  const workspaceNavigationHistoryRef = useRef(EMPTY_WORKSPACE_NAVIGATION_HISTORY)
  const workspaceDestinationByIdRef = useRef<Record<string, { tabId: string; sessionId?: string }>>({})
  const tabNavigationHistoryByWorkspaceRef = useRef<Record<string, typeof EMPTY_WORKSPACE_NAVIGATION_HISTORY>>({})
  // App settings must remain reachable before the first server workspace is
  // registered. Workspace tabs cannot materialize without a workspace id, so
  // browser/empty-state settings use this app-level destination.
  const [standaloneSettingsOpen, setStandaloneSettingsOpen] = useState(false)
  useEffect(() => { if (activeWs) setStandaloneSettingsOpen(false) }, [activeWs])
  const openUpdatesSettings = useCallback(() => {
    requestSettingsSection('updates')
    if (!activeWs) {
      setStandaloneSettingsOpen(true)
      return
    }
    const existing = tabs.find(t => t.kind === 'settings')
    if (existing) setActiveTabId(existing.id)
    else handleNewTab('settings')
  }, [activeWs, tabs, setActiveTabId, handleNewTab])
  useUpdaterNotices(openUpdatesSettings)
  const [canvasPanesByTab, setCanvasPanesByTab] = useLocalStorageJsonState<Record<string, CanvasPaneState[]>>(WORKBENCH_PANES_STORAGE, {})
  const canvasPaneCounterRef = useRef(0)
  const canvasPaneIds = useMemo(
    () => new Set(Object.values(canvasPanesByTab).flatMap(panes => panes.map(pane => pane.id))),
    [canvasPanesByTab],
  )

  const [pluginTabs, setPluginTabs] = useState<RegisteredPluginTab[]>([])
  const [pluginSidebarPanels, setPluginSidebarPanels] = useState<RegisteredPluginSidebarPanel[]>([])
  const [pluginStatusItems, setPluginStatusItems] = useState<RegisteredPluginStatusItem[]>([])
  const [pluginEditorActions, setPluginEditorActions] = useState<RegisteredPluginEditorAction[]>([])
  const [pluginChatActions, setPluginChatActions] = useState<RegisteredPluginChatAction[]>([])
  const [pluginChatHeaderItems, setPluginChatHeaderItems] = useState<RegisteredPluginChatHeaderItem[]>([])
  const [pluginGitLenses, setPluginGitLenses] = useState<RegisteredPluginGitLens[]>([])
  const [pluginMissionWidgets, setPluginMissionWidgets] = useState<RegisteredPluginMissionWidget[]>([])
  const [pluginTerminalWatchers, setPluginTerminalWatchers] = useState<RegisteredPluginTerminalWatcher[]>([])
  const [pluginBrowserActions, setPluginBrowserActions] = useState<RegisteredPluginBrowserAction[]>([])
  const [activePluginSidebarId, setActivePluginSidebarId] = useState<string | null>(null)
  const [pluginSidebarOpen, setPluginSidebarOpen] = useState(false)
  const [pluginSidebarOpenContext, setPluginSidebarOpenContext] = useState<PluginOpenContext>({ source: 'restored-tab' })
  const pluginApprovalNoticeKeyRef = useRef('')
  const isPluginActiveForWorkspace = useCallback((pluginId: string) => {
    if (!activeWs) return true
    return settings.pluginWorkspaceEnabled[activeWs]?.[pluginId] !== false
  }, [activeWs, settings.pluginWorkspaceEnabled])
  const filterWorkspacePlugins = useCallback(<T extends { pluginId: string }>(items: T[]): T[] => (
    items.filter(item => isPluginActiveForWorkspace(item.pluginId))
  ), [isPluginActiveForWorkspace])
  const filterWorkspaceAgents = useCallback((items: AgentInfo[]): AgentInfo[] => (
    items.filter(item => item.source !== 'plugin' || !item.pluginId || isPluginActiveForWorkspace(item.pluginId))
  ), [isPluginActiveForWorkspace])
  const refreshPluginTabs = useCallback(async () => {
    try {
      const registry = await window.electronAPI?.pluginsList?.()
      setPluginTabs(filterWorkspacePlugins(registry?.contributions.tabs ?? []))
      setPluginSidebarPanels(filterWorkspacePlugins(registry?.contributions.sidebarPanels ?? []))
      setPluginStatusItems(filterWorkspacePlugins(registry?.contributions.statusItems ?? []))
      setPluginEditorActions(filterWorkspacePlugins(registry?.contributions.editorActions ?? []))
      setPluginChatActions(filterWorkspacePlugins(registry?.contributions.chatActions ?? []))
      setPluginChatHeaderItems(filterWorkspacePlugins(registry?.contributions.chatHeaderItems ?? []))
      setPluginGitLenses(filterWorkspacePlugins(registry?.contributions.gitLenses ?? []))
      setPluginMissionWidgets(filterWorkspacePlugins(registry?.contributions.missionWidgets ?? []))
      setPluginTerminalWatchers(filterWorkspacePlugins(registry?.contributions.terminalWatchers ?? []))
      setPluginBrowserActions(filterWorkspacePlugins(registry?.contributions.browserActions ?? []))

      const blocked = registry?.plugins.filter(plugin => plugin.enabled && !plugin.approved) ?? []
      const noticeKey = blocked.map(plugin => `${plugin.id}:${plugin.approvalState}:${plugin.permissionFingerprint}`).sort().join('|')
      if (noticeKey && noticeKey !== pluginApprovalNoticeKeyRef.current) {
        pluginApprovalNoticeKeyRef.current = noticeKey
        const changed = blocked.filter(plugin => plugin.approvalState === 'permissions-changed').length
        show({
          type: 'warning',
          message: changed > 0
            ? `${changed} plugin${changed === 1 ? '' : 's'} changed permissions — approve in Plugins.`
            : `${blocked.length} plugin${blocked.length === 1 ? '' : 's'} need approval in Plugins.`,
          duration: 10000,
        })
      }
      if (!noticeKey) pluginApprovalNoticeKeyRef.current = ''
    } catch {
      setPluginTabs([])
      setPluginSidebarPanels([])
      setPluginStatusItems([])
      setPluginEditorActions([])
      setPluginChatActions([])
      setPluginChatHeaderItems([])
      setPluginGitLenses([])
      setPluginMissionWidgets([])
      setPluginTerminalWatchers([])
      setPluginBrowserActions([])
    }
  }, [filterWorkspacePlugins, show])
  useEffect(() => { void refreshPluginTabs() }, [refreshPluginTabs])
  useEffect(() => {
    const off = window.electronAPI?.onPluginsChanged?.((event) => {
      const registry = event.registry
      setPluginTabs(filterWorkspacePlugins(registry.contributions.tabs))
      setPluginSidebarPanels(filterWorkspacePlugins(registry.contributions.sidebarPanels))
      setPluginStatusItems(filterWorkspacePlugins(registry.contributions.statusItems))
      setPluginEditorActions(filterWorkspacePlugins(registry.contributions.editorActions))
      setPluginChatActions(filterWorkspacePlugins(registry.contributions.chatActions))
      setPluginChatHeaderItems(filterWorkspacePlugins(registry.contributions.chatHeaderItems))
      setPluginGitLenses(filterWorkspacePlugins(registry.contributions.gitLenses))
      setPluginMissionWidgets(filterWorkspacePlugins(registry.contributions.missionWidgets))
      setPluginTerminalWatchers(filterWorkspacePlugins(registry.contributions.terminalWatchers))
      setPluginBrowserActions(filterWorkspacePlugins(registry.contributions.browserActions))
      void window.electronAPI?.agentRegistry?.().then(next => setAgents(filterWorkspaceAgents(next)))
      if (event.reason === 'watch') show({ type: 'info', message: 'plugin registry refreshed', duration: 2500 })
    })
    return () => off?.()
  }, [filterWorkspaceAgents, filterWorkspacePlugins, show])

  const pluginCommands = useMemo<Command[]>(() => pluginTabs.map(tab => ({
    id: `plugin:tab:${tab.registrationId}`,
    label: tab.title,
    icon: tab.icon ?? 'grid',
    hint: `plugin · ${tab.pluginId}`,
    kbd: '',
    group: 'Plugins',
  })), [pluginTabs])

  // Refs that always track the latest tab list and active tab id — used by
  // editor persistence and targeted event dispatch so stale closures don't
  // leak closed-tab state or send events to the wrong instance.
  const tabsRef = useRef(tabs)
  const activeTabIdRef = useRef(activeTabId)
  tabsRef.current = tabs
  activeTabIdRef.current = activeTabId

  const handleWsSelect = useCallback((wsId: string) => {
    if (!wsId || wsId === activeWs) return
    // Record the destination before starting the transition. Remote workspaces
    // may mount slowly, and React can coalesce rapid transitions before their
    // effects run; history must still include the workspace the user selected.
    const remembered = workspaceDestinationByIdRef.current[wsId]
    const tabId = remembered?.tabId || getActiveTabIdForWorkspace(wsId)
    workspaceNavigationHistoryRef.current = recordWorkspaceVisit(
      workspaceNavigationHistoryRef.current,
      { wsId, tabId, sessionId: remembered?.sessionId },
    )
    startTransition(() => {
      selectWorkspace(wsId)
      setActiveWs(wsId)
    })
  }, [activeWs, getActiveTabIdForWorkspace, selectWorkspace])

  const jumpToWorkspaceTab = useCallback((wsId: string, tabId: string) => {
    if (!wsId || !tabId) return
    // Explicit drawer jumps must not call selectWorkspace(): its transition can
    // restore that workspace's previous tab after we pick the requested one.
    if (wsId !== activeWs) setActiveWs(wsId)
    setActiveTabInWorkspace(wsId, tabId)
  }, [activeWs, setActiveTabInWorkspace])

  const openBrowserUrl = useCallback((url?: string) => {
    const currentBrowser = activeTab?.kind === 'browser' ? activeTab : null
    if (currentBrowser) {
      if (url) setTabUrl(currentBrowser.id, url)
      setActiveTabId(currentBrowser.id)
      return
    }

    // Opening web content from chat should create a fresh browser tab unless
    // the user is already inside one; otherwise hidden browser tabs get reused.
    handleNewTab('browser', url ? { url } : undefined)
  }, [activeTab, setTabUrl, setActiveTabId, handleNewTab])

  // ── Chat state ───────────────────────────────────────────────────────────
  const chatSessions = useChatSessions({
    agentId: settings.defaultAgent || 'pi',
    model:   '',
    mode:    settings.defaultMode as ModeLevel,
    effort:  'medium',
    initialBranch: settings.defaultBranchByWorkspace[activeWs] ?? '',
  })
  useEffect(() => {
    if (activeTab?.kind === 'chat' && !isSessionViewTab(activeTab)) chatSessions.ensureTab(activeTabId, activeWorkspace.name)
  }, [activeTab, activeTabId, activeWorkspace.name, chatSessions.ensureTab])
  const chatOwnerTabId    = activeTab?.sessionOwnerTabId ?? activeTabId
  const sessions          = chatSessions.getSessions(chatOwnerTabId)
  const sessActive        = activeTab?.pinnedSessionId ?? chatSessions.getActiveId(chatOwnerTabId)
  const activeSession     = (activeTab?.pinnedSessionId
    ? sessions.find(session => session.id === activeTab.pinnedSessionId)
    : null) ?? chatSessions.getActiveSession(chatOwnerTabId)
  const worktreeSurfaceId = worktreeSelectionKey(activeTabId, activeTab?.kind, sessActive)
  const requestedWorktreeId = worktreeSurfaceId ? surfaceWorktreeIds[worktreeSurfaceId] : null
  const activeWorktree = resolveSelectedWorktree(requestedWorktreeId, activeWorkspace.worktrees ?? [])
  const activeWorktreeId = activeWorktree?.id ?? null
  const effectivePath    = activeWorktree?.path   ?? activeWorkspace.path
  const effectiveBranch  = activeWorktree?.branch ?? activeWorkspace.branch ?? '—'
  const effectiveDirty   = activeWorktree?.dirty  ?? activeWorkspace.dirty ?? 0
  const selectWorktreeForActiveSurface = useCallback((id: string | null) => {
    if (!worktreeSurfaceId) return
    setSurfaceWorktreeIds(prev => ({ ...prev, [worktreeSurfaceId]: id }))
  }, [setSurfaceWorktreeIds, worktreeSurfaceId])
  const worktreeForChatSurface = useCallback((surfaceTabId: string, sessionId?: string) => {
    const resolvedSessionId = sessionId ?? chatSessions.getActiveId(surfaceTabId)
    const key = worktreeSelectionKey(surfaceTabId, 'chat', resolvedSessionId)
    const selected = resolveSelectedWorktree(surfaceWorktreeIds[key], activeWorkspace.worktrees ?? [])
    return {
      key,
      id: selected?.id ?? null,
      path: selected?.path ?? activeWorkspace.path,
      branch: selected?.branch ?? activeWorkspace.branch ?? '—',
      worktreeBranch: selected?.branch ?? null,
      dirty: selected?.dirty ?? activeWorkspace.dirty ?? 0,
    }
  }, [activeWorkspace.branch, activeWorkspace.dirty, activeWorkspace.path, activeWorkspace.worktrees, chatSessions, surfaceWorktreeIds])
  const selectWorktreeForKey = useCallback((key: string, id: string | null) => {
    if (!key) return
    setSurfaceWorktreeIds(prev => prev[key] === id ? prev : { ...prev, [key]: id })
  }, [setSurfaceWorktreeIds])
  useEffect(() => {
    if (!activeWs || !activeTabId) return
    const visit = {
      wsId: activeWs,
      tabId: activeTabId,
      sessionId: activeTab?.kind === 'chat' ? (sessActive || undefined) : undefined,
    }
    workspaceDestinationByIdRef.current[activeWs] = {
      tabId: visit.tabId,
      sessionId: visit.sessionId,
    }
    workspaceNavigationHistoryRef.current = recordWorkspaceVisit(
      workspaceNavigationHistoryRef.current,
      visit,
    )
    tabNavigationHistoryByWorkspaceRef.current[activeWs] = recordTabVisit(
      tabNavigationHistoryByWorkspaceRef.current[activeWs] ?? EMPTY_WORKSPACE_NAVIGATION_HISTORY,
      visit,
    )
  }, [activeTab?.kind, activeTabId, activeWs, sessActive])
  const lastSoloSessionIdRef = useRef<string | null>(null)
  if (activeTab?.kind === 'chat' && sessActive) lastSoloSessionIdRef.current = sessActive
  const handleRenameWindowTab = useCallback((tabId: string, label: string) => {
    renameTab(tabId, label)
    const tab = tabs.find(candidate => candidate.id === tabId)
    if (tab?.kind !== 'chat') return
    const activeChatSessionId = chatSessions.getActiveId(tabId)
    if (!activeChatSessionId) return
    // Chat win-tab titles render from the active session label, so keep both
    // records aligned or the next render makes the rename look ignored.
    chatSessions.update(tabId, activeChatSessionId, { label })
  }, [chatSessions, renameTab, tabs])
  const workspaceByChatTabId = useMemo(() => {
    const byTab: Record<string, string> = {}
    const workspaceIds = ws.workspaces.map(workspace => workspace.id)
    const ownerFor = (tabId: string): string | null => chatSessionOwnerWorkspaceId(tabId, workspaceIds)

    for (const workspace of ws.workspaces) byTab[`${workspace.id}-chat`] = workspace.id
    for (const tabId of allTabIds) {
      const owner = ownerFor(tabId)
      if (owner) byTab[tabId] = owner
    }
    for (const tabId of Object.keys(chatSessions.sessionsByTab)) {
      const owner = ownerFor(tabId)
      if (owner) byTab[tabId] = owner
    }
    if (activeTab?.kind === 'chat' && activeTabId) {
      const owner = ownerFor(activeTabId)
      if (owner) byTab[activeTabId] = owner
    }
    return byTab
  }, [activeTab?.kind, activeTabId, allTabIds, chatSessions.sessionsByTab, ws.workspaces])

  const provisioningBranchSessionsRef = useRef(new Set<string>())
  useEffect(() => {
    for (const list of Object.values(chatSessions.sessionsByTab) as Session[][]) {
      for (const session of list) {
        const branch = session.initialBranch?.trim()
        if (!branch || session.origin === 'delegated' || provisioningBranchSessionsRef.current.has(session.id)) continue
        const workspaceId = workspaceByChatTabId[session.tabId]
        const workspace = ws.workspaces.find(candidate => candidate.id === workspaceId)
        if (!workspace || workspace.kind !== 'repo') continue

        provisioningBranchSessionsRef.current.add(session.id)
        void (async () => {
          try {
            const selectionKey = worktreeSelectionKey(session.tabId, 'chat', session.id)
            if (branch === workspace.branch) {
              setSurfaceWorktreeIds(prev => ({ ...prev, [selectionKey]: null }))
            } else {
              let worktree = workspace.worktrees.find(candidate => candidate.branch === branch)
              if (!worktree) {
                const beforeCreate = await window.electronAPI?.worktreeList(workspace.path)
                worktree = beforeCreate?.worktrees?.find(candidate => candidate.branch === branch)
              }
              if (!worktree) {
                const created = await window.electronAPI?.worktreeCreate(workspace.path, branch)
                if (!created?.path || created.error) throw new Error(created?.error ?? `Unable to create a worktree for ${branch}`)
                const listed = await window.electronAPI?.worktreeList(workspace.path)
                worktree = listed?.worktrees?.find(candidate => candidate.path === created.path || candidate.branch === branch)
                if (!worktree) throw new Error(`Created ${branch}, but could not detect its worktree`)
                await ws.refreshWorktrees(workspace.id)
              }
              setSurfaceWorktreeIds(prev => ({ ...prev, [selectionKey]: worktree!.id }))
            }
            // This field is a one-shot creation request. Clearing it protects an
            // existing chat from being moved again after the user switches it.
            chatSessions.update(session.tabId, session.id, { initialBranch: undefined })
          } catch (error) {
            chatSessions.update(session.tabId, session.id, { initialBranch: undefined })
            show({ type: 'error', message: `default branch: ${(error as Error).message}`, duration: 5000 })
          } finally {
            provisioningBranchSessionsRef.current.delete(session.id)
          }
        })()
      }
    }
  }, [chatSessions, setSurfaceWorktreeIds, show, workspaceByChatTabId, ws])

  const validChatSessionTabIds = useMemo(() => new Set(Object.keys(workspaceByChatTabId)), [workspaceByChatTabId])
  const validRuntimeTabIds = useMemo(() => {
    const ids = new Set(allTabIds)
    // Default chat tabs can be virtual (not persisted in wsTabs) but still own
    // live agents/terminals, so runtime pruning must treat them as real tabs.
    for (const id of validChatSessionTabIds) ids.add(id)
    if (activeTabId) ids.add(activeTabId)
    for (const id of canvasPaneIds) ids.add(id)
    return ids
  }, [activeTabId, allTabIds, canvasPaneIds, validChatSessionTabIds])

  // Live and archived sessions are grouped in one pass. Everything downstream
  // (completed chats, recency, agent status) reads the live map only, so
  // archiving a session removes it from every derived surface at once.
  const [sessionsByWorkspace, archivedSessionsByWorkspace] = useMemo(() => {
    const byWs: Record<string, Session[]> = {}
    const archivedByWs: Record<string, Session[]> = {}
    for (const workspace of ws.workspaces) { byWs[workspace.id] = []; archivedByWs[workspace.id] = [] }
    for (const list of Object.values(chatSessions.sessionsByTab) as Session[][]) {
      for (const session of list) {
        if (!validChatSessionTabIds.has(session.tabId)) continue
        const workspaceId = workspaceByChatTabId[session.tabId]
        if (!workspaceId) continue
        const target = session.archived ? archivedByWs : byWs
        ;(target[workspaceId] ??= []).push(session)
      }
    }
    return [byWs, archivedByWs] as const
  }, [chatSessions.sessionsByTab, validChatSessionTabIds, workspaceByChatTabId, ws.workspaces])
  const sessionById = useMemo(() => {
    const byId: Record<string, Session> = {}
    for (const list of Object.values(chatSessions.sessionsByTab) as Session[][]) {
      for (const session of list) byId[session.id] = session
    }
    return byId
  }, [chatSessions.sessionsByTab])
  const setSessActive     = useCallback((sessionId: string) => chatSessions.activate(activeTabId, sessionId), [activeTabId, chatSessions])
  const sessionModeLevel: ModeLevel = normalizeModeLevel(activeSession?.mode ?? settings.defaultMode)
  const [mode, setMode] = useState<Mode>(sessionModeLevel === 'ask' ? 'Ask' : sessionModeLevel === 'plan' ? 'Plan' : sessionModeLevel === 'full' ? 'Full' : 'Build')
  useEffect(() => {
    setMode(sessionModeLevel === 'ask' ? 'Ask' : sessionModeLevel === 'plan' ? 'Plan' : sessionModeLevel === 'full' ? 'Full' : 'Build')
  }, [sessionModeLevel])
  const [pendingBrowserGrabSend, setPendingBrowserGrabSend] = useState<PendingBrowserGrabSend | null>(null)

  // Messages live in the store (keyed by scope id). App takes only the stable
  // setters — it does NOT subscribe to the map, so a streamed token re-renders
  // the thread surface (ChatPane) and not App or the shell. Reads happen in the
  // components/handlers that need them (ChatPane, ChatNotifications,
  // MissionDataProvider, browser-grab via getState()).
  const setMessagesByTab = useMessagesStore((s) => s.setMessagesByTab)
  const setMessagesForTab = useMessagesStore((s) => s.setMessagesForTab)

  // Chat panes unmount when users switch tabs, so draft/view UI must live here
  // or different chat tabs will appear to share whichever pane mounted last.
  // Composer drafts moved to composer-draft-store so typing doesn't re-render
  // App; this now only tracks per-tab thread view (a low-frequency toggle).
  const [chatUiByTab, setChatUiByTab] = useLocalStorageJsonState<Record<string, { threadView: 'chat' | 'code' | 'md' }>>(CHAT_UI_STORAGE, {})
  useEffect(() => {
    if (ws.loading) return
    setChatUiByTab(prev => {
      let changed = false
      const next: typeof prev = {}
      for (const [tabId, value] of Object.entries(prev)) {
        if (validChatSessionTabIds.has(tabId)) next[tabId] = value
        else changed = true
      }
      return changed ? next : prev
    })
  }, [setChatUiByTab, validChatSessionTabIds, ws.loading])
  // Code editor sessions are App-owned so chat/file-link opens and editor tabs
  // share the same buffers instead of racing through a browser tab.
  const codeEditors = useCodeEditorSessions()
  const [pendingGitDiff, setPendingGitDiff] = useState<{ title: string; diff: string } | null>(null)
  const [editorInitialFile, setEditorInitialFile] = useState<string | null>(null)
  const [changesDrawerOpenBySurface, setChangesDrawerOpenBySurface] = useLocalStorageJsonState<SurfaceOpenState>(CHANGES_DRAWER_STORAGE, {})
  const setChangesDrawerOpenForSurface = useCallback((surfaceId: string, open: boolean) => {
    setChangesDrawerOpenBySurface(prev => setSurfaceOpen(prev, surfaceId, open))
  }, [setChangesDrawerOpenBySurface])

  const [github, setGithub] = useState<GitHubStatus | null>(null)
  useEffect(() => {
    if (!effectivePath || activeWorkspace.kind === 'folder') { setGithub(null); return }
    const api = getCrewCodeClient()
    let cancelled = false
    let loading = false
    const publish = (next: GitHubStatus | null): void => {
      if (cancelled) return
      setGithub(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next)
    }
    const load = async (): Promise<void> => {
      if (loading) return
      loading = true
      try {
        const status = await api.githubStatus(effectivePath)
        publish(status && !('error' in status) ? status : null)
      } catch {
        publish(null)
      } finally {
        loading = false
      }
    }
    void load()
    const id = window.setInterval(() => { void load() }, 60_000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [effectivePath, activeWorkspace.kind])

  const [gitAuthRequest, setGitAuthRequest] = useState<GitAuthRequest | null>(null)
  const gitAuthResolveRef = useRef<((credentials: GitAuthCredentials | null) => void) | null>(null)
  const requestGitAuth = useCallback((request: GitAuthRequest): Promise<GitAuthCredentials | null> => {
    setGitAuthRequest(request)
    return new Promise(resolve => { gitAuthResolveRef.current = resolve })
  }, [])
  const resolveGitAuth = useCallback((credentials: GitAuthCredentials | null): void => {
    gitAuthResolveRef.current?.(credentials)
    gitAuthResolveRef.current = null
    setGitAuthRequest(null)
  }, [])

  const [gitSigningRequest, setGitSigningRequest] = useState<GitSigningRequest | null>(null)
  const gitSigningResolveRef = useRef<((passphrase: string | null) => void) | null>(null)
  const requestSigningPassphrase = useCallback((request: GitSigningRequest): Promise<string | null> => {
    setGitSigningRequest(request)
    return new Promise(resolve => { gitSigningResolveRef.current = resolve })
  }, [])
  const resolveSigningPassphrase = useCallback((passphrase: string | null): void => {
    gitSigningResolveRef.current?.(passphrase)
    gitSigningResolveRef.current = null
    setGitSigningRequest(null)
  }, [])

  // Git sidebar — conflict resolution drops a prompt into the composer.
  const handleGitAskAgent = useCallback((text: string, targetTabId?: string) => {
    // Route the conflict prompt: a fresh chat tab, a chosen existing one (focus
    // it), or — when no target is given (crew path) — the currently active tab.
    let destId: string | undefined
    if (targetTabId === NEW_CHAT_TARGET) destId = handleNewTab('chat')
    else if (targetTabId) { setActiveTabId(targetTabId); destId = targetTabId }
    else destId = activeTabIdRef.current
    if (!destId) return
    composerDraftActions().set(destId, text)
  }, [handleNewTab, setActiveTabId])
  const git = useGitSidebar({
    repoPath:          effectivePath,
    workspacePath:     activeWorkspace.path,
    mainBranch:        activeWorkspace.branch ?? 'main',
    comparisonRef:     settings.defaultBranchByWorkspace[activeWs]?.trim() || undefined,
    currentWorktreeId: activeWorktreeId,
    // Chat, writer, and Workbench panes own path-scoped Git controllers below.
    // Keep this shared controller dormant for those surfaces to avoid duplicate polling.
    enabled:           (activeTab?.kind === 'git' || (activeTabGitOpen && !['chat', 'crew', 'writer', 'canvas'].includes(activeTab?.kind ?? ''))) && !!activeWs,
    onSwitchWorktree:  selectWorktreeForActiveSurface,
    onAskAgent:        handleGitAskAgent,
    onWorktreesChanged: () => activeWs ? ws.refreshWorktrees(activeWs) : undefined,
    onRequestGitAuth: requestGitAuth,
    onRequestSigningPassphrase: requestSigningPassphrase,
    alwaysCommitUnsigned: settings.alwaysCommitUnsigned,
  })

  // Click-to-open from work-log rows and agent markdown file links — load the
  // target into the singleton code editor tab instead of treating it as a URL.
  const openFileInEditor = useCallback((path: string) => {
    if (!path) return
    void (async () => {
      const root = effectivePath ?? ''
      let rel = path.replace(/\\/g, '/')
      const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
      // Convert absolute → workspace-relative so fsReadFile stays rooted in the workspace.
      const wasAbsolute = rel.startsWith('/') || /^[a-zA-Z]:\//.test(rel)
      const isWindowsRoot = /^[a-zA-Z]:\//.test(normalizedRoot)
      const relKey = isWindowsRoot ? rel.toLowerCase() : rel
      const rootKey = isWindowsRoot ? normalizedRoot.toLowerCase() : normalizedRoot
      if (normalizedRoot && relKey.startsWith(`${rootKey}/`)) {
        rel = rel.slice(normalizedRoot.length + 1)
      } else if (normalizedRoot && relKey === rootKey) {
        return
      } else if (wasAbsolute) {
        return
      }
      rel = rel.replace(/^\/+/, '')
      if (!rel || rel.split('/').includes('..')) return

      setPendingGitDiff(null)
      setEditorInitialFile(rel)
      const targetTabId = handleNewTab('code')
      if (!targetTabId) return
      if (codeEditors.sessions[targetTabId]?.tabs.some(tab => tab.rel === rel)) {
        codeEditors.setActiveRel(targetTabId, rel)
        return
      }

      const api = window.electronAPI
      if (!api || !root) return
      const r = await api.fsReadFile(root, rel)
      if (r.error || !r.ok) {
        show({ type: 'error', message: r.error ? `open failed: ${r.error}` : `open failed: ${rel}` })
        return
      }
      codeEditors.openFile(targetTabId, { rel, name: r.name ?? rel, text: r.text ?? '', size: r.size ?? 0 })
    })()
  }, [codeEditors, effectivePath, handleNewTab, show])

  const openGitFileDiff = useCallback(async (path: string, staged: boolean) => {
    if (!activeWorkspace) return
    const api = getCrewCodeClient()
    const comparisonRef = settings.defaultBranchByWorkspace[activeWs]?.trim()
    const r = comparisonRef
      ? await api.gitDiffVsRef(effectivePath, comparisonRef, path)
      : await api.gitDiff(effectivePath, path, staged)
    if (r?.error) {
      show({ type: 'error', message: `diff failed: ${r.error}` })
      return
    }
    const diff = r?.diff ?? ''
    const title = comparisonRef ? `vs ${comparisonRef}: ${path}` : `${staged ? 'staged' : 'unstaged'}: ${path}`
    // The diff renders in a dedicated Code Editor tab via <CodeEditor externalDiff>.
    // Reuse the active editor tab if there is one; otherwise open a fresh one.
    if (tabsRef.current.find(t => t.id === activeTabIdRef.current)?.kind !== 'code') {
      handleNewTab('code')
    }
    setPendingGitDiff({ title, diff })
  }, [activeWorkspace, activeWs, effectivePath, handleNewTab, settings.defaultBranchByWorkspace, show])

  // ── Agent registry ───────────────────────────────────────────────────────
  const [agents, setAgents] = useState<AgentInfo[]>([])
  useEffect(() => {
    const api = window.electronAPI
    if (!api) return
    let cancelled = false
    // Apply persisted launch-path overrides before reading the registry so
    // bridges and pty spawns use the user's chosen binary from the first call.
    const overrides = settings.agentPathOverrides ?? {}
    const applyOverrides = async () => {
      const entries = Object.entries(overrides).filter(([, p]) => typeof p === 'string' && p !== '')
      for (const [id, p] of entries) {
        await api.agentSetPath(id, p)
      }
    }
    applyOverrides()
      .then(() => api.agentRegistry())
      .then(r => { if (!cancelled) setAgents(filterWorkspaceAgents(r)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [filterWorkspaceAgents, settings.agentPathOverrides])

  // Per-session agent state — reads/writes flow through chatSessions.
  const activeAgentId = activeSession?.agentId || settings.defaultAgent || 'pi'
  const model         = activeSession?.model  ?? ''

  // ── Rate limits ─────────────────────────────────────────────────────────
  const [rateLimitState, setRateLimitState] = useState<import('../../shared/rate-limit-types').RateLimitState>({ providers: {} })
  useEffect(() => {
    const api = window.electronAPI
    if (!api) return
    // Hydrate initial state
    api.rateLimits.get().then(setRateLimitState).catch(() => {})
    // Subscribe to live pushes
    const off = api.rateLimits.onUpdate(setRateLimitState)
    return () => off()
  }, [])

  const usageProviderId = dockUsageProviderId(activeAgentId, model)
  const activeAgentRateLimits = rateLimitState.providers[usageProviderId]
  const providerUsed = activeAgentRateLimits?.session?.usedPercent ?? 0
  const providerLimit = 100
  const providerResetDescription = activeAgentRateLimits?.session?.resetDescription ?? null
  const hourlyUsedPercent = activeAgentRateLimits?.session?.usedPercent ?? 0
  const hourlyResetDescription = activeAgentRateLimits?.session?.resetDescription ?? null
  const weeklyUsedPercent = activeAgentRateLimits?.weekly?.usedPercent ?? 0
  const weeklyResetDescription = activeAgentRateLimits?.weekly?.resetDescription ?? null
  const effort        = (activeSession?.effort ?? 'medium') as EffortLevel
  const setActiveAgentId = useCallback((id: string) => {
    if (sessActive) chatSessions.update(activeTabId, sessActive, { agentId: id })
  }, [sessActive, chatSessions])
  const setModel = useCallback((m: string) => {
    if (sessActive) chatSessions.update(activeTabId, sessActive, { model: m })
  }, [sessActive, chatSessions])
  const setEffort = useCallback((e: EffortLevel) => {
    if (sessActive) chatSessions.update(activeTabId, sessActive, { effort: e })
  }, [sessActive, chatSessions])

  // Backfill agentId for sessions created before the registry returned.
  useEffect(() => {
    if (agents.length === 0 || !activeSession) return
    const have = agents.some(a => a.id === activeSession.agentId && a.available)
    if (have) return
    const preferred = agents.find(a => a.id === settings.defaultAgent && a.available)
                   ?? agents.find(a => a.id === 'pi' && a.available)
                   ?? agents.find(a => a.available)
    if (preferred) chatSessions.update(activeTabId, activeSession.id, { agentId: preferred.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, activeSession?.id])

  // ── PTY panes (real terminals) ───────────────────────────────────────────
  const pty = useTerminalSessions({
    tabKind: tabId => tabInfoById[tabId]?.kind,
  })

  // Drawer quick-jump data: unread badges for terminal CLIs + recency ranking
  // for chat sessions across every workspace.
  // Feeds badge inputs without subscribing App to unread counts — background
  // PTY output (a claude/codex agent in another tab) no longer re-renders the
  // shell, which is what made the Workbench page stutter. Only the drawer badges
  // (useUnreadByPane) re-render on output.
  useTerminalUnreadSync(pty.panes, activeTabId)
  // Mount the YuHeard IPC listener once. The store dispatches the
  // knock sound + optional OS notification on every `complete` transition.
  useYuHeardSync()
  // In-app toast for terminal completes. Chat already has its own bar;
  // YuHeard previously had no visible notice while the window was focused,
  // so a Codex pane finishing in view looked like "no notification".
  useEffect(() => {
    return window.electronAPI?.onYuheardState?.((event) => {
      if (event.state !== 'complete') return
      if (!getCurrentSettings().yuheardEnabled) return
      if (isYuHeardPaneFocused(event.paneId)) return
      const pane = pty.panes.find(p => p.paneId === event.paneId)
      if (pane && !tabKindAllowsYuHeard(tabInfoById[pane.tabId]?.kind)) return
      const name = pane?.title?.trim() || pane?.agentId || 'Terminal'
      const preview = event.message?.trim() || 'finished a turn'
      show({
        type: 'info',
        message: `${name}: ${preview}`,
        duration: 9000,
        onClick: pane ? () => jumpToWorkspaceTab(pane.wsId, pane.tabId) : undefined,
      })
    })
  }, [jumpToWorkspaceTab, pty.panes, show, tabInfoById])
  const clearPane = useClearPane()
  // Completion metadata (not message arrays) comes straight from the store, so
  // streamed tokens do not make App rebuild the drawer's Completed section.
  const {
    completedAtByScope,
    dismissedAtByScope,
    markComplete: completeChatRecency,
    dismiss:      dismissCompletedChat,
    forget:       forgetChatRecency,
  } = useCompletedChats()

  // Live CLIs (agent panes) running inside terminal tabs. Unread counts and the
  // unread-based ordering are applied in the drawer (which subscribes to the
  // unread store), so this list stays stable while agents stream — App does not
  // rebuild on every background terminal burst.
  const terminalClis = useMemo(() => {
    return pty.panes
      .filter(p => p.agentId && tabInfoById[p.tabId]?.kind === 'terminal')
      .map(p => ({
        paneId:  p.paneId,
        tabId:   p.tabId,
        wsId:    p.wsId,
        title:   p.title,
        agentId: p.agentId as string,
        wsName:  ws.workspaces.find(w => w.id === p.wsId)?.name ?? '',
      }))
  }, [pty.panes, tabInfoById, ws.workspaces])

  // Chat sessions that have actually finished an agent turn, newest first
  // (capped). The drawer passively hides entries after one hour; keep timestamps
  // here so expiry never mutates or deletes the underlying chat.
  // A session only qualifies once a bridge reported a final turn, so
  // chats the user merely opened — or that just happen to hold a transcript from
  // a previous launch — never show up here.
  const completedChats = useMemo(() => {
    const entries: CompletedChatEntry[] = []
    for (const workspace of ws.workspaces) {
      for (const session of sessionsByWorkspace[workspace.id] ?? []) {
        const completedAt = completedAtByScope[session.id]
        if (!completedAt) continue
        // Dismissed until a strictly newer turn completes on this chat.
        if (completedAt <= (dismissedAtByScope[session.id] ?? 0)) continue
        entries.push({
          sessionId:   session.id,
          tabId:       session.tabId,
          wsId:        workspace.id,
          label:       session.label,
          wsName:      workspace.name,
          agentId:     session.agentId,
          completedAt,
        })
      }
    }
    return entries
      .sort((a, b) => b.completedAt - a.completedAt)
      .slice(0, 6)
  }, [ws.workspaces, sessionsByWorkspace, completedAtByScope, dismissedAtByScope])
  // SSH targets — saved app conns plus imported ~/.ssh/config aliases.
  const [sshConfigHosts, setSshConfigHosts] = useState<{ host: string; addr: string }[]>([])
  useEffect(() => {
    window.electronAPI?.sshListConfig().then(list => {
      setSshConfigHosts((list ?? []).map(h => ({
        host: h.user ? `${h.user}@${h.host}` : h.host,
        addr: `${h.hostname ?? h.host}${h.port ? ':' + h.port : ''}`,
      })))
    })
  }, [])
  const sshTargets = useMemo(() => {
    const fromSaved = settings.sshConns.map(c => {
      const port = c.addr.match(/:(\d+)$/)?.[1]
      return {
        id:     `saved:${c.id}`,
        label:  c.host,
        target: port && port !== '22' ? `${c.host}:${port}` : c.host,
      }
    })
    const fromConfig = sshConfigHosts.map((c, i) => {
      const port = c.addr.match(/:(\d+)$/)?.[1]
      return {
        id:     `cfg:${i}`,
        label:  c.host,
        target: port && port !== '22' ? `${c.host}:${port}` : c.host,
      }
    })
    // Dedupe by target
    const seen = new Set<string>()
    return [...fromSaved, ...fromConfig].filter(t => {
      if (seen.has(t.target)) return false
      seen.add(t.target)
      return true
    })
  }, [settings.sshConns, sshConfigHosts])

  const wsPanes = useMemo(() => pty.panes.filter(p => p.tabId === activeTabId), [pty.panes, activeTabId])

  const activeAgentPane = useMemo(
    () => [...wsPanes].reverse().find(p => p.agentId === activeAgentId) ?? null,
    [wsPanes, activeAgentId],
  )

  // ── System monitor — every live terminal session across the app ──────────
  const sysmonTerminals = useMemo<TerminalDaemon[]>(
    () => pty.panes.map(p => ({ id: p.paneId, wsId: p.wsId, tabId: p.tabId, title: p.title, sub: p.sub, agentId: p.agentId })),
    [pty.panes],
  )
  const sysmonWorkspaces = useMemo(
    () => ws.workspaces.map(w => ({ id: w.id, name: w.name })),
    [ws.workspaces],
  )
  const killTerminalSession = useCallback((paneId: string) => {
    // Kill the OS process, then drop the pane from its tab's grid layout.
    window.electronAPI?.ptyKill(paneId)
    pty.close(paneId)
  }, [pty])

  // ── Agent bridges (pi/opencode/codex structured streaming) ──────────────
  const bridges = useBridgeRegistry({ setMessagesForTab })
  // Mission Control and the crew surfaces fan out over every tab's pending
  // requests, so App subscribes to the whole map. Status/follow-up churn stays
  // out of App entirely — only ChatPane subscribes to those.
  const missionUserRequestsByTab = useUserRequestsByTab()
  useEffect(() => {
    // Workspaces load async from disk; until that resolves `ws.workspaces` is
    // empty, which would make validChatSessionTabIds near-empty and prune every
    // persisted session + its messages. Wait for the load before pruning.
    if (ws.loading) return
    const invalidTabIds = Object.keys(chatSessions.sessionsByTab).filter(tabId => !validChatSessionTabIds.has(tabId))
    if (invalidTabIds.length === 0) return
    const removed = chatSessions.pruneTabs(validChatSessionTabIds)
    if (removed.length === 0) return
    for (const id of removed) bridges.releaseTab(id)
    setMessagesByTab(prev => {
      const next = { ...prev }
      let changed = false
      for (const id of removed) {
        // Never drop a transcript that still has history on the reconciliation
        // prune — a lagging tab/session record (e.g. an abrupt quit that skipped
        // the unload flush) would otherwise wipe a real conversation. Explicit
        // removeSession() still clears messages for user-initiated deletions.
        if ((prev[id]?.length ?? 0) > 0) continue
        delete next[id]
        changed = true
      }
      return changed ? next : prev
    })
  }, [ws.loading, bridges, chatSessions, setMessagesByTab, validChatSessionTabIds])

  const removeSession = useCallback((session: Session) => {
    const targetWs = ws.workspaces.find(w => session.tabId === `${w.id}-chat` || session.tabId.startsWith(`${w.id}-chat-`))
    const tabSessions = chatSessions.getSessions(session.tabId)
    const removingKnownLast = tabSessions.length <= 1 && tabSessions.some(s => s.id === session.id)
    const { removed, nextActive } = chatSessions.remove(session.tabId, session.id)
    const tabBecameEmpty = !removed && removingKnownLast
    const removedIds = removed ? [session.id] : (tabBecameEmpty ? chatSessions.releaseTab(session.tabId) : [])
    if (removedIds.length === 0) return
    forgetChatRecency(removedIds)
    // Release each removed session's bridges by EXACT scope. Using releaseTab here
    // would prefix-match and kill sibling sessions' bridges (e.g. deleting `tab`
    // also matches `tab::s2`), freezing whatever session the user is currently in.
    for (const id of removedIds) bridges.releaseScope(id, { stopRunning: true })
    // Deleting from the archive must not yank the user into that chat's tab.
    if (removed && nextActive && targetWs && !session.archived) {
      jumpToWorkspaceTab(targetWs.id, session.tabId)
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('crewcode:focus-composer')), 80)
    }
    if (tabBecameEmpty && targetWs) closeTabInWorkspace(targetWs.id, session.tabId)
    if (tabBecameEmpty) {
      pty.clearTab(session.tabId)
      setChatUiByTab(prev => {
        if (!(session.tabId in prev)) return prev
        const next = { ...prev }
        delete next[session.tabId]
        return next
      })
    }
    setMessagesByTab(prev => {
      const next = { ...prev }
      for (const id of removedIds) delete next[id]
      return next
    })
    // User-initiated delete: drop the authoritative on-disk transcript too, so a
    // removed session doesn't resurrect from L2 on the next launch. (The
    // reconciliation prune deliberately does NOT remove disk files.)
    for (const id of removedIds) window.electronAPI?.transcriptsRemove?.(id)
  }, [bridges, chatSessions, closeTabInWorkspace, forgetChatRecency, jumpToWorkspaceTab, pty, setMessagesByTab, ws.workspaces])

  // Archive a chat: hide it from every live surface and release its bridge
  // (archiving is also how you free an idle agent), but keep the session record
  // and its on-disk transcript so restoring brings the full thread back.
  const archiveSession = useCallback((session: Session) => {
    const { changed } = chatSessions.setArchived(session.tabId, session.id, true)
    if (!changed) return
    bridges.releaseScope(session.id, { stopRunning: true })
    forgetChatRecency([session.id])
    // A secondary chat tab with nothing left in it is just noise in the strip.
    // The workspace's canonical chat tab stays — ensureTab seeds it a fresh thread.
    const targetWs = ws.workspaces.find(w => session.tabId === `${w.id}-chat` || session.tabId.startsWith(`${w.id}-chat-`))
    const stillLive = chatSessions.getSessions(session.tabId).some(s => s.id !== session.id)
    if (!stillLive && targetWs && session.tabId !== `${targetWs.id}-chat`) {
      closeTabInWorkspace(targetWs.id, session.tabId)
    }
  }, [bridges, chatSessions, closeTabInWorkspace, forgetChatRecency, ws.workspaces])

  // Restore an archived chat and jump to it — its tab may have been closed on
  // archive, so rehydrate the tab id before activating.
  const restoreSession = useCallback((session: Session) => {
    const { changed } = chatSessions.setArchived(session.tabId, session.id, false)
    if (!changed) return
    const targetWsId = workspaceByChatTabId[session.tabId]
    const targetWs = ws.workspaces.find(w => w.id === targetWsId)
    if (targetWs) {
      restoreChatTabInWorkspace(targetWs.id, targetWs.name, session.tabId)
      jumpToWorkspaceTab(targetWs.id, session.tabId)
    }
    window.setTimeout(() => window.dispatchEvent(new CustomEvent('crewcode:focus-composer')), 80)
  }, [chatSessions, jumpToWorkspaceTab, restoreChatTabInWorkspace, workspaceByChatTabId, ws.workspaces])

  // Flat, cross-workspace view of the archive for the Archive page.
  const archivedEntries = useMemo<ArchivedEntry[]>(() => {
    const out: ArchivedEntry[] = []
    for (const workspace of ws.workspaces) {
      for (const session of archivedSessionsByWorkspace[workspace.id] ?? []) {
        out.push({ session, wsId: workspace.id, wsName: workspace.name })
      }
    }
    return out
  }, [archivedSessionsByWorkspace, ws.workspaces])

  // Sessions archived before `archivedAt` existed get their clock started on
  // first launch after upgrading, so a retention window can't retroactively
  // flag history whose real archive date is unknown.
  useEffect(() => {
    if (ws.loading) return
    chatSessions.backfillArchivedAt()
  }, [ws.loading, chatSessions.backfillArchivedAt])

  useEffect(() => {
    if (ws.loading) return
    let cancelled = false
    void getCrewCodeClient().transcriptsMtimes()
      .then(mtimes => { if (!cancelled) chatSessions.backfillSessionTimestamps(mtimes) })
      .catch(() => { if (!cancelled) chatSessions.backfillSessionTimestamps({}) })
    return () => { cancelled = true }
  }, [ws.loading, chatSessions.backfillSessionTimestamps])

  const renameSession = useCallback((session: Session, label: string) => {
    const next = label.trim()
    if (!next || next === session.label) return
    chatSessions.update(session.tabId, session.id, { label: next })
  }, [chatSessions])

  const toggleSessionPin = useCallback((session: Session) => {
    chatSessions.update(session.tabId, session.id, { pinned: !session.pinned })
  }, [chatSessions])

  // ── Crew orchestration ──────────────────────────────────────────────────
  const crewCtl = useCrewOrchestration({
    activeWs, activeTabId, activeWorkspace, agents, effort,
    ws, bridges, pty, setMessagesForTab,
  })
  const { crew, crewSession, crewTabs } = crewCtl

  // Solo chat tabs in the active workspace the git sidebar's "ask agent" can
  // target. Crew-session host tabs are excluded — their composer isn't a plain
  // solo thread. Labelled by the active session so the dropdown reads naturally.
  const gitChatTargets = useMemo(
    () => tabs
      .filter(t => t.kind === 'chat' && !crew.sessions[t.id])
      .map(t => ({ id: t.id, label: chatSessions.getActiveSession(t.id)?.label || t.label })),
    [tabs, crew.sessions, chatSessions],
  )

  const navigateToChatScope = useCallback((scopeId: string) => {
    const session = sessionById[scopeId]
    const chatTabId = session?.tabId ?? (scopeId.includes('::') ? scopeId.split('::')[0] : scopeId)
    const targetWsId = workspaceByChatTabId[chatTabId] ?? tabInfoById[chatTabId]?.wsId ?? activeWs
    const targetWs = ws.workspaces.find(w => w.id === targetWsId)

    if (targetWs) restoreChatTabInWorkspace(targetWs.id, targetWs.name, chatTabId)
    if (targetWsId) jumpToWorkspaceTab(targetWsId, chatTabId)
    else setActiveTabId(chatTabId)
    if (session) chatSessions.activate(session.tabId, session.id)
  }, [chatSessions, jumpToWorkspaceTab, restoreChatTabInWorkspace, sessionById, setActiveTabId, tabInfoById, workspaceByChatTabId, ws.workspaces])

  const mobileThreadDeepLinkHandledRef = useRef(false)
  useEffect(() => {
    if (mobileThreadDeepLinkHandledRef.current || ws.loading) return
    const query = new URLSearchParams(window.location.search)
    const scopeId = query.get('thread')?.trim() ?? ''
    if (!scopeId) return
    const tabId = query.get('threadTab')?.trim() ?? ''
    const workspaceId = query.get('threadWorkspace')?.trim() ?? ''
    const label = query.get('threadLabel')?.trim() ?? 'Recovered thread'
    const agentHint = query.get('threadAgent')?.trim() ?? ''
    const workspace = ws.workspaces.find(item => item.id === workspaceId)
    const ownsTab = !!workspace && (tabId === workspace.id || tabId.startsWith(`${workspace.id}-`))
    const ownsScope = scopeId === tabId || scopeId.startsWith(`${tabId}::s`)
    if (!workspace || !ownsTab || !ownsScope || scopeId.length > 512 || tabId.length > 512) {
      mobileThreadDeepLinkHandledRef.current = true
      return
    }
    const restored = chatSessions.restoreRemote({
      id: scopeId,
      tabId,
      label,
      ...(agents.some(agent => agent.id === agentHint) ? { agentId: agentHint } : {}),
    })
    if (!restored) {
      mobileThreadDeepLinkHandledRef.current = true
      return
    }
    if (restored.archived) chatSessions.setArchived(restored.tabId, restored.id, false)
    restoreChatTabInWorkspace(workspace.id, workspace.name, tabId)
    setActiveWs(workspace.id)
    setActiveTabInWorkspace(workspace.id, tabId)
    chatSessions.activate(tabId, scopeId)
    mobileThreadDeepLinkHandledRef.current = true
    for (const key of ['thread', 'threadTab', 'threadWorkspace', 'threadLabel', 'threadAgent']) query.delete(key)
    window.history.replaceState(null, '', `${window.location.pathname}?${query.toString()}`)
  }, [agents, chatSessions, restoreChatTabInWorkspace, setActiveTabInWorkspace, ws.loading, ws.workspaces])

  const voiceNotificationSource = useCallback((scopeId: string): { chatName: string; workspaceName?: string } => {
    const session = sessionById[scopeId]
    const chatTabId = session?.tabId ?? (scopeId.includes('::') ? scopeId.split('::')[0] : scopeId)
    const workspaceId = workspaceByChatTabId[chatTabId] ?? tabInfoById[chatTabId]?.wsId ?? activeWs
    const workspace = ws.workspaces.find(w => w.id === workspaceId)
    const chatName = session?.label?.trim() || tabInfoById[chatTabId]?.label || workspace?.name || 'Chat'
    return {
      chatName,
      workspaceName: workspace?.name && workspace.name !== chatName ? workspace.name : undefined,
    }
  }, [activeWs, sessionById, tabInfoById, workspaceByChatTabId, ws.workspaces])

  const subscribeBridgeTurnEnd = bridges.subscribeTurnEnd
  const subscribeBridgeActivity = bridges.subscribeActivity
  const [agentDoneByScope, setAgentDoneByScope] = useState<Record<string, boolean>>({})
  const notifiedAgentRepliesRef = useRef<Set<string>>(new Set())
  // Native-notification coalescing: agents in a crew often finish within a beat
  // of each other. Buffer pending turn-complete pings and flush them as a single
  // OS notification ("3 agents finished") instead of a storm of toasts.
  const nativeNotifyBufferRef = useRef<Array<{ chatName: string; preview: string; scopeId: string }>>([])
  const nativeNotifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const NATIVE_NOTIFY_COALESCE_MS = 1500
  // Read live in the turn-end handler without re-subscribing the listener when
  // the toggle flips.
  const nativeNotificationsRef = useRef(settings.nativeNotifications)
  nativeNotificationsRef.current = settings.nativeNotifications
  const notificationSoundRef = useRef(settings.notificationSound)
  notificationSoundRef.current = settings.notificationSound

  const flushNativeNotifications = useCallback(() => {
    nativeNotifyTimerRef.current = null
    const pending = nativeNotifyBufferRef.current
    nativeNotifyBufferRef.current = []
    if (pending.length === 0) return
    const sound = notificationSoundRef.current
    playNotificationSound(sound)
    const silent = !usesNativeNotificationSound(sound)
    if (pending.length === 1) {
      const { chatName, preview, scopeId } = pending[0]
      void window.electronAPI?.notify({ title: `${chatName} finished`, body: preview, scopeId, silent })
      return
    }
    // Multiple sessions completed in the window — one summary ping, deep-link to
    // the most recent so a click still lands somewhere useful.
    const last = pending[pending.length - 1]
    void window.electronAPI?.notify({
      title: `${pending.length} agents finished`,
      body: pending.map(p => p.chatName).join(', '),
      scopeId: last.scopeId,
      silent,
    })
  }, [])

  const queueNativeNotification = useCallback((entry: { chatName: string; preview: string; scopeId: string }) => {
    // Gate on focus here (renderer-side) so a watched window stays quiet; the
    // main process fires the toast unconditionally once asked.
    if (typeof document !== 'undefined' && document.hasFocus()) return
    nativeNotifyBufferRef.current.push(entry)
    if (nativeNotifyTimerRef.current) clearTimeout(nativeNotifyTimerRef.current)
    nativeNotifyTimerRef.current = setTimeout(flushNativeNotifications, NATIVE_NOTIFY_COALESCE_MS)
  }, [flushNativeNotifications])

  // Clicking a native toast focuses the window (main process) and routes us to
  // the chat that produced it.
  useEffect(() => {
    return window.electronAPI?.onNotificationClick(({ scopeId }) => {
      if (!scopeId) return
      if (scopeId.startsWith('pane:')) {
        const paneId = scopeId.slice('pane:'.length)
        const pane = pty.panes.find(p => p.paneId === paneId)
        if (pane) jumpToWorkspaceTab(pane.wsId, pane.tabId)
        return
      }
      navigateToChatScope(scopeId)
    })
  }, [jumpToWorkspaceTab, navigateToChatScope, pty.panes])

  useEffect(() => {
    return subscribeBridgeActivity((_bridgeId, scopeId, type) => {
      if (type !== 'turn_start') return
      setAgentDoneByScope(prev => {
        if (!prev[scopeId]) return prev
        const next = { ...prev }
        delete next[scopeId]
        return next
      })
    })
  }, [subscribeBridgeActivity])

  useEffect(() => {
    return subscribeBridgeTurnEnd((_bridgeId, scopeId, turnId) => {
      const messages = useMessagesStore.getState().messagesByTab[scopeId] ?? []
      const reply = latestFinalAgentReply(messages, turnId)
      if (!reply?.text) return
      setAgentDoneByScope(prev => prev[scopeId] ? prev : { ...prev, [scopeId]: true })
      const key = `${scopeId}:${reply.turnId ?? reply.processId ?? replyPreview(reply.text)}`
      if (notifiedAgentRepliesRef.current.has(key)) return
      notifiedAgentRepliesRef.current.add(key)
      if (notifiedAgentRepliesRef.current.size > 500) {
        notifiedAgentRepliesRef.current = new Set([...notifiedAgentRepliesRef.current].slice(-250))
      }

      const session = sessionById[scopeId]
      const chatTabId = session?.tabId ?? (scopeId.includes('::') ? scopeId.split('::')[0] : scopeId)
      const workspaceId = workspaceByChatTabId[chatTabId] ?? tabInfoById[chatTabId]?.wsId ?? activeWs
      const workspace = ws.workspaces.find(w => w.id === workspaceId)
      const chatName = session?.label?.trim() || tabInfoById[chatTabId]?.label || workspace?.name || 'Chat'
      const providerId = session?.agentId || 'pi'
      const workspaceName = workspace?.name && workspace.name !== chatName ? workspace.name : undefined
      const preview = replyPreview(reply.text)
      if (!preview) return

      completeChatRecency(scopeId)
      show({
        type: 'info',
        message: `${chatName}: ${preview}`,
        duration: 9000,
        chatReply: {
          providerId,
          chatName,
          preview,
          workspaceName,
        },
        onClick: () => navigateToChatScope(scopeId),
      })
      if (nativeNotificationsRef.current) {
        queueNativeNotification({ chatName, preview, scopeId })
      }
    })
  }, [activeWs, completeChatRecency, navigateToChatScope, queueNativeNotification, sessionById, show, subscribeBridgeTurnEnd, tabInfoById, workspaceByChatTabId, ws.workspaces])

  const workspaceAgentStatus = useMemo<Record<string, AgentActivityState | undefined>>(() => {
    const byWorkspace: Record<string, AgentActivityState | undefined> = {}
    for (const workspace of ws.workspaces) {
      const workspaceSessions = sessionsByWorkspace[workspace.id] ?? []
      if (workspaceSessions.some(session => bridges.isBridgeRunning(session.id, session.agentId))) {
        byWorkspace[workspace.id] = 'working'
      } else if (workspaceSessions.some(session => agentDoneByScope[session.id])) {
        byWorkspace[workspace.id] = 'done'
      }
    }
    return byWorkspace
  }, [agentDoneByScope, bridges, sessionsByWorkspace, ws.workspaces])

  // Per-session activity state for the drawer session list spinners.
  const sessionAgentStatus = useMemo<Record<string, AgentActivityState | undefined>>(() => {
    const bySession: Record<string, AgentActivityState | undefined> = {}
    for (const sessions of Object.values(sessionsByWorkspace)) {
      for (const session of sessions) {
        if (bridges.isBridgeRunning(session.id, session.agentId)) {
          bySession[session.id] = 'working'
        } else if (agentDoneByScope[session.id]) {
          bySession[session.id] = 'done'
        }
      }
    }
    return bySession
  }, [agentDoneByScope, bridges, sessionsByWorkspace])

  // Live running chats, flattened across workspaces for the drawer's Working
  // section. Preserve workspace/session order; membership updates directly from
  // bridge activity through sessionAgentStatus.
  const workingChats = useMemo<WorkingChatEntry[]>(() => {
    const entries: WorkingChatEntry[] = []
    for (const workspace of ws.workspaces) {
      for (const session of sessionsByWorkspace[workspace.id] ?? []) {
        if (sessionAgentStatus[session.id] !== 'working') continue
        entries.push({
          sessionId: session.id,
          tabId: session.tabId,
          wsId: workspace.id,
          label: session.label,
          wsName: workspace.name,
          agentId: session.agentId,
        })
      }
    }
    return entries.slice(0, 6)
  }, [sessionAgentStatus, sessionsByWorkspace, ws.workspaces])

  // Notification hosts render below so their store subscriptions stay off App's
  // hot streaming path; final reply alerts use bridge turn-end events above.

  // ── Prompt Builder / picker ──────────────────────────────────────────────
  // ONE library instance lives here. PromptBuilder and the composer picker
  // both receive `promptLib` as props so every surface (page, picker, the
  // chat skill strip) reads from the same React state — without this, a
  // toggle in one surface would only be visible elsewhere after a reload
  // (localStorage doesn't notify sibling hooks). Declared above useComposerSend
  // so skill state can flow into the send pipeline.
  const promptFiles = useCrewcodePromptFiles()
  const promptLib = usePromptLibrary(promptFiles.prompts, promptFiles.skills)
  const appliedSkills = useAppliedSkillsBySession()
  const appliedModes = useAppliedModesBySession()
  const enabledSkillsForSession = useCallback((sessionId: string): SkillDef[] => {
    const session = Object.values(sessionsByWorkspace)
      .flat()
      .find(candidate => candidate.id === sessionId)
    const enabledIds = new Set(session?.enabledSkillIds ?? [])
    return promptLib.skills.filter(skill => enabledIds.has(skill.id))
  }, [promptLib.skills, sessionsByWorkspace])
  const skillsDeliveredTo = useCallback((sessionId: string): string[] =>
    appliedSkills.state[sessionId] ?? [],
    [appliedSkills.state],
  )
  const lastDeliveredMode = useCallback((sessionId: string): ModeLevel | undefined =>
    appliedModes.lastDelivered(sessionId),
    [appliedModes],
  )
  const markModeDelivered = useCallback((sessionId: string, mode: ModeLevel) =>
    appliedModes.markDelivered(sessionId, mode),
    [appliedModes],
  )
  const canvasModePromptControl = useCallback((paneId: string) => {
    const session = chatSessions.getActiveSession(paneId)
    if (!session) return undefined
    const locked = (useMessagesStore.getState().messagesByTab[session.id]?.length ?? 0) > 0
      || lastDeliveredMode(session.id) !== undefined
    return {
      enabled: session.modePromptsEnabled ?? true,
      locked,
      onToggle: () => {
        const current = chatSessions.getActiveSession(paneId)
        if (!current) return
        const currentLocked = (useMessagesStore.getState().messagesByTab[current.id]?.length ?? 0) > 0
          || lastDeliveredMode(current.id) !== undefined
        if (currentLocked) return
        chatSessions.update(paneId, current.id, {
          modePromptsEnabled: !(current.modePromptsEnabled ?? true),
        })
      },
    }
  }, [chatSessions, lastDeliveredMode])
  const [promptPickerOpen, setPromptPickerOpen] = useState(false)
  const [promptPickerTarget, setPromptPickerTarget] = useState<{ sessionId: string; composerId: string } | null>(null)
  const openPromptPicker = useCallback((sessionId: string | null | undefined, composerId: string) => {
    if (!sessionId || !composerId) return
    setPromptPickerTarget({ sessionId, composerId })
    setPromptPickerOpen(true)
  }, [])
  const closePromptPicker = useCallback(() => {
    setPromptPickerOpen(false)
    setPromptPickerTarget(null)
  }, [])

  // ── Solo send ───────────────────────────────────────────────────────────
  const displayTabs = useMemo(() => tabs.map(tab => {
    if (tab.kind === 'code') {
      const editorSession = codeEditors.sessions[tab.id]
      const activeFile = editorSession?.tabs.find(file => file.rel === editorSession.activeRel)
      return { ...tab, label: activeFile?.name ?? 'Editor' }
    }
    if (tab.kind === 'chat') {
      const activeSessionId = chatSessions.getActiveId(tab.id)
      const active = chatSessions.getSessions(tab.id).find(session => session.id === activeSessionId)
      const label = active?.label?.trim()
      const running = active ? bridges.isBridgeRunning(active.id, active.agentId) : false
      const agentActivity: AgentActivityState | undefined = running ? 'working' : active && agentDoneByScope[active.id] ? 'done' : undefined
      const next = { ...tab, displayIconProviderId: active?.agentId, agentActivity }
      return label ? { ...next, label } : next
    }
    if (tab.kind === 'terminal') {
      const display = terminalTabDisplay(tab, pty.panes, activeWorkspace.name)
      return { ...tab, label: display.label, displayIconProviderId: display.providerId }
    }
    return tab
  }), [tabs, codeEditors.sessions, chatSessions, bridges, agentDoneByScope, pty.panes, activeWorkspace.name])

  // Ensure editor session buckets exist for all code tabs outside of render
  // so renderTabContent never triggers a state update during React's render phase.
  useEffect(() => {
    for (const tab of tabs) {
      if (tab.kind === 'code') {
        codeEditors.ensureTab(tab.id)
      }
    }
  }, [tabs, codeEditors])

  // Prune editor sessions whose app-tab IDs no longer exist in any workspace.
  useEffect(() => {
    codeEditors.prune(allTabIds)
  }, [allTabIds, codeEditors])

  // Restore terminal sessions for all existing tabs on mount.
  const restoredTerminalsRef = useRef(false)
  useEffect(() => {
    if (restoredTerminalsRef.current) return
    restoredTerminalsRef.current = true
    for (const tabId of new Set([...allTabIds, ...canvasPaneIds])) {
      const tabPanes = pty.getTabPanes(tabId)
      if (tabPanes.length === 0) {
        pty.restoreTab(tabId)
      }
    }
  }, [allTabIds, canvasPaneIds, pty])

  // Prune terminal sessions whose app-tab IDs no longer exist.
  useEffect(() => {
    pty.prune(validRuntimeTabIds)
  }, [validRuntimeTabIds, pty])

  // ── Tab close (after crew + bridges exist) ─────────────────────────────
  const handleCloseTab = (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId)
    if (tab?.pinned) return
    if (tab?.kind === 'chat') {
      // Closing a chat tab only hides that surface; the drawer remains the
      // durable owner of chat sessions, messages, and live bridge runtimes.
      closeTab(tabId)
      return
    }

    if (tab?.kind === 'canvas') {
      const paneSessionIds: string[] = []
      for (const pane of canvasPanesByTab[tabId] ?? []) {
        pty.clearTab(pane.id)
        paneSessionIds.push(...chatSessions.releaseTab(pane.id))
        bridges.releaseTab(pane.id, { stopRunning: true })
      }
      for (const id of paneSessionIds) bridges.releaseTab(id, { stopRunning: true })
      setMessagesByTab(prev => {
        const next = { ...prev }
        for (const id of paneSessionIds) delete next[id]
        return next
      })
      setChatUiByTab(prev => {
        const next = { ...prev }
        for (const pane of canvasPanesByTab[tabId] ?? []) delete next[pane.id]
        return next
      })
      setCanvasPanesByTab(prev => {
        if (!(tabId in prev)) return prev
        const next = { ...prev }
        delete next[tabId]
        return next
      })
      for (const id of paneSessionIds) {
        appliedSkills.forgetSession(id)
        appliedModes.forgetSession(id)
      }
    }

    const sessionIds = chatSessions.releaseTab(tabId)
    for (const id of sessionIds) bridges.releaseTab(id)
    bridges.releaseTab(tabId)
    if (crew.sessions[tabId]) crew.discard(tabId)
    closeTab(tabId)
    codeEditors.removeTab(tabId)
    pty.clearTab(tabId)
    setChatUiByTab(prev => {
      if (!(tabId in prev)) return prev
      const next = { ...prev }
      delete next[tabId]
      return next
    })
    // Forget the per-session skill and mode delivery logs so re-used
    // session ids re-inject the active skills and mode prompts.
    for (const id of sessionIds) {
      appliedSkills.forgetSession(id)
      appliedModes.forgetSession(id)
    }
  }

  // ── Drawer & palette ─────────────────────────────────────────────────────
  const [drawerOpen,  setDrawerOpen]  = useState(() => settings.onLaunch === 'workspaces drawer')
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [addOpen,     setAddOpen]     = useState(false)

  useEffect(() => {
    if (paletteOpen) void refreshPluginTabs()
  }, [paletteOpen, refreshPluginTabs])

  // Drop a prompt body into the active chat tab's composer. If the active tab
  // isn't a chat tab, open the workspace chat first so the user has somewhere
  // to land.
  const insertPromptIntoComposer = useCallback((body: string, p?: PromptDef): void => {
    const isChat = activeTab?.kind === 'chat'
    const targetTabId = isChat
      ? activeTabId
      : (tabs.find(t => t.kind === 'chat')?.id ?? (hasWsForInsert() ? handleNewTab('chat') : undefined))
    if (!targetTabId) return
    if (!isChat) setActiveTabId(targetTabId)
    composerDraftActions().set(targetTabId, current => (current ? `${current}\n\n${body}` : body))
  }, [activeTab, activeTabId, tabs, setActiveTabId, handleNewTab, chatSessions])

  const handleUsePromptFromBuilder = (p: PromptDef): void => {
    promptLib.incUsage('prompts', p.id)
    insertPromptIntoComposer(p.body, p)
  }

  const handleApplySkill = (s: SkillDef): void => {
    show({
      type:    'info',
      message: s.enabled
        ? `Applied · ${s.title} Skill — ( To context )`
        : `Removed · ${s.title} Skill — ( Agent keeps it in context for past turns )`,
    })
  }

  const toggleSkillForSession = useCallback((sessionId: string, id: string): boolean | null => {
    const session = Object.values(sessionsByWorkspace)
      .flat()
      .find(candidate => candidate.id === sessionId)
    if (!session) return null
    const ids = session.enabledSkillIds ?? []
    const enabled = !ids.includes(id)
    chatSessions.update(session.tabId, session.id, {
      enabledSkillIds: enabled ? [...ids, id] : ids.filter(skillId => skillId !== id),
    })
    return enabled
  }, [chatSessions, sessionsByWorkspace])
  const promptBuilderChatTab = tabs.find(tab => tab.kind === 'chat')
  const promptBuilderSessionId = lastSoloSessionIdRef.current
    ?? (promptBuilderChatTab ? chatSessions.getActiveId(promptBuilderChatTab.id) : null)
  const promptBuilderEnabledIds = new Set(
    promptBuilderSessionId
      ? enabledSkillsForSession(promptBuilderSessionId).map(skill => skill.id)
      : [],
  )
  const promptBuilderLib = {
    ...promptLib,
    skills: promptLib.skills.map(skill => ({
      ...skill,
      enabled: promptBuilderEnabledIds.has(skill.id),
    })),
    toggleSkillEnabled: (id: string) => {
      if (promptBuilderSessionId) toggleSkillForSession(promptBuilderSessionId, id)
    },
  }

  const browserGrabChatTargets = useMemo<BrowserGrabChatTarget[]>(() => {
    return tabs
      .filter(tab => tab.kind === 'chat')
      .flatMap(tab => {
        const sessionsForTab = chatSessions.getSessions(tab.id)
        if (sessionsForTab.length === 0) {
          return [{
            key: `${tab.id}:${tab.id}`,
            tabId: tab.id,
            sessionId: tab.id,
            tabLabel: tab.label,
            sessionLabel: 'Session 1',
          }]
        }
        return sessionsForTab.map(session => ({
          key: `${tab.id}:${session.id}`,
          tabId: tab.id,
          sessionId: session.id,
          tabLabel: tab.label,
          sessionLabel: session.label,
        }))
      })
    // messagesByTab intentionally omitted: the body reads only tabs + sessions,
    // so keeping it as a dep recomputed this list on every streamed token.
  }, [tabs, chatSessions])

  useEffect(() => {
    const onBrowserGrab = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; action?: string; selection?: BrowserGrabSelectionPayload }>).detail
      if (detail?.kind !== 'selection' || detail?.action !== 'send' || !detail.selection) return
      setPendingBrowserGrabSend({ selection: detail.selection })
    }

    window.addEventListener('crewcode:browser-grab', onBrowserGrab as EventListener)
    return () => window.removeEventListener('crewcode:browser-grab', onBrowserGrab as EventListener)
  }, [])

  // ─── Delegation ────────────────────────────────────────────────────────────
  // Agent-created threads. The hook answers main's marshalled HTTP calls; these
  // callbacks give it the same session/bridge/message paths the UI uses, so a
  // delegated thread is indistinguishable from one you opened yourself.
  const allDelegationSessions = useCallback(
    () => Object.values(chatSessions.sessionsByTab).flat() as Session[],
    [chatSessions.sessionsByTab],
  )
  const sendToDelegatedSession = useCallback(async (session: Session, text: string) => {
    const wsId = workspaceByChatTabId[session.tabId] ?? activeWs
    const workspace = ws.workspaces.find(w => w.id === wsId) ?? activeWorkspace
    // Read-only children share the parent's worktree; a write-capable child
    // supplies its own path once step 6 lands.
    const cwd = session.delegatedWorktreePath ?? workspace.path
    const pane = [...pty.panes].reverse().find(p => p.tabId === session.tabId && p.agentId === session.agentId) ?? null

    chatSessions.touchLastUsed(session.tabId, session.id)
    await sendChatSessionPrompt({
      text,
      activeWs: wsId,
      activeTabId: session.tabId,
      sessActive: session.id,
      setMessages: (updater) => {
        setMessagesByTab(prev => ({ ...prev, [session.id]: updater(prev[session.id] ?? []) }))
      },
      agents,
      activeAgentId: session.agentId,
      model: session.model,
      effort: session.effort,
      mode: normalizeModeLevel(session.mode),
      effectivePath: cwd,
      bridges,
      pty,
      activeAgentPane: pane,
      // Delegated threads start clean: the brief is the whole context. Skills and
      // the parent's applied modes are not inherited.
      enabledSkills: [],
      skillsDeliveredTo,
      markSkillsDelivered: appliedSkills.markDelivered,
      lastDeliveredMode,
      markModeDelivered,
      modePromptsEnabled: session.modePromptsEnabled ?? true,
      modePrompts: settings.modePrompts,
      sessionHasExistingMessages: (useMessagesStore.getState().messagesByTab[session.id]?.length ?? 0) > 0,
    })
  }, [
    activeWorkspace, activeWs, agents, appliedSkills.markDelivered, bridges, chatSessions, lastDeliveredMode,
    markModeDelivered, pty, setMessagesByTab, settings.modePrompts,
    skillsDeliveredTo, workspaceByChatTabId, ws.workspaces,
  ])

  const delegationProviders = useCallback(
    () => describeProviders(
      agents,
      knownModelIds,
      agentId => knownModelIds(agentId)[0],
    ),
    [agents],
  )

  useDelegatedThreads({
    allSessions: allDelegationSessions,
    tabIdForSession: useCallback((sessionId: string) => sessionById[sessionId]?.tabId, [sessionById]),
    messagesForSession: useCallback(
      (sessionId: string) => useMessagesStore.getState().messagesByTab[sessionId] ?? [],
      [],
    ),
    isRunning: useCallback((sessionId: string) => {
      const session = sessionById[sessionId]
      return session ? bridges.isBridgeRunning(session.id, session.agentId) : false
    }, [bridges, sessionById]),
    completedAtForSession: useCallback((sessionId: string) => completedAtByScope[sessionId], [completedAtByScope]),
    addDelegated: chatSessions.addDelegated,
    sendToSession: sendToDelegatedSession,
    // Deliberately NOT setArchived: an agent marking its own work done must not
    // hide a chat the user may not be finished with. Archiving stays a user
    // action in the drawer's context menu.
    setThreadClosed: useCallback((tabId: string, sessionId: string, closed: boolean) => {
      chatSessions.update(tabId, sessionId, { delegationClosedAt: closed ? Date.now() : undefined })
    }, [chatSessions]),
    providers: delegationProviders,
    createWorktree: useCallback(async (parentSessionId: string, title: string) => {
      const parent = sessionById[parentSessionId]
      const wsId = parent ? workspaceByChatTabId[parent.tabId] : undefined
      const workspace = ws.workspaces.find(w => w.id === wsId)
      if (!workspace) return { ok: false as const, error: 'the delegating chat has no workspace' }
      if (workspace.kind === 'remote') {
        return { ok: false as const, error: 'delegation is unavailable in remote (ssh://) workspaces' }
      }
      if (workspace.kind !== 'repo') {
        return { ok: false as const, error: 'write-capable delegated threads need a git repository; this workspace is a plain folder' }
      }

      // Fork from the branch the delegating chat is on, and record it as the ref
      // the child's work merges back onto. `effectiveBranch` is '—' when unknown,
      // in which case git forks from HEAD.
      const base = effectiveBranch && effectiveBranch !== '—' ? effectiveBranch : undefined
      const branch = delegatedBranchName(title, branchSuffix())
      const created = await ws.createWorktree(workspace.id, branch, base)
      if (!created || 'error' in created || !created.path) {
        return { ok: false as const, error: ('error' in (created ?? {}) ? created.error : undefined) ?? 'could not create the worktree' }
      }
      return { ok: true as const, path: created.path, branch, ...(base ? { base } : {}) }
    }, [effectiveBranch, sessionById, workspaceByChatTabId, ws]),
    spawnCohort: useCallback((parentSessionId: string) => ({
      runId: delegationInbox.runId(parentSessionId),
      duringWake: delegationInbox.isAutonomousTurn(parentSessionId),
    }), []),
    repoPathForSession: useCallback((sessionId: string) => {
      const session = sessionById[sessionId]
      const wsId = session ? workspaceByChatTabId[session.tabId] : undefined
      return ws.workspaces.find(w => w.id === wsId)?.path
    }, [sessionById, workspaceByChatTabId, ws.workspaces]),
    focusSession: useCallback((session: Session) => {
      const targetWs = workspaceForChatTab(session.tabId, ws.workspaces)
      // `setActiveTabId` is bound to the active workspace and goes stale across
      // workspaces — always prefer the workspace-scoped setter when one resolves.
      if (targetWs) {
        if (targetWs.id !== activeWs) setActiveWs(targetWs.id)
        setActiveTabInWorkspace(targetWs.id, session.tabId)
      } else {
        setActiveTabId(session.tabId)
      }
      chatSessions.activate(session.tabId, session.id)
    }, [activeWs, chatSessions, setActiveTabId, setActiveTabInWorkspace, setActiveWs, ws.workspaces]),
  })

  // The push half of delegation: a worker's finished reply goes back to the chat
  // that spawned it instead of waiting to be polled — into a running turn, or by
  // waking an idle parent within its per-user-turn budget.
  useDelegationReports({
    subscribeTurnEnd: bridges.subscribeTurnEnd,
    subscribeActivity: bridges.subscribeActivity,
    sessionById: useCallback((sessionId: string) => sessionById[sessionId], [sessionById]),
    allSessions: allDelegationSessions,
    messagesForSession: useCallback(
      (sessionId: string) => useMessagesStore.getState().messagesByTab[sessionId] ?? [],
      [],
    ),
    isRunning: bridges.isBridgeRunning,
    getBridgeId: bridges.getBridgeId,
    promptBridge: bridges.prompt,
    appendSystemMessage: useCallback((sessionId: string, text: string) => {
      setMessagesByTab(prev => ({
        ...prev,
        [sessionId]: [...(prev[sessionId] ?? []), {
          kind: 'system',
          tone: 'info',
          text,
          time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
        }],
      }))
    }, [setMessagesByTab]),
    wakeEnabled: useCallback(
      () => settings.wakeParentOnDelegatedReport !== false,
      [settings.wakeParentOnDelegatedReport],
    ),
    // The idle sweep reclaims a bridge after 10 minutes, and a worker worth
    // waking for often runs longer than that — so a wake has to be able to
    // revive the parent's agent, not just prompt a bridge that happens to exist.
    ensureBridgeForSession: useCallback(async (session: Session) => {
      const agent = agents.find(a => a.id === session.agentId)
      if (!agent || agent.transport !== 'bridge') return null
      const wsId = workspaceByChatTabId[session.tabId]
      const workspace = ws.workspaces.find(w => w.id === wsId)
      if (!workspace) return null
      const result = await bridges.ensureBridge(
        session.id,
        session.agentId,
        session.agentId as AgentProviderId,
        session.delegatedWorktreePath ?? workspace.path,
        session.model || undefined,
        session.effort,
        normalizeModeLevel(session.mode),
      )
      return 'error' in result ? null : result.bridgeId
    }, [agents, bridges, workspaceByChatTabId, ws.workspaces]),
  })

  const focusComposerSoon = useCallback(() => {
    // Defer one tick so the destination tab can mount its composer first.
    setTimeout(() => window.dispatchEvent(new CustomEvent('crewcode:focus-composer')), 50)
  }, [])

  const sendBrowserGrabToChat = useCallback(async (
    target: { tabId: string; sessionId: string } | null,
    comment: string,
  ) => {
    const selection = pendingBrowserGrabSend?.selection
    if (!selection) return

    const prompt = formatBrowserGrabForChat(selection, comment)

    let targetTabId = target?.tabId
    let targetSessionId = target?.sessionId
    if (!targetTabId || !targetSessionId) {
      targetTabId = handleNewTab('chat')
      targetSessionId = targetTabId
      if (!targetTabId) {
        show({ type: 'error', message: 'failed to create a new chat tab', duration: 4000 })
        return
      }
      chatSessions.ensureTab(targetTabId, activeWorkspace.name)
    }
    if (!targetTabId || !targetSessionId) return

    chatSessions.ensureTab(targetTabId, activeWorkspace.name)
    const targetSession = chatSessions.getSessions(targetTabId).find(session => session.id === targetSessionId) ?? null
    // Read the map imperatively (not a subscription) — this is an event handler
    // that always wants the latest snapshot.
    const scopeMessages = useMessagesStore.getState().messagesByTab[targetSessionId]
    if ((scopeMessages?.length ?? 0) === 0) {
      chatSessions.update(targetTabId, targetSessionId, { label: titleFromFirstMessage(prompt) || activeWorkspace.name })
    }
    const targetMode = targetSession?.mode ?? (settings.defaultMode as ModeLevel)
    const targetEffort = targetSession?.effort ?? 'medium'
    const targetAgentId = targetSession?.agentId ?? settings.defaultAgent ?? 'pi'
    const targetModel = targetSession?.model ?? ''
    const targetPane = [...pty.panes].reverse().find(p => p.tabId === targetTabId && p.agentId === targetAgentId) ?? null

    setActiveTabId(targetTabId)
    chatSessions.activate(targetTabId, targetSessionId)

    chatSessions.touchLastUsed(targetTabId, targetSessionId)
    await sendChatSessionPrompt({
      text: prompt,
      activeWs,
      activeTabId: targetTabId,
      sessActive: targetSessionId,
      setMessages: (updater) => {
        setMessagesByTab(prev => ({
          ...prev,
          [targetSessionId!]: updater(prev[targetSessionId!] ?? []),
        }))
      },
      agents,
      activeAgentId: targetAgentId,
      model: targetModel,
      effort: targetEffort,
      mode: targetMode,
      effectivePath,
      bridges,
      pty,
      activeAgentPane: targetPane,
      enabledSkills: enabledSkillsForSession(targetSessionId),
      skillsDeliveredTo,
      markSkillsDelivered: appliedSkills.markDelivered,
      lastDeliveredMode,
      markModeDelivered,
      modePromptsEnabled: targetSession?.modePromptsEnabled ?? true,
      modePrompts: settings.modePrompts,
      sessionHasExistingMessages: (scopeMessages?.length ?? 0) > 0,
    })

    setPendingBrowserGrabSend(null)
    focusComposerSoon()
    show({ type: 'success', message: 'grabbed element sent to chat', duration: 2600 })
  }, [
    activeWs,
    activeWorkspace.name,
    agents,
    appliedSkills.markDelivered,
    bridges,
    chatSessions,
    effectivePath,
    enabledSkillsForSession,
    focusComposerSoon,
    handleNewTab,
    lastDeliveredMode,
    markModeDelivered,
    pendingBrowserGrabSend,
    pty,
    setActiveTabId,
    setMessagesByTab,
    settings.defaultAgent,
    settings.defaultMode,
    settings.modePrompts,
    show,
    skillsDeliveredTo,
  ])

  // Tiny helper — `hasWs` is declared lower, but we need a chat tab to land in.
  function hasWsForInsert(): boolean { return !!activeWs && ws.workspaces.length > 0 }

  // ── Terminal helpers (split direction + sizes live in useTerminalSessions) ─
  const openTerminalSplit = useCallback((dir: 'right' | 'down') => {
    if (!activeWs) { show({ type: 'info', message: 'open a workspace before splitting a terminal' }); return }
    setTweak('showTerminal', true)
    pty.splitTab(activeTabId, activeWs, effectivePath, dir, effectiveShell(settings))
  }, [activeTabId, activeWs, effectivePath, pty, setTweak, settings, show])

  useEffect(() => {
    if (!activeWs || activeTab?.kind !== 'terminal') return
    pty.ensurePane(activeTab.id, activeWs, effectivePath, effectiveShell(settings))
  }, [activeTab, activeWs, effectivePath, pty, settings])

  // Auto-focus the destination surface when the user switches into a chat or
  // terminal tab, so they can start typing without clicking first. Deferred a
  // tick so the surface mounts/reveals before it takes focus.
  const activeTabKind = activeTab?.kind
  useEffect(() => {
    if (activeTabKind !== 'chat' && activeTabKind !== 'terminal') return
    const event = activeTabKind === 'chat' ? 'crewcode:focus-composer' : 'crewcode:focus-terminal'
    const t = setTimeout(() => window.dispatchEvent(new CustomEvent(event)), 60)
    return () => clearTimeout(t)
  }, [activeTabId, activeTabKind])

  // ── Chat right-click context menu ────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    selectionText: string
    soloChat: boolean
  } | null>(null)

  const openChatContextMenu = (event: React.MouseEvent, soloChat: boolean): void => {
    event.preventDefault()
    setCtxMenu({
      x: event.clientX,
      y: event.clientY,
      selectionText: soloChat ? selectedTextWithin(event.currentTarget as HTMLElement) : '',
      soloChat,
    })
  }

  const chatMenuItems: ChatContextMenuItem[] = [
    { id: 'copy',         label: 'Copy',                    icon: 'copy',     kbd: 'Ctrl+C' },
    { id: 'paste',        label: 'Paste',                                     kbd: 'Ctrl+V' },
    ...(ctxMenu?.soloChat && ctxMenu.selectionText
      ? [{
          id: 'read-selection',
          label: 'Read selection aloud',
          disabled: settings.voiceProvider === 'off' || settings.voiceProvider === 'fake',
        } as ChatContextMenuItem]
      : []),
    { id: 'sep1',         label: '', divider: true },
    ...pluginChatActions.map(action => ({
      id: `plugin:chat:${action.registrationId}`,
      label: action.title,
      icon: 'plug' as const,
    })),
    ...(pluginChatActions.length ? [{ id: 'sep-plugin-chat', label: '', divider: true } as ChatContextMenuItem] : []),
    { id: 'clear-chat',   label: 'Clear Chat' },
  ]

  const onChatMenuPick = (id: string) => {
    if (id.startsWith('plugin:chat:')) {
      const registrationId = id.slice('plugin:chat:'.length)
      const action = pluginChatActions.find(candidate => candidate.registrationId === registrationId)
      if (action) {
        runPluginActionTarget(action, { source: 'chat-action' })
        show({ type: 'info', message: `${action.title}: current chat`, duration: 2500 })
      }
      return
    }
    switch (id) {
      case 'copy':         document.execCommand('copy'); return
      case 'paste':        document.execCommand('paste'); return
      case 'read-selection': {
        const text = ctxMenu?.selectionText ?? ''
        if (!text) return
        const provider = settings.voiceProvider
        const voice = provider === 'openai'
          ? settings.voiceOpenAIVoice
          : provider === 'xai'
            ? settings.voiceXaiVoice
            : settings.voiceLocalVoice
        void playSelectionSpeech({
          provider,
          text,
          voice,
          localPythonPath: settings.voiceLocalPythonPath,
          localDevice: settings.voiceLocalDevice,
          localSpeed: settings.voiceProvider === 'local' ? settings.voiceLocalSpeed : undefined,
        }).then(error => {
          if (error) show({ type: 'error', message: error })
        })
        return
      }
      case 'clear-chat':
        if (sessActive) setMessagesByTab(prev => ({ ...prev, [sessActive]: [] }))
        return
    }
  }

  // ── Centralized shortcut dispatcher ──────────────────────────────────────
  // Single switch table for every action in `SHORTCUTS`. Component-local
  // actions (Composer send-message, terminal clear-pane, etc.) are handled by
  // dispatching a synthetic keydown matching their chord — the local
  // listener at window level picks them up. The global useGlobalShortcuts
  // hook skips LOCAL_SHORTCUTS so we never double-handle a real keypress.
  // Workspace navigation behaves like browser back/forward history. Each entry
  // remembers the tab and active chat session that was visible in that workspace.
  const navigateWorkspaceHistory = useCallback((delta: -1 | 1) => {
    const moved = moveInWorkspaceHistory(
      workspaceNavigationHistoryRef.current,
      delta,
      new Set(ws.workspaces.map(workspace => workspace.id)),
    )
    if (!moved.visit) return
    workspaceNavigationHistoryRef.current = moved.history
    const target = moved.visit
    startTransition(() => {
      setActiveTabInWorkspace(target.wsId, target.tabId)
      setActiveWs(target.wsId)
    })
    if (target.sessionId) chatSessions.activate(target.tabId, target.sessionId)
  }, [chatSessions, setActiveTabInWorkspace, ws.workspaces])

  const navigateTabHistory = useCallback((delta: -1 | 1) => {
    if (!activeWs) return
    const history = tabNavigationHistoryByWorkspaceRef.current[activeWs]
      ?? EMPTY_WORKSPACE_NAVIGATION_HISTORY
    const moved = moveInTabHistory(history, delta, new Set(tabs.map(tab => tab.id)))
    if (!moved.visit) return
    tabNavigationHistoryByWorkspaceRef.current[activeWs] = moved.history
    setActiveTabId(moved.visit.tabId)
    if (moved.visit.sessionId) chatSessions.activate(moved.visit.tabId, moved.visit.sessionId)
  }, [activeWs, chatSessions, setActiveTabId, tabs])

  const openInEditor = useCallback(() => {
    const path = activeWorkspace.path
    if (!path) { show({ message: 'no active workspace to open', type: 'info' }); return }
    window.electronAPI?.openInEditor(path).then(r => {
      if (!r?.ok) show({ message: r?.error ?? 'failed to launch editor', type: 'error' })
    })
  }, [activeWorkspace.path, show])

  const startCrewFromAnywhere = useCallback((): void => {
    if (!activeWs) {
      show({ type: 'info', message: 'choose a workspace before starting a crew' })
      setDrawerOpen(true)
      return
    }

    // Crew sessions are standalone work surfaces; never reuse or convert a solo
    // chat tab, so multiple crew tabs can run side-by-side in one workspace.
    const targetTabId = openTabInWorkspace(activeWs, activeWorkspace.name, 'crew')
    if (!targetTabId) return

    setActiveTabId(targetTabId)
    crewCtl.startCrewForTab(targetTabId)
  }, [activeWs, crewCtl, openTabInWorkspace, activeWorkspace.name, setActiveTabId, show, setDrawerOpen])

  const startCanvasFromAnywhere = useCallback((): void => {
    if (!activeWs) {
      show({ type: 'info', message: 'choose a workspace before opening Canvas Mode' })
      setDrawerOpen(true)
      return
    }
    const targetTabId = openTabInWorkspace(activeWs, activeWorkspace.name, 'canvas')
    if (targetTabId) setActiveTabId(targetTabId)
  }, [activeWs, activeWorkspace.name, openTabInWorkspace, setActiveTabId, setDrawerOpen, show])

  const addCanvasPane = useCallback((canvasTabId: string, kind: CanvasPaneKind): string | undefined => {
    if (!activeWs || !canvasTabId) return undefined
    canvasPaneCounterRef.current += 1
    // Prefix with the workspace chat namespace so canvas-owned chats are not
    // mistaken for orphaned sessions by the existing reconciliation pass.
    const id = `${activeWs}-chat-canvas-${canvasTabId}-${kind}-${Date.now().toString(36)}-${canvasPaneCounterRef.current}`
    const title = kind === 'chat' ? `Workbench Chat ${canvasPaneCounterRef.current}` : `Workbench Terminal ${canvasPaneCounterRef.current}`
    setCanvasPanesByTab(prev => ({
      ...prev,
      [canvasTabId]: [...(prev[canvasTabId] ?? []), { id, kind, title }],
    }))
    if (kind === 'chat') chatSessions.ensureTab(id, activeWorkspace.name)
    if (kind === 'terminal') pty.addShell(activeWs, id, effectivePath, effectiveShell(settings))
    return id
  }, [activeWs, activeWorkspace.name, chatSessions, effectivePath, pty, settings])

  const closeCanvasPane = useCallback((canvasTabId: string, paneId: string): void => {
    setCanvasPanesByTab(prev => ({
      ...prev,
      [canvasTabId]: (prev[canvasTabId] ?? []).filter(pane => pane.id !== paneId),
    }))
    pty.clearTab(paneId)
    const removedSessionIds = chatSessions.releaseTab(paneId)
    if (removedSessionIds.length > 0) {
      for (const scopeId of removedSessionIds) bridges.releaseTab(scopeId, { stopRunning: true })
      setMessagesByTab(prev => {
        const next = { ...prev }
        for (const scopeId of removedSessionIds) delete next[scopeId]
        return next
      })
    }
  }, [bridges, chatSessions, pty, setMessagesByTab])

  const handleAction = useCallback((id: string): void => {
    switch (id) {
      case 'palette':                 setPaletteOpen(o => !o); return
      case 'workspaces':              setDrawerOpen(o => !o); return
      case 'next-workspace':          navigateWorkspaceHistory(1); return
      case 'prev-workspace':          navigateWorkspaceHistory(-1); return
      case 'next-tab':                navigateTabHistory(1); return
      case 'prev-tab':                navigateTabHistory(-1); return
      case 'settings-search':         handleNewTab('settings'); return
      case 'prompt-picker':
        if (promptPickerOpen) closePromptPicker()
        else {
          const shortcutTab = activeTab?.kind === 'chat' ? activeTab : promptBuilderChatTab
          openPromptPicker(promptBuilderSessionId, shortcutTab?.pinnedSessionId ?? shortcutTab?.id ?? '')
        }
        return
      case 'split-terminal-right':    openTerminalSplit('right'); return
      case 'split-terminal-down':     openTerminalSplit('down'); return
      case 'toggle-terminal-column':  setTweak('showTerminal', !tweaks.showTerminal); return
      case 'new-terminal':
        if (activeWs) pty.addShell(activeWs, activeTabId, effectivePath, effectiveShell(settings))
        return
      case 'open-vscode':             openInEditor(); return
      case 'open-folder':             void ws.addViaPicker(); return
      case 'clone-repo':              setAddOpen(true); return
      case 'start-crew':              startCrewFromAnywhere(); return
      case 'start-canvas':            startCanvasFromAnywhere(); return
      case 'new-session':
        if (activeTabId) chatSessions.add(activeTabId, activeWorkspace.name)
        return
      case 'duplicate-session':
        if (activeTabId && sessActive) chatSessions.duplicate(activeTabId, sessActive)
        return
      case 'toggle-theme':
        setSetting('appTheme', settings.appTheme === 'dark' ? 'light' : 'dark')
        return
      case 'cycle-theme': {
        // Color themes, in the same order they appear in Settings → Color theme.
        const order = ['carbon', 'midnight', 'graphite', 'solar-dark', 'paper', 'tomorrow'] as const
        const idx = order.indexOf(settings.theme as typeof order[number])
        setSetting('theme', order[(idx + 1) % order.length])
        return
      }
      case 'toggle-density':
        setTweak('density', tweaks.density === 'compact' ? 'regular' : 'compact')
        return
      case 'new-tab':                 handleNewTab('chat'); return
      case 'close-tab':
        if (activeTabId) handleCloseTab(activeTabId)
        return
      case 'fullscreen':
        if (document.fullscreenElement) document.exitFullscreen()
        else document.documentElement.requestFullscreen().catch(() => { /* user-gesture / permissions */ })
        return
      default:
        // Component-local action: re-dispatch the same chord as a synthetic
        // keydown so the local window-level listener (Composer, terminal
        // pane) fires. The global hook skips these ids so we don't loop.
        if (LOCAL_SHORTCUTS.has(id as ActionId)) {
          const chord = effectiveChord(id as ActionId, settings.shortcutOverrides as any)
          if (chord.length > 0) {
            const ev = buildKeydownFromChord(chord)
            if (ev && matchesChord(ev, chord)) window.dispatchEvent(ev)
          }
        }
    }
  }, [
    activeWorkspace.name, activeWorkspace.path, activeTab, activeTabId, activeWs, sessActive,
    chatSessions, navigateTabHistory, navigateWorkspaceHistory, handleCloseTab, handleNewTab, openInEditor,
    closePromptPicker, openPromptPicker, promptBuilderChatTab, promptBuilderSessionId, promptPickerOpen,
    openTerminalSplit, pty, setAddOpen, setDrawerOpen, setPaletteOpen, setSetting, setTweak, startCanvasFromAnywhere, startCrewFromAnywhere,
    settings.appTheme, settings.shortcutOverrides, settings, tweaks.density, tweaks.showTerminal, ws, effectivePath,
  ])

  useGlobalShortcuts({
    overrides: settings.shortcutOverrides,
    handleAction,
  })

  const kind = activeTab?.kind ?? 'chat'
  const hasWs = !!activeWs && ws.workspaces.length > 0
  const splitTabs = splitTabIds.map(id => tabs.find(t => t.id === id)).filter((tab): tab is Tab => !!tab)
  const splitVisible = splitTabs.length >= 2 && splitTabIds.includes(activeTabId)
  const visibleBrowserTabIds = new Set<string>()
  if (activeTab?.kind === 'browser' && activeTab?.id) visibleBrowserTabIds.add(activeTab.id)
  if (splitVisible) {
    for (const tab of splitTabs) {
      if (tab.kind === 'browser') visibleBrowserTabIds.add(tab.id)
    }
  }
  const [splitPaneFlexes, setSplitPaneFlexes] = useState<number[]>([])
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const terminalTabs = tabs.filter(tab => tab.kind === 'terminal')

  useEffect(() => {
    setSplitPaneFlexes(prev => {
      const next = splitTabs.map((_, idx) => prev[idx] ?? 1)
      if (next.length === prev.length && next.every((value, idx) => value === prev[idx])) return prev
      return next
    })
  }, [splitTabs])

  // ── Mission Control / menulet ──────────────────────────────────────────
  // Mission data derives from message content (updates per token); it lives in
  // <MissionDataProvider/> below so its subscription stays off App. The Mission
  // tab and menulet read it through context via MissionControlHost/MenuletHost.
  const [menuletOpen, setMenuletOpen] = useState(false)
  const [systemMonitorOpen, setSystemMonitorOpen] = useState(false)
  const [windowTabsMenuOpen, setWindowTabsMenuOpen] = useState(false)
  const windowTabsHidden = useMobileWindowTabsAutoHide({
    enabled: mobile.isMobile,
    locked: windowTabsMenuOpen || drawerOpen || menuletOpen || systemMonitorOpen,
  })
  const openMissionControl = useCallback((): void => {
    setMenuletOpen(false)
    handleNewTab('mission')
  }, [handleNewTab])

  // ── Mission Control: per-agent actions ──────────────────────────────────
  // MCAgent ids are prefixed: `solo:<sessionId>` or `crew:<laneId>`. The
  // session/lane lookups below tolerate ids referring to other workspaces —
  // switching the active workspace is required to actually focus the thread.
  const findCrewLane = useCallback((laneId: string) => {
    for (const cs of Object.values(crew.sessions)) {
      const lane = cs.lanes.find(l => l.laneId === laneId)
      if (lane) return { crewSession: cs, lane }
    }
    return null
  }, [crew.sessions])

  const handleMcOpen = useCallback((mcAgentId: string): void => {
    setMenuletOpen(false)
    if (mcAgentId.startsWith('crew:')) {
      const laneId = mcAgentId.slice('crew:'.length)
      const found = findCrewLane(laneId)
      if (!found) return
      const { crewSession: cs, lane } = found
      const tabId = lane.tabId ?? cs.hostTabId
      if (cs.wsId !== activeWs) setActiveWs(cs.wsId)
      // Crew host tab keeps the surface; lane tabs are `crew/<laneId>`.
      setActiveTabInWorkspace(cs.wsId, tabId)
      focusComposerSoon()
      return
    }
    if (mcAgentId.startsWith('solo:')) {
      const sessionId = mcAgentId.slice('solo:'.length)
      // Session ids encode their host tab id: either tabId itself, or `${tabId}::sN`.
      const tabId = sessionId.includes('::') ? sessionId.split('::')[0] : sessionId
      // Switch workspace if the tab belongs to another one.
      const targetWs = ws.workspaces.find(w => tabId === w.id || tabId.startsWith(`${w.id}-`))
      if (targetWs) setActiveTabInWorkspace(targetWs.id, tabId)
      else setActiveTabId(tabId)
      if (targetWs && targetWs.id !== activeWs) setActiveWs(targetWs.id)
      chatSessions.activate(tabId, sessionId)
      focusComposerSoon()
    }
  }, [findCrewLane, activeWs, setActiveWs, setActiveTabId, setActiveTabInWorkspace, ws.workspaces, chatSessions, focusComposerSoon])

  const handleMcPause = useCallback((mcAgentId: string): void => {
    if (mcAgentId.startsWith('crew:')) {
      const laneId = mcAgentId.slice('crew:'.length)
      const found = findCrewLane(laneId)
      if (!found) return
      crew.restartLane(found.crewSession.hostTabId, laneId)
      return
    }
    if (mcAgentId.startsWith('solo:')) {
      const sessionId = mcAgentId.slice('solo:'.length)
      const tabId = sessionId.includes('::') ? sessionId.split('::')[0] : sessionId
      // Drop every bridge attached to the session id (covers in-flight turns).
      bridges.releaseTab(sessionId, { stopRunning: true })
      bridges.releaseTab(tabId, { stopRunning: true })
    }
  }, [findCrewLane, crew, bridges])

  const handleMcResume = useCallback((mcAgentId: string): void => {
    // "Resume" semantics: bring the agent back into focus so the next prompt
    // restarts it. There's no separate "unpause" RPC — opening the thread is
    // the action.
    handleMcOpen(mcAgentId)
  }, [handleMcOpen])

  const handleMcSpawn = useCallback((): void => {
    if (!activeWs) return
    handleNewTab('chat')
  }, [activeWs, handleNewTab])

  // ── System monitor: jump to a process ───────────────────────────────────
  // A terminal row focuses its workspace + tab and reveals the terminal column;
  // a daemon row focuses its workspace + tab and activates the agent's session.
  const openSysmonTerminal = useCallback((tabId: string, wsId: string): void => {
    if (wsId) setActiveTabInWorkspace(wsId, tabId)
    else setActiveTabId(tabId)
    if (wsId && wsId !== activeWs) setActiveWs(wsId)
    setTweak('showTerminal', true)
  }, [activeWs, setActiveTabId, setActiveTabInWorkspace, setTweak])

  const openSysmonDaemon = useCallback((sessionKey: string): void => {
    const [tabId, agentId] = sessionKey.split(':')
    if (!tabId) return
    const targetWs = ws.workspaces.find(w => tabId === w.id || tabId.startsWith(`${w.id}-`))
    if (targetWs) setActiveTabInWorkspace(targetWs.id, tabId)
    else setActiveTabId(tabId)
    if (targetWs && targetWs.id !== activeWs) setActiveWs(targetWs.id)
    const sess = chatSessions.getSessions(tabId).find(s => s.agentId === agentId)
    if (sess) chatSessions.activate(tabId, sess.id)
    focusComposerSoon()
  }, [ws.workspaces, activeWs, setActiveTabId, setActiveTabInWorkspace, chatSessions, focusComposerSoon])

  const handleSessionDrop = useCallback((payload: SessionDragPayload, anchorTabId: string) => {
    if (mobile.isMobile) return
    const session = chatSessions.getSessions(payload.tabId).find(item => item.id === payload.sessionId)
    if (!session) return
    const targetWsId = workspaceByChatTabId[session.tabId] ?? activeWs
    if (!targetWsId || targetWsId !== activeWs) return
    const result = splitAnchorWithSession(
      anchorTabId,
      { sessionId: session.id, ownerTabId: session.tabId, label: session.label },
      chatSessions.getActiveId(session.tabId),
    )
    if (!result) return
    if (result.activateOwner) chatSessions.activate(session.tabId, session.id)
  }, [activeWs, chatSessions, mobile.isMobile, splitAnchorWithSession, workspaceByChatTabId])

  const resolveHandoffSessionPath = useCallback((session: Session) =>
    session.delegatedWorktreePath ?? worktreeForChatSurface(session.tabId, session.id).path,
  [worktreeForChatSurface])

  const activateHandoffDestination = useCallback((session: Session) => {
    const targetWsId = workspaceByChatTabId[session.tabId]
    const targetWs = ws.workspaces.find(workspace => workspace.id === targetWsId)
    if (!targetWsId || !targetWs) return
    restoreChatTabInWorkspace(targetWsId, targetWs.name, session.tabId)
    jumpToWorkspaceTab(targetWsId, session.tabId)
    chatSessions.activate(session.tabId, session.id)
  }, [chatSessions, jumpToWorkspaceTab, restoreChatTabInWorkspace, workspaceByChatTabId, ws.workspaces])

  const renderTabContent = (tab: Tab | null, terminalActive = true) => {
    const tabKind = standaloneSettingsOpen && !activeWs ? 'settings' : (tab?.kind ?? 'chat')
    const tabId = tab?.id ?? activeTabId
    const sessionOwnerTabId = tab?.sessionOwnerTabId ?? tabId
    const pinnedSessionId = tab?.pinnedSessionId
    const tabGitOpen = gitOpenByTab[tabId] ?? false
    const tabGitWidth = gitWidthByTab[tabId] ?? 380
    const setTabGitOpen = (open: boolean) => setGitOpenForTab(tabId, open)
    const setTabGitWidth = (next: number | ((prev: number) => number)) => setGitWidthForTab(tabId, next)

    // Tab-specific session and worktree lookups. Split/workbench surfaces may
    // render alongside the active outer tab, so they must never inherit its cwd.
    const tabActiveSession = pinnedSessionId
      ? chatSessions.getSessions(sessionOwnerTabId).find(session => session.id === pinnedSessionId)
        ?? chatSessions.getActiveSession(sessionOwnerTabId)
      : chatSessions.getActiveSession(sessionOwnerTabId)
    const tabWorktree = worktreeForChatSurface(sessionOwnerTabId, pinnedSessionId ?? tabActiveSession?.id)

    // Tab-specific chat state
    const tabAgentId = tabActiveSession?.agentId ?? settings.defaultAgent ?? 'pi'
    const tabModel = tabActiveSession?.model ?? ''
    const tabEffort = tabActiveSession?.effort ?? 'medium'
    const tabComposerMode = MODE_FROM_SETTINGS[normalizeModeLevel(tabActiveSession?.mode ?? settings.defaultMode)]

    // Tab-specific crew
    const tabCrewSession = crewCtl.crew.sessions[tabId]
    const isTabCrew = !!tabCrewSession

    // Tab-specific PTY panes
    const tabPanes = pty.panes.filter(p => p.tabId === tabId)

    if (tabKind === 'settings') return <SettingsScreen activeWorkspace={activeWorkspace} />
    if (tabKind === 'plugins') return <PluginsPage workspaces={ws.workspaces} activeWorkspaceId={activeWs} pluginWorkspaceEnabled={settings.pluginWorkspaceEnabled} setSetting={setSetting} />
    if (tabKind === 'mission') {
      return (
        <MissionControlHost
          onOpenAgent={handleMcOpen}
          onPauseAgent={handleMcPause}
          onResumeAgent={handleMcResume}
          onSpawnAgent={handleMcSpawn}
          onRespondRequest={bridges.respondUserRequest}
          pluginMissionWidgets={pluginMissionWidgets}
          onPluginMissionWidget={(target) => runPluginActionTarget(target, { source: 'mission-widget' })}
          onOpenActivity={mobile.isMobile ? () => mobile.onSheetToggle('mission-activity') : undefined}
        />
      )
    }
    if (tabKind === 'archive') {
      return (
        <ArchivePage
          entries={archivedEntries}
          workspaces={ws.workspaces}
          retentionDays={settings.archiveRetentionDays}
          onSetRetention={(days) => setSetting('archiveRetentionDays', days)}
          onRestore={restoreSession}
          onDelete={removeSession}
        />
      )
    }
    if (tabKind === 'prompts') {
      return (
        <PromptBuilder
          lib={promptBuilderLib}
          onUseInChat={handleUsePromptFromBuilder}
          onApplySkill={handleApplySkill}
        />
      )
    }
    if (tabKind === 'plugin' && tab) return <PluginTabHost tab={tab} workspace={hasWs ? activeWorkspace : null} />
    if (!hasWs) {
      return (
        <EmptyWorkspaceState
          onAdd={async () => { const id = await ws.addViaPicker(); if (id) setActiveWs(id) }}
        />
      )
    }
    if (hasWs && tabKind === 'crew' && !tabCrewSession) {
      return (
        <div className="empty-state">
          <div className="empty-title">crew session not active</div>
          <div className="empty-sub">start a new standalone crew in this tab, or close it.</div>
          <button className="empty-cta" onClick={() => crewCtl.startCrewForTab(tabId)}>Start crew</button>
        </div>
      )
    }
    if (hasWs && tabKind === 'canvas') {
      const canvasPanes = canvasPanesByTab[tabId] ?? []
      return (
        <CanvasMode
          workspaceName={activeWorkspace.name}
          openChatCount={canvasPanes.filter(pane => pane.kind === 'chat').length}
          openTerminalCount={canvasPanes.filter(pane => pane.kind === 'terminal').length}
          panes={canvasPanes.map(pane => {
            const paneWorktree = worktreeForChatSurface(pane.id)
            return {
            id: pane.id,
            kind: pane.kind,
            title: pane.title,
            modePrompt: pane.kind === 'chat' ? canvasModePromptControl(pane.id) : undefined,
            content: pane.kind === 'chat' ? (
              <ChatPane
                key={pane.id}
                tabId={pane.id}
                activeWs={activeWs}
                workspace={activeWorkspace}
                effectivePath={paneWorktree.path}
                effectiveBranch={paneWorktree.branch}
                worktreeBranch={paneWorktree.worktreeBranch}
                agents={agents}
                chatSessions={chatSessions}
                workspaceSessions={sessionsByWorkspace[activeWs] ?? []}
                resolveHandoffSessionPath={resolveHandoffSessionPath}
                onHandoffDestinationActivate={activateHandoffDestination}
                bridges={bridges}
                pty={pty}
                crewSession={null}
                crewCtl={{ ...crewCtl, handleStartCrew: startCrewFromAnywhere }}
                density={tweaks.density}
                hideHeader
                threadView={chatUiByTab[pane.id]?.threadView ?? 'chat'}
                setThreadView={(view) => setChatUiByTab(prev => ({
                  ...prev,
                  [pane.id]: { threadView: view },
                }))}
                shortcutOverrides={settings.shortcutOverrides}
                onOpenFile={openFileInEditor}
                onOpenBrowser={openBrowserUrl}
                onOpenCanvas={startCanvasFromAnywhere}
                onOpenPrompts={() => openPromptPicker(chatSessions.getActiveSession(pane.id)?.id, pane.id)}
                prompts={promptLib.prompts}
                skills={promptLib.skills}
                commands={promptFiles.commands}
                onToggleSkillEnabled={(id) => {
                  const target = promptLib.skills.find(s => s.id === id)
                  const current = chatSessions.getActiveSession(pane.id)
                  if (target && current) {
                    handleApplySkill({
                      ...target,
                      enabled: !(current.enabledSkillIds ?? []).includes(id),
                    })
                  }
                }}
                editorInitialFile={editorInitialFile}
                settingsDefaultAgent={settings.defaultAgent}
                settingsDefaultMode={settings.defaultMode}
                mcpEnabled={settings.mcpEnabled}
                mcpServers={allMcpServers}
                gitOpen={gitOpenByTab[pane.id] ?? false}
                setGitOpen={(open) => setGitOpenForTab(pane.id, open)}
                github={github}
                dirtyCount={paneWorktree.dirty}
                currentWorktreeId={paneWorktree.id}
                onSwitchWorktree={(id) => selectWorktreeForKey(paneWorktree.key, id)}
                onGitAskAgent={handleGitAskAgent}
                onRequestGitAuth={requestGitAuth}
                onRequestSigningPassphrase={requestSigningPassphrase}
                alwaysCommitUnsigned={settings.alwaysCommitUnsigned}
                gitWidth={gitWidthByTab[pane.id] ?? 380}
                setGitWidth={(w) => setGitWidthForTab(pane.id, w)}
                onOpenGitFileDiff={openGitFileDiff}
                onThreadContextMenu={(e) => openChatContextMenu(e, false)}
                pendingGitDiff={pendingGitDiff}
                terminalColumnVisible={tweaks.showTerminal}
                onTerminalColumnVisibleChange={(visible) => setTweak('showTerminal', visible)}
                termWidth={pty.getTabWidth(pane.id)}
                setTermWidth={(w) => pty.setTabWidth(pane.id, w)}
                terminalShell={effectiveShell(settings)}
                termLayout={pty.getTabLayout(pane.id)}
                onTermLayoutChange={(layout) => pty.setTabLayout(pane.id, layout)}
                pluginChatHeaderItems={pluginChatHeaderItems}
                onPluginChatHeaderItem={(target) => runPluginActionTarget(target, { source: 'chat-header' })}
                pluginGitLenses={pluginGitLenses}
                onPluginGitLens={(target) => runPluginActionTarget(target, { source: 'git-lens' })}
                pluginTerminalWatchers={pluginTerminalWatchers}
                onPluginTerminalWatcher={(target, paneId) => runPluginActionTarget(target, { source: 'terminal-watcher', terminalPaneId: paneId })}
                setPendingGitDiff={setPendingGitDiff}
                onWorktreesChanged={() => ws.refreshWorktrees(activeWs)}
                changesDrawerOpen={isSurfaceOpen(changesDrawerOpenBySurface, pane.id)}
                setChangesDrawerOpen={(open) => setChangesDrawerOpenForSurface(pane.id, open)}
              />
            ) : (
              <div className="full-term canvas-full-term">
                <TermColumn
                  panes={pty.panes.filter(p => p.tabId === pane.id)}
                  agents={agents}
                  tabKind="canvas"
                  onClose={pty.close}
                  onAddShell={() => pty.addShell(activeWs, pane.id, effectivePath, effectiveShell(settings))}
                  onAddAgent={(agentId) => {
                    const a = agents.find(x => x.id === agentId)
                    return a ? pty.addAgent(activeWs, pane.id, a.id, a.name, effectivePath, a.path) : undefined
                  }}
                  onAddSsh={(target) => pty.addSsh(activeWs, pane.id, target, effectivePath)}
                  sshTargets={sshTargets}
                  layout={pty.getTabLayout(pane.id)}
                  onLayoutChange={(layout) => pty.setTabLayout(pane.id, layout)}
                  onOpenUrl={openBrowserUrl}
                  pluginTerminalWatchers={pluginTerminalWatchers}
                  onPluginTerminalWatcher={(target, paneId) => runPluginActionTarget(target, { source: 'terminal-watcher', terminalPaneId: paneId })}
                />
              </div>
            ),
          }
          })}
          onNewChat={() => addCanvasPane(tabId, 'chat')}
          onNewTerminal={() => addCanvasPane(tabId, 'terminal')}
          onClosePane={(paneId) => closeCanvasPane(tabId, paneId)}
        />
      )
    }
    if (hasWs && (tabKind === 'chat' || tabKind === 'crew')) {
      return (
        <ChatPane
          key={tabId}
          tabId={sessionOwnerTabId}
          surfaceTabId={tabId}
          pinnedSessionId={pinnedSessionId}
          onSessionDrop={payload => handleSessionDrop(payload, tabId)}
          activeWs={activeWs}
          workspace={activeWorkspace}
          effectivePath={tabWorktree.path}
          effectiveBranch={tabWorktree.branch}
          worktreeBranch={tabWorktree.worktreeBranch}
          agents={agents}
          chatSessions={chatSessions}
          workspaceSessions={sessionsByWorkspace[activeWs] ?? []}
          resolveHandoffSessionPath={resolveHandoffSessionPath}
          onHandoffDestinationActivate={activateHandoffDestination}
          bridges={bridges}
          pty={pty}
          crewSession={tabCrewSession}
          crewCtl={tabKind === 'chat' ? { ...crewCtl, handleStartCrew: startCrewFromAnywhere } : crewCtl}
          density={tweaks.density}
          threadView={chatUiByTab[tabId]?.threadView ?? 'chat'}
          setThreadView={(view) => setChatUiByTab(prev => ({
            ...prev,
            [tabId]: { threadView: view },
          }))}
          shortcutOverrides={settings.shortcutOverrides}
          onOpenFile={openFileInEditor}
          onOpenBrowser={openBrowserUrl}
          onOpenCanvas={startCanvasFromAnywhere}
          onOpenPrompts={() => openPromptPicker(tabActiveSession?.id, pinnedSessionId ?? tabId)}
          prompts={promptLib.prompts}
          skills={promptLib.skills}
          commands={promptFiles.commands}
          onToggleSkillEnabled={(id) => {
            const target = promptLib.skills.find(s => s.id === id)
            const current = pinnedSessionId
              ? chatSessions.getSessions(sessionOwnerTabId).find(session => session.id === pinnedSessionId)
              : chatSessions.getActiveSession(sessionOwnerTabId)
            if (target && current) {
              handleApplySkill({
                ...target,
                enabled: !(current.enabledSkillIds ?? []).includes(id),
              })
            }
          }}
          editorInitialFile={editorInitialFile}
          settingsDefaultAgent={settings.defaultAgent}
          settingsDefaultMode={settings.defaultMode}
          mcpEnabled={settings.mcpEnabled}
          mcpServers={allMcpServers}
          gitOpen={tabGitOpen}
          setGitOpen={setTabGitOpen}
          github={github}
          dirtyCount={tabWorktree.dirty}
          currentWorktreeId={tabWorktree.id}
          onSwitchWorktree={(id) => selectWorktreeForKey(tabWorktree.key, id)}
          onGitAskAgent={handleGitAskAgent}
          onRequestGitAuth={requestGitAuth}
          onRequestSigningPassphrase={requestSigningPassphrase}
          alwaysCommitUnsigned={settings.alwaysCommitUnsigned}
          gitWidth={tabGitWidth}
          setGitWidth={setTabGitWidth}
          onOpenGitFileDiff={openGitFileDiff}
          onThreadContextMenu={(e) => openChatContextMenu(e, tabKind === 'chat')}
          pendingGitDiff={pendingGitDiff}
          terminalColumnVisible={tweaks.showTerminal}
          onTerminalColumnVisibleChange={(visible) => setTweak('showTerminal', visible)}
          termWidth={pty.getTabWidth(tabId)}
          setTermWidth={(w) => pty.setTabWidth(tabId, w)}
          terminalShell={effectiveShell(settings)}
          termLayout={pty.getTabLayout(tabId)}
          onTermLayoutChange={(layout) => pty.setTabLayout(tabId, layout)}
          pluginChatHeaderItems={pluginChatHeaderItems}
          onPluginChatHeaderItem={(target) => runPluginActionTarget(target, { source: 'chat-header' })}
          pluginGitLenses={pluginGitLenses}
          onPluginGitLens={(target) => runPluginActionTarget(target, { source: 'git-lens' })}
          pluginTerminalWatchers={pluginTerminalWatchers}
          onPluginTerminalWatcher={(target, paneId) => runPluginActionTarget(target, { source: 'terminal-watcher', terminalPaneId: paneId })}
          setPendingGitDiff={setPendingGitDiff}
          onWorktreesChanged={() => ws.refreshWorktrees(activeWs)}
          changesDrawerOpen={isSurfaceOpen(changesDrawerOpenBySurface, tabId)}
          setChangesDrawerOpen={(open) => setChangesDrawerOpenForSurface(tabId, open)}
        />
      )
    }
    if (hasWs && tabKind === 'git') {
      return (
        <GitPage
          workspace={{
            name:   activeWorkspace.name,
            path:   effectivePath,
            branch: git.state.branch || effectiveBranch,
            user:   git.state.user,
          }}
          state={git.state}
          chatTargets={gitChatTargets}
          {...git.handlers}
          onOpenFileDiff={openGitFileDiff}
          onOpenTerminal={(path) => {
            const termTabId = handleNewTab('terminal')
            if (termTabId) pty.addShell(activeWs, termTabId, path, effectiveShell(settings))
          }}
          pluginGitLenses={pluginGitLenses}
          onPluginGitLens={(target) => runPluginActionTarget(target, { source: 'git-lens' })}
        />
      )
    }
    if (hasWs && tabKind === 'code') {
      const sess = codeEditors.sessions[tabId] ?? { tabs: [], activeRel: null, cursor: {}, scroll: {} }
      return (
        <div className="ed-git-row">
        <CodeEditor
          root={effectivePath}
          tabs={sess.tabs}
          activeRel={sess.activeRel}
          cursorMap={sess.cursor}
          scrollMap={sess.scroll}
          onOpenFile={async (rel) => {
            if (!effectivePath) throw new Error('no workspace')
            const api = window.electronAPI
            if (!api) throw new Error('no api')
            const r = await api.fsReadFile(effectivePath, rel)
            if (r.error || !r.ok) throw new Error(r.error ?? 'failed')
            codeEditors.openFile(tabId, { rel, name: r.name ?? rel, text: r.text ?? '', size: r.size ?? 0 })
          }}
          onCloseFile={(rel) => codeEditors.closeFile(tabId, rel)}
          onSetActiveRel={(rel) => codeEditors.setActiveRel(tabId, rel)}
          onUpdateText={(rel, text) => codeEditors.updateText(tabId, rel, text)}
          onSaveFile={async (rel) => {
            if (!effectivePath) return
            const tab = sess.tabs.find(t => t.rel === rel)
            if (!tab) return
            const api = window.electronAPI
            if (!api) return
            const r = await api.fsWriteFile(effectivePath, rel, tab.text)
            if (r.error) throw new Error(r.error)
            const newSize = new Blob([tab.text]).size
            codeEditors.markSaved(tabId, rel, newSize)
          }}
          onFormatFile={async (rel, text) => {
            if (!effectivePath) return undefined
            const api = window.electronAPI
            if (!api) return undefined
            const r = await api.fsFormat(effectivePath, rel, text)
            if (r.error) return undefined
            return r.text
          }}
          onSetCursor={(rel, cursor) => codeEditors.setCursor(tabId, rel, cursor)}
          onSetScroll={(rel, scroll) => codeEditors.setScroll(tabId, rel, scroll)}
          onReloadFromDisk={(rel, text, size) => codeEditors.applyDiskContent(tabId, rel, text, size)}
          onNewUntitled={() => {
            const rel = sess.tabs.some(t => t.rel === 'untitled') ? `untitled-${Date.now()}` : 'untitled'
            codeEditors.openFile(tabId, { rel, name: 'untitled', text: '', size: 0 })
          }}
          externalDiff={pendingGitDiff}
          onCloseExternalDiff={() => setPendingGitDiff(null)}
          gitOpen={tabGitOpen}
          onToggleGit={() => setGitOpenForTab(tabId, open => !open)}
          expandedDirs={sess.expandedDirs}
          onExpandedDirsChange={(rels) => codeEditors.setExpandedDirs(tabId, rels)}
          pluginEditorActions={pluginEditorActions}
          onPluginEditorAction={handlePluginEditorAction}
          theme={settings.editorTheme}
          completion={{
            enabled: settings.editorCompletionEnabled,
            provider: settings.editorCompletionProvider,
            model: settings.editorCompletionModel,
          }}
        />
        {tabGitOpen && (
          <>
            {mobile.isMobile && <button type="button" className="mobile-git-backdrop" aria-label="Close Git sidebar" onClick={() => setGitOpenForTab(tabId, false)} />}
            {!mobile.isMobile && (
              <Splitter
                orientation="vertical"
                onDrag={delta => setGitWidthForTab(tabId, w => Math.max(280, Math.min(720, w - delta)))}
              />
            )}
            <GitSidebar
              workspace={{
                name:   activeWorkspace.name,
                path:   effectivePath,
                branch: git.state.branch || effectiveBranch,
                user:   git.state.user,
              }}
              state={git.state}
              width={tabGitWidth}
              chatTargets={gitChatTargets}
              {...git.handlers}
              onOpenFileDiff={openGitFileDiff}
              onOpenTerminal={(path) => {
                const termTabId = handleNewTab('terminal')
                if (termTabId) pty.addShell(activeWs, termTabId, path, effectiveShell(settings))
              }}
              pluginGitLenses={pluginGitLenses}
              onPluginGitLens={(target) => runPluginActionTarget(target, { source: 'git-lens' })}
              onClose={mobile.isMobile ? () => setGitOpenForTab(tabId, false) : undefined}
            />
          </>
        )}
        </div>
      )
    }
    if (hasWs && tabKind === 'writer') {
      return (
        <WriterWorkspace
          tabId={tabId}
          onSessionDrop={payload => handleSessionDrop(payload, tabId)}
          activeWs={activeWs}
          workspace={activeWorkspace}
          effectivePath={tabWorktree.path}
          effectiveBranch={tabWorktree.branch}
          worktreeBranch={tabWorktree.worktreeBranch}
          agents={agents}
          chatSessions={chatSessions}
          workspaceSessions={sessionsByWorkspace[activeWs] ?? []}
          resolveHandoffSessionPath={resolveHandoffSessionPath}
          onHandoffDestinationActivate={activateHandoffDestination}
          bridges={bridges}
          pty={pty}
          density={tweaks.density}
          threadView={chatUiByTab[tabId]?.threadView ?? 'chat'}
          setThreadView={(view) => setChatUiByTab(prev => ({
            ...prev,
            [tabId]: { threadView: view },
          }))}
          shortcutOverrides={settings.shortcutOverrides}
          onOpenFile={openFileInEditor}
          onOpenBrowser={openBrowserUrl}
          onOpenPrompts={() => openPromptPicker(chatSessions.getActiveSession(tabId)?.id, tabId)}
          prompts={promptLib.prompts}
          skills={promptLib.skills}
          commands={promptFiles.commands}
          onToggleSkillEnabled={(id) => {
            const target = promptLib.skills.find(s => s.id === id)
            const current = chatSessions.getActiveSession(tabId)
            if (target && current) {
              handleApplySkill({
                ...target,
                enabled: !(current.enabledSkillIds ?? []).includes(id),
              })
            }
          }}
          settingsDefaultAgent={settings.defaultAgent}
          settingsDefaultMode={settings.defaultMode}
          mcpEnabled={settings.mcpEnabled}
          mcpServers={allMcpServers}
          gitOpen={tabGitOpen}
          setGitOpen={setTabGitOpen}
          github={github}
          dirtyCount={tabWorktree.dirty}
          currentWorktreeId={tabWorktree.id}
          onSwitchWorktree={(id) => selectWorktreeForKey(tabWorktree.key, id)}
          onGitAskAgent={handleGitAskAgent}
          onRequestGitAuth={requestGitAuth}
          onRequestSigningPassphrase={requestSigningPassphrase}
          alwaysCommitUnsigned={settings.alwaysCommitUnsigned}
          gitWidth={tabGitWidth}
          setGitWidth={setTabGitWidth}
          onOpenGitFileDiff={openGitFileDiff}
          onThreadContextMenu={(e) => openChatContextMenu(e, false)}
          pendingGitDiff={pendingGitDiff}
          terminalColumnVisible={tweaks.showTerminal}
          onTerminalColumnVisibleChange={(visible) => setTweak('showTerminal', visible)}
          termWidth={pty.getTabWidth(tabId)}
          setTermWidth={(w) => pty.setTabWidth(tabId, w)}
          terminalShell={effectiveShell(settings)}
          termLayout={pty.getTabLayout(tabId)}
          onTermLayoutChange={(layout) => pty.setTabLayout(tabId, layout)}
          setPendingGitDiff={setPendingGitDiff}
          changesDrawerOpen={isSurfaceOpen(changesDrawerOpenBySurface, tabId)}
          setChangesDrawerOpen={(open) => setChangesDrawerOpenForSurface(tabId, open)}
        />
      )
    }
    if (hasWs && tabKind === 'terminal') {
      return (
        <div className="full-term">
          <TermColumn
            panes={tabPanes}
            agents={agents}
            tabKind="terminal"
            active={terminalActive}
            onSessionDrop={payload => handleSessionDrop(payload, tabId)}
            onClose={pty.close}
            onAddShell={() => pty.addShell(activeWs, tabId, effectivePath, effectiveShell(settings))}
            onAddAgent={(agentId) => {
              const a = agents.find(x => x.id === agentId)
              return a ? pty.addAgent(activeWs, tabId, a.id, a.name, effectivePath, a.path) : undefined
            }}
            onAddSsh={(target) => pty.addSsh(activeWs, tabId, target, effectivePath)}
            sshTargets={sshTargets}
            layout={pty.getTabLayout(tabId)}
            onLayoutChange={(layout) => pty.setTabLayout(tabId, layout)}
            onOpenUrl={openBrowserUrl}
            pluginTerminalWatchers={pluginTerminalWatchers}
            onPluginTerminalWatcher={(target, paneId) => runPluginActionTarget(target, { source: 'terminal-watcher', terminalPaneId: paneId })}
          />
        </div>
      )
    }
    if (hasWs && tabKind === 'browser') {
      return (
        <BrowserTab
          key={tabId}
          tabId={tabId}
          initialUrl={tab?.url}
          sessionMode={tab?.browserSessionMode ?? 'isolated'}
          onNewTab={(url) => handleNewTab('browser', { url })}
          onNavigateTab={(url) => setTabUrl(tabId, url)}
          onSessionModeChange={(mode) => setBrowserSessionMode(tabId, mode)}
          pluginBrowserActions={pluginBrowserActions}
          onPluginBrowserAction={(target, browserUrl) => runPluginActionTarget(target, { source: 'browser-action', browserUrl })}
        />
      )
    }
    return null
  }

  // App-level destinations, shared by the brand AppMenu and the drawer's
  // "App" tab so both routes behave identically.
  const handleAppMenuAction = useCallback((a: AppMenuAction) => {
    switch (a.kind) {
      case 'open-tab':
        if (a.tab === 'settings' && !activeWs) {
          setStandaloneSettingsOpen(true)
          return
        }
        if (a.tab === 'code') {
          // Code Editor menu item opens/focuses a single code tab,
          // not a new one on every click.
          const existingCode = tabs.find(t => t.kind === 'code')
          if (existingCode) setActiveTabId(existingCode.id)
          else handleNewTab('code')
          return
        }
        handleNewTab(a.tab)
        return
      case 'palette':          setPaletteOpen(o => !o); return
      case 'toggle-terminal':  setTweak('showTerminal', !tweaks.showTerminal); return
      case 'start-crew':       startCrewFromAnywhere(); return
      case 'start-canvas':     startCanvasFromAnywhere(); return
      case 'updates':          window.electronAPI?.updaterCheck?.(); return
      case 'quit-stop-brain':  void window.electronAPI?.brainDesktopStopAndQuit(); return
      case 'docs':             window.electronAPI?.openExternal?.('https://crewcode-docs.logixhub.icu'); return
      case 'toggle-menulet':
        setSystemMonitorOpen(false)
        setMenuletOpen(open => !open)
        return
      case 'toggle-system-monitor':
        setMenuletOpen(false)
        setSystemMonitorOpen(open => !open)
        return
    }
  }, [activeWs, tabs, setActiveTabId, handleNewTab, setPaletteOpen, setTweak, tweaks.showTerminal, startCanvasFromAnywhere, startCrewFromAnywhere])

  const workspacesPanel = (
    <WorkspacesDrawer
      open={drawerOpen}
      setOpen={setDrawerOpen}
      height={tweaks.drawerHeight}
      width={tweaks.drawerWidth}
      position={effectiveDrawerPosition}
      mobileOverlay={mobile.isMobile}
      active={activeWs}
      setActive={handleWsSelect}
      density={tweaks.density}
      workspaces={ws.workspaces}
      sessionsByWorkspace={sessionsByWorkspace}
      activeSessionId={sessActive}
      onSessionActivate={(session) => {
        const targetWsId = workspaceByChatTabId[session.tabId] ?? activeWs
        const targetWs = ws.workspaces.find(w => w.id === targetWsId)
        if (targetWsId && targetWs) restoreChatTabInWorkspace(targetWsId, targetWs.name, session.tabId)
        // The drawer can activate sessions in another workspace; write the tab
        // to that workspace explicitly instead of using the current-workspace setter.
        if (targetWsId) jumpToWorkspaceTab(targetWsId, session.tabId)
        chatSessions.activate(session.tabId, session.id)
      }}
      onSessionAdd={(wsId) => {
        const targetWs = ws.workspaces.find(w => w.id === wsId)
        if (!targetWs) return
        const tabId = openTabInWorkspace(wsId, targetWs.name, 'chat')
        if (!tabId) return
        chatSessions.ensureTab(tabId, targetWs.name)
        handleWsSelect(wsId)
      }}
      onSessionRemove={removeSession}
      onSessionArchive={archiveSession}
      onSessionRename={renameSession}
      onSessionTogglePin={toggleSessionPin}
      onAddWorkspace={() => setAddOpen(true)}
      onRemoveWorkspace={async (wsId) => {
        await ws.remove(wsId)
        if (activeWs === wsId) setActiveWs(ws.workspaces.find(w => w.id !== wsId)?.id ?? '')
      }}
      onTogglePin={(wsId, pinned) => ws.togglePin(wsId, pinned)}
      onRenameWorkspace={(wsId, name) => ws.rename(wsId, name)}
      onSetFolder={(wsId, folder) => ws.setFolder(wsId, folder)}
      onAppFeature={handleAppMenuAction}
      activeKind={activeTab?.kind}
      activeTabId={activeTabId}
      workingChats={workingChats}
      completedChats={completedChats}
      terminalClis={terminalClis}
      sessionCompletedAt={completedAtByScope}
      workspaceAgentStatus={workspaceAgentStatus}
      sessionAgentStatus={sessionAgentStatus}
      onWorkingChatActivate={(entry) => {
        const targetWs = ws.workspaces.find(w => w.id === entry.wsId)
        if (targetWs) restoreChatTabInWorkspace(entry.wsId, targetWs.name, entry.tabId)
        jumpToWorkspaceTab(entry.wsId, entry.tabId)
        chatSessions.activate(entry.tabId, entry.sessionId)
      }}
      onCompletedChatActivate={(entry) => {
        const targetWs = ws.workspaces.find(w => w.id === entry.wsId)
        if (targetWs) restoreChatTabInWorkspace(entry.wsId, targetWs.name, entry.tabId)
        jumpToWorkspaceTab(entry.wsId, entry.tabId)
        chatSessions.activate(entry.tabId, entry.sessionId)
        // Opening it clears it from Completed until its next finished turn.
        dismissCompletedChat(entry.sessionId)
      }}
      onTerminalCliActivate={(entry) => {
        jumpToWorkspaceTab(entry.wsId, entry.tabId)
        setTweak('showTerminal', true)
        clearPane(entry.paneId)
      }}
    />
  )

  const activeEditorFilePath = () => {
    if (activeTab?.kind !== 'code') return undefined
    return codeEditors.sessions[activeTabId]?.activeRel ?? undefined
  }

  const latestChatMessageId = () => {
    if (!sessActive) return undefined
    const messages = useMessagesStore.getState().messagesByTab[sessActive] ?? []
    const index = messages.length - 1
    if (index < 0) return undefined
    const msg = messages[index]
    return 'turnId' in msg && msg.turnId ? msg.turnId : `${sessActive}:${index}`
  }

  const enrichPluginOpenContext = (openContext: PluginOpenContext): PluginOpenContext => ({
    ...openContext,
    filePath: openContext.filePath ?? activeEditorFilePath(),
    chatMessageId: openContext.chatMessageId ?? (openContext.source === 'chat-action' ? latestChatMessageId() : undefined),
  })

  const runPluginActionTarget = (target: { pluginId: string; sidebarPanel?: string; tab?: string; command?: string }, openContext: PluginOpenContext) => {
    const enrichedOpenContext = enrichPluginOpenContext(openContext)
    if (target.sidebarPanel) {
      const panel = pluginSidebarPanels.find(candidate => candidate.pluginId === target.pluginId && candidate.id === target.sidebarPanel)
      if (panel) {
        const isCurrentPanelOpen = pluginSidebarOpen && activePluginSidebarId === panel.registrationId
        setActivePluginSidebarId(panel.registrationId)
        setPluginSidebarOpenContext(enrichedOpenContext)
        setPluginSidebarOpen(!isCurrentPanelOpen)
        return
      }
    }
    if (target.tab) {
      const tab = pluginTabs.find(candidate => candidate.pluginId === target.pluginId && candidate.id === target.tab)
      if (tab) {
        openPluginTab(tab, enrichedOpenContext)
        return
      }
    }
    if (target.command) handleAction(`${target.pluginId}:${target.command}`)
  }

  const handlePluginStatusItem = (item: RegisteredPluginStatusItem) => runPluginActionTarget(item, { source: 'status-item' })
  const handlePluginEditorAction = (action: RegisteredPluginEditorAction, rel: string | null) => {
    runPluginActionTarget(action, { source: 'editor-action', filePath: rel ?? undefined })
    if (rel) show({ type: 'info', message: `${action.title}: ${rel}`, duration: 2500 })
  }

  useEffect(() => {
    if (pluginSidebarPanels.length === 0) setPluginSidebarOpen(false)
  }, [pluginSidebarPanels.length])

  const activePluginSidebar = pluginSidebarPanels.find(panel => panel.registrationId === activePluginSidebarId) ?? pluginSidebarPanels[0] ?? null
  const activePluginSidebarTab = activePluginSidebar ? {
    id: `plugin-sidebar-${activePluginSidebar.registrationId}`,
    kind: 'plugin' as const,
    label: activePluginSidebar.title,
    pluginId: activePluginSidebar.pluginId,
    pluginTabId: activePluginSidebar.id,
    pluginRegistrationId: activePluginSidebar.registrationId,
    pluginEntry: activePluginSidebar.entry,
    pluginIcon: activePluginSidebar.icon,
    pluginOpenContext: pluginSidebarOpenContext,
  } satisfies Tab : null

  const pluginAddMenuItems = useMemo<WindowTabPluginMenuItem[]>(() => [
    ...pluginSidebarPanels.map(panel => ({
      id: `plugin-panel:${panel.registrationId}`,
      pluginId: panel.pluginId,
      title: panel.title,
      icon: panel.icon,
      kind: 'sidebarPanel' as const,
      target: { pluginId: panel.pluginId, sidebarPanel: panel.id },
    })),
    ...pluginTabs.map(tab => ({
      id: `plugin-tab:${tab.registrationId}`,
      pluginId: tab.pluginId,
      title: tab.title,
      icon: tab.icon,
      kind: 'tab' as const,
      target: { pluginId: tab.pluginId, tab: tab.id },
    })),
  ], [pluginSidebarPanels, pluginTabs])

  const pluginSidebar = pluginSidebarOpen && pluginSidebarPanels.length > 0 && activePluginSidebarTab ? (
    <aside className="plugin-sidebar" aria-label="plugin sidebar panels">
      <div className="plugin-sidebar-tabs">
        {pluginSidebarPanels.map(panel => (
          <button
            key={panel.registrationId}
            className={`plugin-sidebar-tab ${panel.registrationId === activePluginSidebar?.registrationId ? 'on' : ''}`}
            onClick={() => { setActivePluginSidebarId(panel.registrationId); setPluginSidebarOpen(true) }}
            title={`${panel.title} · ${panel.pluginId}`}
          >
            {panel.title}
          </button>
        ))}
        <button
          className="plugin-sidebar-close"
          onClick={() => setPluginSidebarOpen(false)}
          title="close plugin sidebar"
          aria-label="close plugin sidebar"
        >
          ×
        </button>
      </div>
      <div className="plugin-sidebar-body">
        <PluginTabHost tab={activePluginSidebarTab} workspace={hasWs ? activeWorkspace : null} />
      </div>
    </aside>
  ) : null

  // Mobile sheet content components
  const WorkspacesContent = () => (
    <div style={{ padding: 'var(--space-4)', maxHeight: 'calc(100vh - 200px)', overflow: 'auto' }}>
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <button
          onClick={async () => { const id = await ws.addViaPicker(); if (id) { setActiveWs(id); mobile.closeSheet('workspaces') }}}
          style={{
            width: '100%', padding: 'var(--space-3)', background: 'var(--primary)', color: 'var(--primary-foreground)',
            border: 'none', borderRadius: 'var(--radius)', fontSize: '14px', fontWeight: 500, cursor: 'pointer'
          }}
        >
          + Add Workspace
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {ws.workspaces.map(workspace => (
          <button
            key={workspace.id}
            onClick={() => { handleWsSelect(workspace.id); mobile.closeSheet('workspaces') }}
            style={{
              width: '100%', padding: 'var(--space-3)', background: activeWs === workspace.id ? 'var(--primary)' : 'var(--card)',
              color: activeWs === workspace.id ? 'var(--primary-foreground)' : 'var(--foreground)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '14px',
              textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)'
            }}
          >
            <Icon name="folder" size={20} />
            <span style={{ flex: 1 }}>{workspace.name}</span>
            {workspace.worktrees && workspace.worktrees.length > 0 && (
              <span className="cc-mono-sm" style={{ color: 'var(--muted-foreground)' }}>
                {workspace.worktrees.length} worktree{workspace.worktrees.length === 1 ? '' : 's'}
              </span>
            )}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 'var(--space-6)', paddingTop: 'var(--space-4)', borderTop: '1px solid var(--border)' }}>
        <div className="cc-label" style={{ marginBottom: 'var(--space-2)' }}>Quick Actions</div>
        <button
          onClick={() => { handleNewTab('settings'); mobile.closeSheet('workspaces') }}
          style={{
            width: '100%', padding: 'var(--space-3)', background: 'var(--card)', color: 'var(--foreground)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '14px',
            textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)'
          }}
        >
          <Icon name="settings" size={20} />
          <span>Settings</span>
        </button>
      </div>
    </div>
  )

  const GitSheetContent = () => (
    <div style={{ padding: 'var(--space-4)', maxHeight: 'calc(100vh - 200px)', overflow: 'auto' }}>
      {hasWs && activeWorkspace ? (
        <div>
          <div style={{ marginBottom: 'var(--space-4)' }}>
            <div className="cc-h3" style={{ margin: 0 }}>{activeWorkspace.name}</div>
            <div className="cc-mono-sm" style={{ color: 'var(--muted-foreground)' }}>{effectivePath}</div>
            <div className="cc-mono-sm" style={{ color: 'var(--muted-foreground)' }}>Branch: {effectiveBranch}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <button
              onClick={() => git.handlers.onStageAll?.([])}
              style={{
                width: '100%', padding: 'var(--space-3)', background: 'var(--primary)', color: 'var(--primary-foreground)',
                border: 'none', borderRadius: 'var(--radius)', fontSize: '14px', fontWeight: 500, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 'var(--space-2)', justifyContent: 'center'
              }}
            >
              <Icon name="gitCommit" size={20} />
              <span>Stage All & Commit</span>
            </button>
            <button
              onClick={() => git.handlers.onPush?.()}
              style={{
                width: '100%', padding: 'var(--space-3)', background: 'var(--card)', color: 'var(--foreground)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '14px',
                textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)'
              }}
            >
              <Icon name="arrowUp" size={20} />
              <span>Push</span>
            </button>
            <button
              onClick={() => git.handlers.onPull?.()}
              style={{
                width: '100%', padding: 'var(--space-3)', background: 'var(--card)', color: 'var(--foreground)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '14px',
                textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)'
              }}
            >
              <Icon name="arrowDown" size={20} />
              <span>Pull</span>
            </button>
            <button
              onClick={() => git.handlers.onFetch?.()}
              style={{
                width: '100%', padding: 'var(--space-3)', background: 'var(--card)', color: 'var(--foreground)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '14px',
                textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)'
              }}
            >
              <Icon name="refresh" size={20} />
              <span>Fetch</span>
            </button>
            <button
              onClick={() => { handleNewTab('git'); mobile.closeSheet('git') }}
              style={{
                width: '100%', padding: 'var(--space-3)', background: 'var(--card)', color: 'var(--foreground)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '14px',
                textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)'
              }}
            >
              <Icon name="gitBranch" size={20} />
              <span>Open Git Workspace</span>
            </button>
          </div>
        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: 'var(--space-8)', color: 'var(--muted-foreground)' }}>
          No workspace selected
        </div>
      )}
    </div>
  )

  const TerminalSheetContent = () => (
    <div style={{ height: 'calc(100vh - 200px)', display: 'flex', flexDirection: 'column' }}>
      {hasWs ? (
        <>
          <TermColumn
            panes={wsPanes}
            agents={agents}
            tabKind={tabInfoById[activeTabId]?.kind}
            onClose={pty.close}
            onAddShell={() => pty.addShell(activeWs, activeTabId, effectivePath, effectiveShell(settings))}
            onAddAgent={(agentId) => {
              const a = agents.find(x => x.id === agentId)
              return a ? pty.addAgent(activeWs, activeTabId, a.id, a.name, effectivePath, a.path) : undefined
            }}
            onAddSsh={(target) => pty.addSsh(activeWs, activeTabId, target, effectivePath)}
            sshTargets={sshTargets}
            layout={pty.getTabLayout(activeTabId)}
            onLayoutChange={(layout) => pty.setTabLayout(activeTabId, layout)}
            onOpenUrl={openBrowserUrl}
            pluginTerminalWatchers={pluginTerminalWatchers}
            onPluginTerminalWatcher={(target, paneId) => runPluginActionTarget(target, { source: 'terminal-watcher', terminalPaneId: paneId })}
          />
        </>
      ) : (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted-foreground)' }}>
          No workspace selected
        </div>
      )}
    </div>
  )

  const MoreSheetContent = () => (
    <div style={{ padding: 'var(--space-4)', maxHeight: 'calc(100vh - 200px)', overflow: 'auto' }}>
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <h3 className="cc-h3" style={{ margin: '0 0 var(--space-3)' }}>Settings</h3>
        <button
          onClick={() => { handleNewTab('settings'); mobile.closeSheet('more') }}
          style={{
            width: '100%', padding: 'var(--space-3)', background: 'var(--card)', color: 'var(--foreground)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '14px',
            textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)'
          }}
        >
          <Icon name="settings" size={20} />
          <span>Settings</span>
        </button>
        <button
          onClick={() => { handleNewTab('archive'); mobile.closeSheet('more') }}
          style={{
            width: '100%', padding: 'var(--space-3)', background: 'var(--card)', color: 'var(--foreground)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '14px',
            textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-2)'
          }}
        >
          <Icon name="archive" size={20} />
          <span>Archive</span>
        </button>
        <button
          onClick={() => { handleNewTab('prompts'); mobile.closeSheet('more') }}
          style={{
            width: '100%', padding: 'var(--space-3)', background: 'var(--card)', color: 'var(--foreground)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '14px',
            textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-2)'
          }}
        >
          <Icon name="fileText" size={20} />
          <span>Prompts & Skills</span>
        </button>
        <button
          onClick={() => { handleNewTab('plugins'); mobile.closeSheet('more') }}
          style={{
            width: '100%', padding: 'var(--space-3)', background: 'var(--card)', color: 'var(--foreground)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '14px',
            textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-2)'
          }}
        >
          <Icon name="plug" size={20} />
          <span>Plugins</span>
        </button>
        <button
          onClick={() => { handleNewTab('mission'); mobile.closeSheet('more') }}
          style={{
            width: '100%', padding: 'var(--space-3)', background: 'var(--card)', color: 'var(--foreground)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '14px',
            textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-2)'
          }}
        >
          <Icon name="cpu" size={20} />
          <span>Mission Control</span>
        </button>
      </div>
      <div>
        <h3 className="cc-h3" style={{ margin: '0 0 var(--space-3)' }}>Actions</h3>
        <button
          onClick={() => { startCrewFromAnywhere(); mobile.closeSheet('more') }}
          style={{
            width: '100%', padding: 'var(--space-3)', background: 'var(--primary)', color: 'var(--primary-foreground)',
            border: 'none', borderRadius: 'var(--radius)', fontSize: '14px', fontWeight: 500,
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)'
          }}
        >
          <Icon name="crew" size={20} />
          <span>Start Crew</span>
        </button>
        <button
          onClick={() => { startCanvasFromAnywhere(); mobile.closeSheet('more') }}
          style={{
            width: '100%', padding: 'var(--space-3)', background: 'var(--card)', color: 'var(--foreground)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '14px',
            textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-2)'
          }}
        >
          <Icon name="workbench" size={20} />
          <span>Canvas Mode</span>
        </button>
        <button
          onClick={() => { openInEditor(); mobile.closeSheet('more') }}
          style={{
            width: '100%', padding: 'var(--space-3)', background: 'var(--card)', color: 'var(--foreground)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '14px',
            textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-2)'
          }}
        >
          <Icon name="external" size={20} />
          <span>Open in VS Code</span>
        </button>
      </div>
    </div>
  )

  return (
    <MissionDataProvider
      workspaces={ws.workspaces}
      crewSessions={crew.sessions}
      chatSessions={chatSessions.sessionsByTab}
      agents={agents}
      userRequestsByTab={missionUserRequestsByTab}
      isBridgeRunning={bridges.isBridgeRunning}
    >
      <MobileShell
        isMobile={mobile.isMobile}
        sheets={{
          workspaces: {
            open: mobile.sheets.workspaces?.open ?? false,
            title: 'Workspaces',
            content: <WorkspacesContent />
          },
          git: {
            open: mobile.sheets.git?.open ?? false,
            title: 'Git',
            content: <GitSheetContent />
          },
          terminal: {
            open: mobile.sheets.terminal?.open ?? false,
            title: 'Terminal',
            content: <TerminalSheetContent />
          },
          more: {
            open: mobile.sheets.more?.open ?? false,
            title: 'More',
            content: <MoreSheetContent />
          },
          'mission-activity': {
            open: mobile.sheets['mission-activity']?.open ?? false,
            title: 'Activity',
            content: <MissionActivitySheetHost />
          },
        }}
        onSheetToggle={mobile.onSheetToggle}
      >
        <div className="app">
          {loadingScreenMounted && <LoadingScreen exiting={!showLoadingScreen} />}

          {!settings.onboardingCompleted && !showLoadingScreen && (
            <Onboarding
              agents={agents}
              defaultAgent={settings.defaultAgent}
              onSetDefaultAgent={(id) => setSetting('defaultAgent', id)}
              hasProjects={ws.workspaces.length > 0}
              onAddProject={() => setAddOpen(true)}
              onFinish={() => setSetting('onboardingCompleted', true)}
            />
          )}

        <div className={`window-tabs${windowTabsHidden ? ' mobile-tabs-hidden' : ''}`}>
          <WindowTabs
            tabs={displayTabs}
            activeId={activeTabId}
            onActivate={setActiveTabId}
            onClose={handleCloseTab}
            crewTabs={crewTabs}
            splitGroups={splitGroups}
            splitTabIds={splitTabIds}
            splitPrimaryTabId={splitPrimaryTabId}
            onSplit={setSplitTab}
            onPin={pinTab}
            onUnpin={unpinTab}
            onRename={handleRenameWindowTab}
            onColor={setTabColor}
            onReorder={reorderTab}
            activeKind={activeTab?.kind}
            appMenuFootStatus={`${activeWorkspace?.name || 'no workspace'} · ${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
            onAppMenuAction={handleAppMenuAction}
            pluginMenuItems={pluginAddMenuItems}
            onPluginMenuItem={(item) => runPluginActionTarget(item.target, { source: 'plugin-menu' })}
            onNewTabMenuOpenChange={setWindowTabsMenuOpen}
          />
        </div>
        <NotificationBar
          onNavigateToChat={navigateToChatScope}
          resolveChatSource={voiceNotificationSource}
        />
        <TooltipHost />
        <GitAuthModal
          open={!!gitAuthRequest}
          remoteUrl={gitAuthRequest?.remoteUrl}
          error={gitAuthRequest?.error}
          onSubmit={resolveGitAuth}
          onCancel={() => resolveGitAuth(null)}
        />
        <GitSigningModal
          open={!!gitSigningRequest}
          error={gitSigningRequest?.error}
          onSubmit={resolveSigningPassphrase}
          onCancel={() => resolveSigningPassphrase(null)}
        />
        <ChatNotifications
          sessActive={sessActive}
          show={show}
        />

        <MenuletHost
          open={menuletOpen}
          onToggle={() => setMenuletOpen(o => !o)}
          onClose={() => setMenuletOpen(false)}
          onOpenHub={openMissionControl}
          onOpenAgent={handleMcOpen}
          onPauseAgent={handleMcPause}
          onResumeAgent={handleMcResume}
          onSpawnAgent={handleMcSpawn}
          onRespondRequest={bridges.respondUserRequest}
        />

        <SystemMonitorMount
          open={systemMonitorOpen}
          onOpenChange={setSystemMonitorOpen}
          terminals={sysmonTerminals}
          workspaces={sysmonWorkspaces}
          onKillTerminal={killTerminalSession}
          onOpenTerminal={openSysmonTerminal}
          onOpenDaemon={openSysmonDaemon}
        />

        <div className={`app-region drawer-${effectiveDrawerPosition}${drawerOpen ? ' drawer-open' : ''}`}>
        {effectiveDrawerPosition === 'left' && workspacesPanel}
        <div className="app-main-row">
          <div className="app-body">
          {splitVisible ? (
            <div className="app-body-split" ref={splitContainerRef}>
              {splitTabs.map((tab, idx) => (
                <Fragment key={tab.id}>
                  <div className={`app-pane ${idx === 0 ? 'app-pane-primary' : 'app-pane-secondary'}`} style={{ flex: splitPaneFlexes[idx] ?? 1 }}>
                    {renderTabContent(tab)}
                  </div>
                  {idx < splitTabs.length - 1 && (
                    <Splitter
                      orientation="vertical"
                      onDrag={delta => setSplitPaneFlexes(prev => {
                        const next = splitTabs.map((_, paneIdx) => prev[paneIdx] ?? 1)
                        const totalFlex = next.reduce((sum, value) => sum + value, 0)
                        const pairTotal = next[idx] + next[idx + 1]
                        const containerWidth = splitContainerRef.current?.clientWidth ?? 0
                        const splitterCount = Math.max(0, splitTabs.length - 1)
                        const usableWidth = Math.max(1, containerWidth - splitterCount * 5)
                        const pairWidth = Math.max(1, usableWidth * (pairTotal / totalFlex))
                        // Keep panes usable without letting the min-size clamp swallow
                        // all leftward drag range on narrower split pairs.
                        const minPanePx = Math.min(140, Math.max(72, pairWidth * 0.18))
                        const minPaneFlex = Math.min(pairTotal * 0.35, Math.max(0.12, (minPanePx / pairWidth) * pairTotal))
                        const a = Math.max(minPaneFlex, Math.min(pairTotal - minPaneFlex, next[idx] + (delta / pairWidth) * pairTotal))
                        next[idx] = a
                        next[idx + 1] = pairTotal - a
                        return next
                      })}
                    />
                  )}
                </Fragment>
              ))}
            </div>
          ) : (
            <>
              {activeTab?.kind !== 'terminal' && renderTabContent(activeTab)}
              {activeTab?.kind !== 'canvas' && terminalTabs.map(tab => {
                const isActiveTerminal = activeTab?.id === tab.id
                return (
                  <div
                    key={`terminal-keepalive-${tab.id}`}
                    className={isActiveTerminal ? 'terminal-keepalive active' : 'terminal-keepalive hidden'}
                    aria-hidden={isActiveTerminal ? undefined : 'true'}
                  >
                    {renderTabContent(tab, isActiveTerminal)}
                  </div>
                )
              })}
            </>
          )}
          {tabs
            .filter(tab => tab.kind === 'browser' && !visibleBrowserTabIds.has(tab.id))
            .map(tab => (
              <div key={`browser-keepalive-${tab.id}`} style={{ display: 'none' }} aria-hidden="true">
                {renderTabContent(tab)}
              </div>
            ))}
          </div>
          {pluginSidebar}
        </div>
        {effectiveDrawerPosition === 'right' && workspacesPanel}
      </div>

      <WorkspaceDock
        open={drawerOpen}
        activeWs={ws.workspaces.find(w => w.id === activeWs)}
        onToggle={() => setDrawerOpen(o => !o)}
        pluginStatusItems={pluginStatusItems}
        onPluginStatusItem={handlePluginStatusItem}
        activeAgentId={activeAgentId}
        activeAgentStatus={settings.connections[settings.defaultAgent] ? 'idle' : 'busy'}
        providerUsed={providerUsed}
        providerLimit={providerLimit}
        providerResetDescription={providerResetDescription}
        externalDirectoryCount={activeSession?.externalDirectories?.length ?? 0}
        onManageExternalDirectories={activeTab?.kind === 'chat' ? () => window.dispatchEvent(new CustomEvent('crewcode:manage-external-directories')) : undefined}
        hourlyUsedPercent={hourlyUsedPercent}
        hourlyResetDescription={hourlyResetDescription}
        weeklyUsedPercent={weeklyUsedPercent}
        weeklyResetDescription={weeklyResetDescription}
      />

      {effectiveDrawerPosition === 'bottom' && workspacesPanel}

      <AddProjectModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onBrowse={async () => {
          const id = await ws.addViaPicker()
          return id ?? null
        }}
        onPickFolder={ws.pickFolder}
        onClone={ws.cloneRepo}
        onInit={ws.initProject}
        onAddRemote={ws.addRemote}
        onAdded={(id) => { handleWsSelect(id); setDrawerOpen(false) }}
      />

      {crewSession && (
        <CrewConfirmDialog
          open={crewCtl.rebuildConfirmOpen}
          title="rebuild crew?"
          destructive
          icon="refresh"
          confirmText={`rebuild · ${crewSession.lanes.length} lane${crewSession.lanes.length === 1 ? '' : 's'}`}
          body={
            <ul className="crew-confirm-list">
              <li>
                <span className="crew-confirm-bullet stop">⏹</span>
                <span><b>stop</b> every running agent</span>
              </li>
              <li>
                <span className="crew-confirm-bullet rm">×</span>
                <span><b>remove</b> {crewSession.lanes.length} worktree{crewSession.lanes.length === 1 ? '' : 's'} on {crewSession.baseBranch}</span>
              </li>
              <li>
                <span className="crew-confirm-bullet clear">∅</span>
                <span><b>clear</b> all in-flight chat threads</span>
              </li>
              <li>
                <span className="crew-confirm-bullet keep">↻</span>
                <span><b>carry forward</b> mode, agents, roles, models, and effort — you'll relaunch from a fresh configure screen</span>
              </li>
            </ul>
          }
          onCancel={() => crewCtl.setRebuildConfirmOpen(false)}
          onConfirm={() => {
            crewCtl.setRebuildConfirmOpen(false)
            crewCtl.handleRebuildCrew()
          }}
        />
      )}
      {crewSession && crewSession.mode === 'isolated' && (
        <CrewDiffView
          open={crewCtl.crewDiffOpen}
          session={crewSession}
          agents={agents}
          onClose={() => crewCtl.setCrewDiffTab(null)}
        />
      )}
      {crewSession && crewSession.mode === 'isolated' && (
        <CrewGitSidebar
          open={crewCtl.crewGitOpen}
          session={crewSession}
          agents={agents}
          onClose={() => crewCtl.setCrewGitTab(null)}
          onAskAgent={(text) => composerDraftActions().set(crewSession.hostTabId, text)}
          onReconcileLane={(laneId, text) => crewCtl.sendToLane(laneId, text, true)}
          onWorktreesChanged={() => { if (activeWs) ws.refreshWorktrees(activeWs) }}
        />
      )}

      <PromptPicker
        open={promptPickerOpen}
        onClose={closePromptPicker}
        prompts={promptLib.prompts}
        skills={promptBuilderLib.skills}
        seed={{ repo: activeWorkspace?.name ?? '', branch: effectiveBranch }}
        onInsert={(body, p) => {
          promptLib.incUsage('prompts', p.id)
          if (promptPickerTarget) {
            composerDraftActions().set(promptPickerTarget.composerId, current => current ? `${current}\n\n${body}` : body)
          } else {
            insertPromptIntoComposer(body, p)
          }
        }}
        onToggleSkill={(skill) => {
          const sessionId = promptPickerTarget?.sessionId ?? promptBuilderSessionId
          if (!sessionId) return
          const enabled = toggleSkillForSession(sessionId, skill.id)
          if (enabled === null) return
          promptLib.incUsage('skills', skill.id)
          handleApplySkill({ ...skill, enabled })
        }}
      />

      <BrowserGrabSendModal
        open={!!pendingBrowserGrabSend}
        selection={pendingBrowserGrabSend?.selection ?? null}
        targets={browserGrabChatTargets}
        onClose={() => setPendingBrowserGrabSend(null)}
        onSendExisting={(target, comment) => { void sendBrowserGrabToChat(target, comment) }}
        onSendNewChat={(comment) => { void sendBrowserGrabToChat(null, comment) }}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        workspaceRoot={activeWorkspace?.path}
        onOpenFile={openFileInEditor}
        extraCommands={pluginCommands}
        onCommand={cmd => {
          if (cmd.id.startsWith('plugin:tab:')) {
            const registrationId = cmd.id.slice('plugin:tab:'.length)
            const pluginTab = pluginTabs.find(tab => tab.registrationId === registrationId)
            if (pluginTab) openPluginTab(pluginTab, { source: 'command-palette' })
            return
          }
          handleAction(cmd.id)
        }}
      />

      {settings.showTweaksPanel && (
        <TweaksPanel title="Tweaks">
          <TweakSection label="Layout" />
          <TweakRadio   label="Density"  value={tweaks.density}  options={['compact','regular']} onChange={v => setTweak('density',  v as TweakConfig['density'])} />
          <TweakRadio
            label="Workspaces dock"
            value={effectiveDrawerPosition}
            options={mobile.isMobile ? ['left', 'right'] : ['bottom', 'left', 'right']}
            onChange={v => {
              if (mobile.isMobile) setMobileDrawerSide(v === 'right' ? 'right' : 'left')
              else setTweak('drawerPosition', v as TweakConfig['drawerPosition'])
            }}
          />
          {effectiveDrawerPosition === 'bottom'
            ? <TweakSlider label="Drawer height" value={tweaks.drawerHeight} min={220} max={560} step={20} unit="px" onChange={v => setTweak('drawerHeight', v)} />
            : <TweakSlider label="Sidebar width" value={tweaks.drawerWidth} min={220} max={480} step={20} unit="px" onChange={v => setTweak('drawerWidth', v)} />}
          <TweakSection label="Quick actions" />
          <TweakButton  label={drawerOpen ? 'Close workspaces  ⌘B' : 'Workspaces  ⌘B'} onClick={() => setDrawerOpen(o => !o)} secondary />
          <TweakButton  label="Open Settings…" onClick={() => handleNewTab('settings')} />
        </TweaksPanel>
      )}

      {ctxMenu && (
        <ChatContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={chatMenuItems}
          onPick={onChatMenuPick}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {selectionSpeech.phase === 'loading' && (
        <div className="selection-speech-loading" role="status" aria-live="polite">
          <span className="voice-orb-spinner" aria-hidden />
          <span>Preparing speech</span>
        </div>
      )}

<DialogHost />
        </div>
      </MobileShell>
    </MissionDataProvider>
  )
}

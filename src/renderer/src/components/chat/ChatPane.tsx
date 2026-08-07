import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { TermColumn } from '../terminal/TermColumn'
import { terminalColumnIsVisible } from '../terminal/terminal-column-visibility'
import type { Layout } from '../../hooks/useTerminalSessions'
import { Splitter } from './Splitter'
import { SoloChatView } from './SoloChatView'
import { ExternalDirectoriesModal } from './ExternalDirectoriesModal'
import { CrewBranch } from './CrewBranch'
import { GitSidebar } from '../git/GitSidebar'
import { TurnChangesDrawer } from '../thread/TurnChangesDrawer'
import type { useGitSidebar } from '../../hooks/useGitSidebar'
import { MODE_FROM_SETTINGS, MODE_TO_LEVEL, normalizeModeLevel } from '../../app-constants'
import { titleFromFirstMessage } from '../../hooks/useChatSessions'
import { useComposerSend } from '../../hooks/useComposerSend'
import { useSessionDelegation } from '../../hooks/useSessionDelegation'
import { canSessionDelegate } from '../../hooks/delegation-eligibility'
import { describeProviders } from '../../hooks/delegation-provider-selection'
import { knownModelIds } from '../../hooks/useProviderModels'
import { useMessagesForScope, useMessagesForScopes, useMessagesStore } from '../../stores/chat-messages-store'
import { useComposerDraft } from '../../stores/composer-draft-store'
import { useBridgeStatus, useIsBridgeRunning, useQueuedFollowUps, useUserRequestsByTab, useUserRequestsForTab } from '../../stores/bridge-activity-store'
import { useAppliedSkillsBySession } from '../../hooks/useAppliedSkillsBySession'
import { useAppliedModesBySession } from '../../hooks/useAppliedModesBySession'
import { extractProviderPatchChanges, pathField } from '../../hooks/turn-file-edit-detect'
import { orchestrationAgents } from '../../terminal-only-agents'
import type { AgentInfo, ChatAttachment, GitHubStatus, Message, ModeLevel, Workspace } from '../../types'
import type { RegisteredPluginChatHeaderItem, RegisteredPluginGitLens, RegisteredPluginTerminalWatcher } from '../../../../shared/plugin-types'
import type { CustomCommand, Prompt, Skill } from '../../types/prompts'
import type { Mode } from '../composer/ModeSegment'
import type { EffortLevel } from '../composer/EffortPicker'
import { useSettings, type McpServerConfig } from '../../hooks/useSettings'
import { resolveSessionMcpServers } from '../../hooks/session-mcp-selection'
import { useVoiceSessionController } from '../../hooks/useVoiceSessionController'

type CrewBranchWithMessagesProps = Omit<React.ComponentProps<typeof CrewBranch>, 'messagesByTab'>

function CrewBranchWithMessages(props: CrewBranchWithMessagesProps) {
  const scopeIds = useMemo(() => {
    const ids = props.session.lanes.map(lane => lane.tabId).filter((id): id is string => !!id)
    const supervisorTab = props.session.supervisor.tabId ?? `crew/${props.session.id}/supervisor`
    return [...ids, supervisorTab]
  }, [props.session])
  const messagesByTab = useMessagesForScopes(scopeIds)
  return <CrewBranch {...props} messagesByTab={messagesByTab} />
}

interface ChatPaneProps {
  tabId: string
  activeWs: string
  workspace: Workspace
  effectivePath: string
  effectiveBranch: string
  worktreeBranch?: string | null
  agents: AgentInfo[]
  chatSessions: any
  bridges: any
  pty: any
  crewSession?: any | null
  crewCtl?: any
  prompts?: Prompt[]
  skills?: Skill[]
  commands?: CustomCommand[]
  density?: 'compact' | 'regular'
  hideHeader?: boolean
  threadView: 'chat' | 'code' | 'md'
  setThreadView: (view: 'chat' | 'code' | 'md') => void
  shortcutOverrides?: any
  onOpenFile: (path: string) => void
  onOpenPrompts: () => void
  enabledSkills?: Skill[]
  /** Reports a session-scoped activation change for user feedback. */
  onToggleSkillEnabled?: (id: string) => void
  editorInitialFile?: string | null
  settingsDefaultAgent?: string
  settingsDefaultMode?: string
  // MCP registry + master switch (from Settings). Per-session selection lives on
  // the session itself; this pane derives it and writes back via chatSessions.
  mcpEnabled?: boolean
  mcpServers?: McpServerConfig[]
  // Git/open-drawer state is lifted so the header controls and side panes stay
  // in sync with App-owned editor/diff state.
  gitOpen: boolean
  setGitOpen: (open: boolean) => void
  github?: GitHubStatus | null
  dirtyCount?: number
  git: ReturnType<typeof useGitSidebar>
  gitWidth: number
  setGitWidth: React.Dispatch<React.SetStateAction<number>>
  onOpenGitFileDiff: (path: string, staged: boolean) => void
  pendingGitDiff: { title: string; diff: string } | null
  setPendingGitDiff: (d: { title: string; diff: string } | null) => void
  changesDrawerOpen: boolean
  setChangesDrawerOpen: (open: boolean) => void
  /** Right-click on the thread area — used to open the chat context menu. */
  onThreadContextMenu?: (e: React.MouseEvent) => void
  onOpenBrowser?: (url?: string) => void
  onOpenCanvas?: () => void
  /** Global Tweaks visibility for embedded terminal columns. */
  terminalColumnVisible?: boolean
  /** Updates global Tweaks visibility when the chat header toggles its terminal. */
  onTerminalColumnVisibleChange?: (visible: boolean) => void
  /** Terminal column width (chat tabs only). */
  termWidth?: number
  /** Update terminal column width (chat tabs only). */
  setTermWidth?: React.Dispatch<React.SetStateAction<number>>
  /** Shell executable to use when opening a terminal from this chat tab. */
  terminalShell?: string
  /** Terminal layout for this tab's panes. */
  termLayout?: Layout
  /** Update terminal layout for this tab. */
  onTermLayoutChange?: (layout: Layout) => void
  pluginChatHeaderItems?: RegisteredPluginChatHeaderItem[]
  onPluginChatHeaderItem?: (target: { pluginId: string; sidebarPanel?: string; tab?: string; command?: string }) => void
  pluginGitLenses?: RegisteredPluginGitLens[]
  onPluginGitLens?: (target: { pluginId: string; sidebarPanel?: string; tab?: string; command?: string }) => void
  pluginTerminalWatchers?: RegisteredPluginTerminalWatcher[]
  onPluginTerminalWatcher?: (target: { pluginId: string; sidebarPanel?: string; tab?: string; command?: string }, paneId: string) => void
  freshChat?: { kicker?: string; title: string; body: string; suggestions: string[] }
  /** Refresh App-owned worktree metadata before selecting a newly-created worktree. */
  onWorktreesChanged?: () => void | Promise<void>
}

export function ChatPane({
  tabId,
  activeWs,
  workspace,
  effectivePath,
  effectiveBranch,
  worktreeBranch,
  agents,
  chatSessions,
  bridges,
  pty,
  crewSession,
  crewCtl,
  density = 'regular',
  hideHeader = false,
  threadView,
  setThreadView,
  shortcutOverrides,
  onOpenFile,
  onOpenPrompts,
  onOpenBrowser,
  onOpenCanvas,
  enabledSkills = [],
  prompts = [],
  skills = [],
  commands = [],
  onToggleSkillEnabled,
  editorInitialFile,
  settingsDefaultAgent = 'pi',
  settingsDefaultMode = 'build',
  mcpEnabled = false,
  mcpServers = [],
  gitOpen,
  setGitOpen,
  github,
  dirtyCount = 0,
  git,
  gitWidth,
  setGitWidth,
  onOpenGitFileDiff,
  pendingGitDiff,
  setPendingGitDiff,
  changesDrawerOpen,
  setChangesDrawerOpen,
  onThreadContextMenu,
  terminalColumnVisible,
  onTerminalColumnVisibleChange,
  termWidth: externalTermWidth,
  setTermWidth: externalSetTermWidth,
  terminalShell,
  termLayout,
  onTermLayoutChange,
  pluginChatHeaderItems = [],
  onPluginChatHeaderItem,
  pluginGitLenses = [],
  onPluginGitLens,
  pluginTerminalWatchers = [],
  onPluginTerminalWatcher,
  freshChat,
  onWorktreesChanged,
}: ChatPaneProps) {
  // Draft lives in an isolated store keyed by this tab. Typing re-renders only
  // this pane, not App (and therefore not sibling Workbench panes).
  const [composer, setComposer] = useComposerDraft(tabId)
  const [fallbackTermWidth, setFallbackTermWidth] = useState(360)
  const termWidth = externalTermWidth ?? fallbackTermWidth
  const setTermWidth = externalSetTermWidth ?? setFallbackTermWidth
  const threadRef = useRef<HTMLDivElement>(null)
  const appliedSkills = useAppliedSkillsBySession()
  const appliedModes = useAppliedModesBySession()

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

  useEffect(() => { chatSessions.ensureTab(tabId, workspace.name) }, [tabId, workspace.name])

  const activeSession = chatSessions.getActiveSession(tabId)
  const sessActive = activeSession?.id ?? tabId
  const sessionEnabledSkillIds = activeSession?.enabledSkillIds ?? []
  const sessionSkills = useMemo(() => {
    const activeIds = new Set(sessionEnabledSkillIds)
    return skills.filter(skill => activeIds.has(skill.id))
  }, [sessionEnabledSkillIds, skills])
  const effectiveEnabledSkills = useMemo(() => {
    const seen = new Set<string>()
    return [...enabledSkills, ...sessionSkills].filter(skill => {
      if (seen.has(skill.id)) return false
      seen.add(skill.id)
      return true
    })
  }, [enabledSkills, sessionSkills])
  const skillsWithSessionState = useMemo(() => {
    const activeIds = new Set(sessionEnabledSkillIds)
    return skills.map(skill => ({ ...skill, enabled: activeIds.has(skill.id) }))
  }, [sessionEnabledSkillIds, skills])
  const toggleSessionSkill = useCallback((id: string) => {
    const current = chatSessions.getActiveSession(tabId)
    if (!current) return
    const ids = current.enabledSkillIds ?? []
    const enabled = !ids.includes(id)
    chatSessions.update(tabId, current.id, {
      enabledSkillIds: enabled ? [...ids, id] : ids.filter((skillId: string) => skillId !== id),
    })
    onToggleSkillEnabled?.(id)
  }, [chatSessions, onToggleSkillEnabled, tabId])
  // Subscribe only to this session's scope. Hidden chat streams update other
  // scope arrays, so they no longer re-render the visible thread mid-scroll.
  const messages = useMessagesForScope(sessActive)
  const setMessagesForTab = useMessagesStore((s) => s.setMessagesForTab)

  const activeAgentId = activeSession?.agentId ?? settingsDefaultAgent ?? 'pi'
  const model = activeSession?.model ?? ''
  const effort = (activeSession?.effort ?? 'medium') as EffortLevel
  const modeLevel = normalizeModeLevel(activeSession?.mode ?? settingsDefaultMode)
  const composerMode: Mode = MODE_FROM_SETTINGS[modeLevel] ?? 'Build'
  const tabPanes = useMemo(() => pty.panes.filter((p: any) => p.tabId === tabId), [pty.panes, tabId])
  const [terminalHidden, setTerminalHidden] = useState(false)
  const [sendInFlight, setSendInFlight] = useState(false)
  const [externalDirsMode, setExternalDirsMode] = useState<'add' | 'remove' | null>(null)
  useEffect(() => {
    const open = () => setExternalDirsMode('add')
    window.addEventListener('crewcode:manage-external-directories', open)
    return () => window.removeEventListener('crewcode:manage-external-directories', open)
  }, [])
  const controlledTerminalVisibility = terminalColumnVisible !== undefined
  const terminalVisible = terminalColumnIsVisible(tabPanes.length, terminalColumnVisible, terminalHidden)
  const setTerminalVisible = useCallback((visible: boolean) => {
    if (controlledTerminalVisibility) onTerminalColumnVisibleChange?.(visible)
    else setTerminalHidden(!visible)
  }, [controlledTerminalVisibility, onTerminalColumnVisibleChange])
  const openTerminalForPath = useCallback((path: string) => {
    setTerminalVisible(true)
    pty.addShell(activeWs, tabId, path, terminalShell)
  }, [activeWs, pty, setTerminalVisible, tabId, terminalShell])
  const openHeaderTerminal = useCallback(() => {
    if (terminalVisible) {
      setTerminalVisible(false)
      return
    }
    setTerminalVisible(true)
    if (tabPanes.length === 0) pty.ensurePane(tabId, activeWs, effectivePath, terminalShell)
  }, [activeWs, effectivePath, pty, setTerminalVisible, tabId, tabPanes.length, terminalShell, terminalVisible])
  const activeAgentPane = useMemo(() =>
    [...tabPanes].reverse().find((p: any) => p.agentId === activeAgentId) ?? null,
    [tabPanes, activeAgentId],
  )

  const activeChangesCount = useMemo(() => {
    const seen = new Set<string>()
    for (const msg of messages) {
      if (msg.kind !== 'toolcall') continue
      for (const change of msg.fileChanges ?? (msg.fileChange ? [msg.fileChange] : [])) seen.add(change.path)
      for (const change of extractProviderPatchChanges(msg.metadata, msg.args, msg.result)) seen.add(change.path)
      if (msg.args && typeof msg.args === 'object') {
        const args = msg.args as Record<string, unknown>
        const p = pathField(args)
        const rawPatch = typeof msg.metadata?.diff === 'string'
          ? msg.metadata.diff
          : typeof args.patch === 'string'
            ? args.patch
            : typeof msg.result === 'string'
              ? msg.result
              : ''
        if (p && /^diff --git |^--- |^@@ /m.test(rawPatch)) seen.add(p)
      }
    }
    return seen.size
  }, [messages])

  const setActiveAgentId = useCallback((id: string) => {
    chatSessions.update(tabId, sessActive, { agentId: id })
  }, [tabId, sessActive, chatSessions])

  const setModel = useCallback((m: string) => {
    chatSessions.update(tabId, sessActive, { model: m })
  }, [tabId, sessActive, chatSessions])

  const setEffort = useCallback((e: EffortLevel) => {
    chatSessions.update(tabId, sessActive, { effort: e })
  }, [tabId, sessActive, chatSessions])

  const setComposerMode = useCallback((m: Mode) => {
    chatSessions.update(tabId, sessActive, { mode: MODE_TO_LEVEL[m] })
  }, [tabId, sessActive, chatSessions])

  const selectedMcpIds = activeSession?.mcpServerIds ?? []
  const onToggleMcp = useCallback((id: string) => {
    const current = chatSessions.getActiveSession(tabId)?.mcpServerIds ?? []
    const next = current.includes(id) ? current.filter((x: string) => x !== id) : [...current, id]
    chatSessions.update(tabId, sessActive, { mcpServerIds: next })
  }, [tabId, sessActive, chatSessions])

  const setMessages = useCallback((updater: (prev: Message[]) => Message[]) => {
    setMessagesForTab(sessActive, updater)
  }, [sessActive, setMessagesForTab])

  const [attachments, setAttachmentsState] = useState<ChatAttachment[]>([])
  const attachmentsRef = useRef<ChatAttachment[]>([])
  const setAttachments = useCallback((next: ChatAttachment[]) => {
    attachmentsRef.current = next
    setAttachmentsState(next)
  }, [])
  useEffect(() => {
    // Attachments belong to the currently mounted chat session only; switching
    // sessions should not leak unsent files across unrelated follow-ups.
    setAttachments([])
  }, [sessActive, setAttachments])

  // Delegation credentials for THIS pane's session. Per-pane on purpose: a split
  // layout has two live chats, and each needs its own token.
  const { state: appSettings } = useSettings()
  const delegationProviders = useCallback(
    () => describeProviders(agents, knownModelIds, agentId => knownModelIds(agentId)[0]),
    [agents],
  )
  const delegation = useSessionDelegation({
    session: activeSession ?? null,
    mode: modeLevel,
    maxConcurrent: appSettings.maxDelegatedThreads,
    allowFullAccess: appSettings.allowFullAccessDelegation,
    remote: workspace.kind === 'remote',
    providers: delegationProviders,
    // Only worktree ISOLATION needs a git repo. `build` mode stays available in a
    // plain folder — running tests in the shared checkout involves no git at all.
    worktreeIsolationEnabled: workspace.kind === 'repo',
    wakeParentOnReport: appSettings.wakeParentOnDelegatedReport !== false,
  })
  const toggleDelegation = useCallback(() => {
    if (!activeSession) return
    chatSessions.update(tabId, activeSession.id, { delegationEnabled: !activeSession.delegationEnabled })
  }, [activeSession, chatSessions, tabId])

  const modePromptsEnabled = activeSession?.modePromptsEnabled ?? true
  const modePromptsLocked = messages.length > 0 || lastDeliveredMode(sessActive) !== undefined
  const toggleModePrompts = useCallback(() => {
    const current = chatSessions.getActiveSession(tabId)
    if (!current || modePromptsLocked) return
    chatSessions.update(tabId, current.id, {
      modePromptsEnabled: !(current.modePromptsEnabled ?? true),
    })
  }, [chatSessions, modePromptsLocked, tabId])

  const { send, sendText } = useComposerSend({
    activeWs,
    activeTabId: tabId,
    sessActive,
    composer,
    setComposer,
    setMessages,
    agents,
    activeAgentId,
    model,
    effort,
    mode: modeLevel,
    effectivePath,
    bridges,
    pty,
    activeAgentPane,
    enabledSkills: effectiveEnabledSkills,
    skillsDeliveredTo,
    markSkillsDelivered: appliedSkills.markDelivered,
    lastDeliveredMode,
    markModeDelivered,
    modePromptsEnabled,
    modePrompts: appSettings.modePrompts,
    sessionHasExistingMessages: messages.length > 0,
    delegationPreamble: delegation.preamble,
    delegationDeliveredTo: delegation.delivered,
    markDelegationDelivered: delegation.markDelivered,
    getAttachments: () => attachmentsRef.current,
    // Resolve at send time so a toggle right before sending is honored.
    getMcpServers: () =>
      resolveSessionMcpServers(mcpEnabled, mcpServers, chatSessions.getActiveSession(tabId)?.mcpServerIds),
    workspaceName: workspace.name,
    workspaceBranch: worktreeBranch ?? effectiveBranch,
    externalDirectories: activeSession?.externalDirectories ?? [],
  })

  const sendWithSessionTitle = useCallback(async (overrideText?: string) => {
    // overrideText lets custom slash-commands fire their body directly without
    // routing through the composer draft (which would lag a tick behind state).
    const text = (overrideText ?? composer).trim()
    if (!text) return
    // Cover the gap between appending the user message and bridge runtime state
    // propagation, so the loader appears immediately and stays through await.
    setSendInFlight(true)
    try {
      if (messages.length === 0) {
        const nextLabel = titleFromFirstMessage(text) || workspace.name
        if (nextLabel && nextLabel !== activeSession?.label) {
          chatSessions.update(tabId, sessActive, { label: nextLabel })
        }
      }
      if (overrideText === undefined) await send()
      else await sendText(text, attachmentsRef.current)
    } finally {
      setSendInFlight(false)
    }
  }, [activeSession?.label, attachmentsRef, chatSessions, composer, messages.length, send, sendText, sessActive, tabId, workspace.name])

  const queueFollowUp = useCallback(() => {
    const text = composer.trim()
    if (!text) return
    const queuedAttachments = attachmentsRef.current
    setComposer('')
    setAttachments([])
    // Delegate timing to the provider; it knows the safe point inside the
    // current stream better than CrewCode's renderer-level turn_end heuristic.
    void sendText(text, queuedAttachments, { streamingBehavior: 'followUp' })
  }, [composer, sendText, setAttachments, setComposer])

  // Live agent state comes from bridge-activity-store, scoped to this pane's
  // bridge/tab. Subscribing directly means the Stop button, spinner, follow-up
  // pills and permission prompts stay correct on their own — they no longer rely
  // on the `bridges` prop being reallocated every App render.
  const activeBridgeId: string | null = bridges.getBridgeId?.(sessActive, activeAgentId) ?? null
  const pendingAgentRequest = useUserRequestsForTab(sessActive)[0] ?? null
  // Follow-ups the bridge is holding until the current turn finishes (claude
  // queues locally; providers that queue upstream report nothing here).
  const queuedFollowUps = useQueuedFollowUps(activeBridgeId)
  const bridgeRunning = useIsBridgeRunning(activeBridgeId)
  const loadingStatus = useBridgeStatus(activeBridgeId)
  // Crew lanes each have their own tab, so the crew branch needs the whole map.
  // Requests are rare, so this subscription is quiet.
  const userRequestsByTab = useUserRequestsByTab()

  const removeQueuedFollowUp = useCallback((followUpId: string) => {
    void bridges.removeQueuedFollowUp?.(sessActive, activeAgentId, followUpId)
  }, [bridges, sessActive, activeAgentId])

  const isRunning = useMemo(() => {
    const agent = agents.find(a => a.id === activeAgentId)
    if (agent?.transport !== 'bridge') return false
    if (bridgeRunning) return true
    const last = messages[messages.length - 1]
    if (!last) return false
    if (last.kind === 'agent' && last.streaming) return true
    if (last.kind === 'thinking' && last.streaming) return true
    if (last.kind === 'toolcall' && (last.status === 'pending' || last.status === 'running')) return true
    return false
  }, [agents, activeAgentId, bridgeRunning, messages])

  const voiceControl = useVoiceSessionController({
    scopeId: sessActive,
    agentLabel: agents.find(agent => agent.id === activeAgentId)?.name ?? activeAgentId,
    agentRunning: isRunning,
    sendText,
  })

  // A custom slash-command fires the moment it is picked. While the agent is
  // running the body is queued as a follow-up (mirroring composer send); idle,
  // it dispatches immediately with session-title/loader handling.
  const runCommand = useCallback((body: string) => {
    const text = body.trim()
    if (!text) return
    if (text === '/add-dir' || text === '/remove-dir') {
      setExternalDirsMode(text === '/add-dir' ? 'add' : 'remove')
      return
    }
    if (isRunning) {
      void sendText(text, attachmentsRef.current, { streamingBehavior: 'followUp' })
      return
    }
    void sendWithSessionTitle(text)
  }, [isRunning, sendText, attachmentsRef, sendWithSessionTitle, workspace.kind, setMessages, chatSessions, tabId, bridges, activeAgentId])

  // Agents offered as chat providers / crew lanes. Terminal-only CLIs (Claude
  // Code) are filtered out here but stay available via the terminal column.
  const chatAgents = useMemo(() => orchestrationAgents(agents), [agents])

  const stop = useCallback(() => {
    const bridgeId = bridges.getBridgeId?.(sessActive, activeAgentId)
    if (!bridgeId) return

    // A hard stop tears down the live bridge so providers that ignore aborts
    // still stop streaming immediately and the next send gets a fresh bridge.
    bridges.dropBridge(sessActive, activeAgentId)
    setMessages(prev => {
      const next = prev.map(msg => {
        if (msg.kind === 'agent' && msg.streaming) return { ...msg, streaming: false }
        if (msg.kind === 'thinking' && msg.streaming) return { ...msg, streaming: false }
        if (msg.kind === 'toolcall' && (msg.status === 'pending' || msg.status === 'running')) {
          return { ...msg, status: 'error' as const, isError: true, result: 'stopped by user' }
        }
        return msg
      })
      return [...next, { kind: 'system', tone: 'info', text: 'request stopped', time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }]
    })
  }, [bridges, sessActive, activeAgentId, setMessages])

  const currentGitBranch = git.state.branch || effectiveBranch

  const openBranchInWorktree = useCallback(async (ref: string, opts?: { createFrom?: string }) => {
    const branch = ref.replace(/^origin\//, '')
    const existing = git.state.worktrees.find(w => w.branch === branch || w.branch === ref)
    if (existing) {
      // App owns the active effectivePath, so refresh its worktree list before
      // selecting an id that may have come from the Git sidebar's newer scan.
      await onWorktreesChanged?.()
      git.handlers.onSwitchWorktree?.(existing.id)
      return
    }

    const api = window.electronAPI
    if (!api) return
    const startPoint = opts?.createFrom ?? (ref.startsWith('origin/') ? ref : undefined)
    const created = await api.worktreeCreate(workspace.path, branch, undefined, startPoint)
    if (created.error || !created.path) return

    const listed = await api.worktreeList(workspace.path)
    const worktree = listed.worktrees?.find(w => w.path === created.path || w.branch === branch)
    await onWorktreesChanged?.()
    await git.refresh()
    if (worktree) git.handlers.onSwitchWorktree?.(worktree.id)
  }, [git, onWorktreesChanged, workspace.path])

  if (crewSession && crewCtl) {
    return (
      <CrewBranchWithMessages
        activeTabId={tabId}
        session={crewSession}
        agents={chatAgents}
        editing={crewCtl.crewEditing}
        ptyPanes={tabPanes}
        templates={crewCtl.crewTemplates}
        crew={crewCtl.crew}
        sendToLane={crewCtl.sendToLane}
        onBroadcast={crewCtl.handleBroadcast}
        closePtyPane={pty.close}
        onEnterEditing={() => crewCtl.setCrewEditingTab(tabId)}
        onExitEditing={() => crewCtl.setCrewEditingTab(null)}
        setCrewDiffTab={crewCtl.setCrewDiffTab}
        setCrewGitTab={crewCtl.setCrewGitTab}
        setRebuildConfirmOpen={crewCtl.setRebuildConfirmOpen}
        onApplyTemplate={crewCtl.handleApplyTemplate}
        onDeleteTemplate={crewCtl.handleDeleteTemplate}
        onSaveTemplate={crewCtl.handleSaveTemplate}
        onSetLaneRole={crewCtl.handleSetLaneRole}
        roles={crewCtl.crewRoles}
        onSaveRole={crewCtl.handleSaveRole}
        onUpdateRole={crewCtl.handleUpdateRole}
        onDeleteRole={crewCtl.handleDeleteRole}
        onSetLaneModel={crewCtl.handleSetLaneModel}
        onSetLaneEffort={crewCtl.handleSetLaneEffort}
        onRestartLane={crewCtl.handleRestartLane}
        onToggleLaneMute={crewCtl.handleToggleLaneMute}
        onAbortAll={crewCtl.abortAll}
        onAbortSupervisor={crewCtl.abortSupervisor}
        onSendToSupervisor={crewCtl.sendToSupervisor}
        onSetSupervisorEnabled={crewCtl.handleSetSupervisorEnabled}
        onSetSupervisorAgent={crewCtl.handleSetSupervisorAgent}
        onSetSupervisorModel={crewCtl.handleSetSupervisorModel}
        userRequestsByTab={userRequestsByTab}
        onAgentRequestResponse={response => bridges.respondUserRequest?.(response)}
      />
    )
  }

  return (
    <div className="chat-pane-row">
      <div
        className={`main ${terminalVisible ? '' : 'no-term'}`}
        style={{ ['--term-width' as any]: `${termWidth}px` }}
      >
        <div className="chat-col">
          <SoloChatView
            workspace={workspace}
            effectivePath={effectivePath}
            effectiveBranch={effectiveBranch}
            worktreeBranch={worktreeBranch}
            threadView={threadView}
            setThreadView={setThreadView}
            messages={messages}
            sessionKey={sessActive}
            threadRef={threadRef}
            density={density}
            hideHeader={hideHeader}
            pendingGitDiff={pendingGitDiff}
            setPendingGitDiff={setPendingGitDiff}
            agentLabel={agents.find(a => a.id === activeAgentId)?.name ?? activeAgentId}
            modelLabel={model}
            voiceControl={voiceControl}
            gitOpen={gitOpen}
            setGitOpen={setGitOpen}
            github={github}
            dirtyCount={dirtyCount}
            changesOpen={changesDrawerOpen}
            changesCount={activeChangesCount}
            toggleChangesOpen={() => setChangesDrawerOpen(!changesDrawerOpen)}
            onStartCrew={() => crewCtl?.handleStartCrew?.()}
            onOpenCanvas={onOpenCanvas}
            onOpenTerminal={openHeaderTerminal}
            composerMode={composerMode}
            setComposerMode={setComposerMode}
            composer={composer}
            setComposer={setComposer}
            onSend={sendWithSessionTitle}
            onRunCommand={runCommand}
            onQueueFollowUp={queueFollowUp}
            queuedFollowUps={queuedFollowUps}
            onRemoveQueuedFollowUp={removeQueuedFollowUp}
            isRunning={isRunning || sendInFlight}
            loadingStatus={loadingStatus}
            onStop={stop}
            agentRequest={pendingAgentRequest}
            onAgentRequestResponse={(response) => bridges.respondUserRequest?.(response)}
            agents={chatAgents}
            activeAgentId={activeAgentId}
            setActiveAgentId={setActiveAgentId}
            model={model}
            setModel={setModel}
            effort={effort}
            setEffort={setEffort}
            delegationEnabled={delegation.enabled}
            onToggleDelegation={canSessionDelegate(activeSession) ? toggleDelegation : undefined}
            modePromptsEnabled={modePromptsEnabled}
            modePromptsLocked={modePromptsLocked}
            onToggleModePrompts={toggleModePrompts}
            mcpEnabled={mcpEnabled}
            mcpServers={mcpServers}
            selectedMcpIds={selectedMcpIds}
            onToggleMcp={onToggleMcp}
            shortcutOverrides={shortcutOverrides}
            onOpenFile={onOpenFile}
            editorInitialFile={editorInitialFile}
            onThreadContextMenu={onThreadContextMenu}
            onOpenBrowser={onOpenBrowser}
            pluginChatHeaderItems={pluginChatHeaderItems}
            onPluginChatHeaderItem={onPluginChatHeaderItem}
            onOpenPrompts={onOpenPrompts}
            prompts={prompts}
            skills={skillsWithSessionState}
            commands={commands}
            onInsertPromptBody={(body) => {
              if (!body.trim()) return
              setComposer(prev => prev ? `${prev}\n\n${body}` : body)
            }}
            enabledSkills={effectiveEnabledSkills}
            deliveredSkillIds={skillsDeliveredTo(sessActive)}
            onToggleSkillEnabled={toggleSessionSkill}
            freshChat={freshChat}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            branchPicker={workspace.kind !== 'folder' ? {
              currentBranch: currentGitBranch,
              branches: git.state.branches || [],
              handlers: {
                onCheckoutBranch: (ref) => { void openBranchInWorktree(ref) },
                onCreateBranch: (name) => { void openBranchInWorktree(name, { createFrom: currentGitBranch }) },
              },
              onRefresh: () => { void git.refresh() },
            } : undefined}
          />
        </div>
        {terminalVisible && (
          <>
            <Splitter
              orientation="vertical"
              onDrag={delta => setTermWidth(w => Math.max(220, Math.min(window.innerWidth - 320, w - delta)))}
            />
            <TermColumn
              panes={tabPanes}
              agents={agents}
              onClose={pty.close}
              onAddShell={() => pty.addShell(activeWs, tabId, effectivePath)}
              onAddAgent={(agentId) => {
                const a = agents.find(x => x.id === agentId)
                return a ? pty.addAgent(activeWs, tabId, a.id, a.name, effectivePath, a.path) : undefined
              }}
              onAddSsh={(target) => pty.addSsh(activeWs, tabId, target, effectivePath)}
              layout={termLayout}
              onLayoutChange={onTermLayoutChange}
              onOpenUrl={(url) => onOpenBrowser?.(url)}
              pluginTerminalWatchers={pluginTerminalWatchers}
              onPluginTerminalWatcher={onPluginTerminalWatcher}
            />
          </>
        )}
      </div>
      <ExternalDirectoriesModal
        open={externalDirsMode !== null}
        initialMode={externalDirsMode ?? 'add'}
        directories={activeSession?.externalDirectories ?? []}
        providerId={activeAgentId}
        remote={workspace.kind === 'remote'}
        onClose={() => setExternalDirsMode(null)}
        onAdd={(path) => {
          if (!activeSession) return
          const dirs = activeSession.externalDirectories ?? []
          if (dirs.includes(path)) return
          chatSessions.update(tabId, activeSession.id, { externalDirectories: [...dirs, path] })
          bridges.dropBridge(activeSession.id, activeSession.agentId)
        }}
        onRemove={(path) => {
          if (!activeSession) return
          chatSessions.update(tabId, activeSession.id, { externalDirectories: (activeSession.externalDirectories ?? []).filter((dir: string) => dir !== path) })
          bridges.dropBridge(activeSession.id, activeSession.agentId)
        }}
      />
      <TurnChangesDrawer
        open={changesDrawerOpen}
        messages={messages}
        onClose={() => setChangesDrawerOpen(false)}
      />
      {gitOpen && (
        <>
          <Splitter
            orientation="vertical"
            onDrag={delta => setGitWidth(w => Math.max(280, Math.min(720, w - delta)))}
          />
          <GitSidebar
            workspace={{
              name:   workspace.name,
              path:   effectivePath,
              branch: git.state.branch || effectiveBranch,
              user:   git.state.user,
            }}
            state={git.state}
            width={gitWidth}
            {...git.handlers}
            onOpenFileDiff={onOpenGitFileDiff}
            onOpenTerminal={openTerminalForPath}
            pluginGitLenses={pluginGitLenses}
            onPluginGitLens={onPluginGitLens}
          />
        </>
      )}
    </div>
  )
}

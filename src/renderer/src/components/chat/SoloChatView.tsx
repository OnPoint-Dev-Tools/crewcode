import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChatHeader } from '../thread/ChatHeader'
import { Messages } from '../thread/Messages'
import { Composer } from '../composer/Composer'
import { MarkdownEditor } from '../editor/MarkdownEditor'
import { workspaceFilePathFromHref } from './workspace-link-targets'
import { ActiveSkillsStrip } from '../promptBuilder/ActiveSkillsStrip'
import { AgentActivityOverlay } from '../thread/AgentActivityOverlay'
import { CustodyHaltBanner } from './CustodyHaltBanner'
import { latestTodoActivity } from '../thread/todo-from-toolcall'
import { useIsDark } from '../../hooks/useIsDark'
import logoDark from '../../assets/icon-logo-dark.png'
import logoLight from '../../assets/icon-logo-light.png'
import type { AgentInfo, AgentUserRequest, AgentUserResponse, ChatAttachment, CustodyHaltPayload, GitHubStatus, Message, ToolCallMessage, Workspace } from '../../types'
import type { RegisteredPluginChatHeaderItem } from '../../../../shared/plugin-types'
import type { GitBranchRef, GitSidebarHandlers } from '../git/git-state'
import type { CustomCommand, Prompt, Skill } from '../../types/prompts'
import type { Mode } from '../composer/ModeSegment'
import type { EffortLevel } from '../composer/EffortPicker'
import type { McpServerConfig } from '../../hooks/useSettings'
import type { VoiceControlSurface } from '../../../../shared/voice-types'

type ThreadView = 'chat' | 'code' | 'md'

const THREAD_BOTTOM_THRESHOLD_PX = 72

function isThreadNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= THREAD_BOTTOM_THRESHOLD_PX
}

export interface SoloChatViewProps {
  workspace: Workspace
  effectivePath: string
  effectiveBranch: string
  worktreeBranch: string | null | undefined
  threadView: ThreadView
  setThreadView: (v: ThreadView) => void
  messages: Message[]
  /** Stable key for resetting scroll state when switching chat sessions. */
  sessionKey: string
  threadRef: React.RefObject<HTMLDivElement>
  density: string
  pendingGitDiff: { title: string; diff: string } | null
  setPendingGitDiff: (v: { title: string; diff: string } | null) => void
  // Header
  hideHeader?: boolean
  agentLabel: string
  modelLabel: string
  voiceControl?: VoiceControlSurface
  gitOpen: boolean
  setGitOpen: (open: boolean) => void
  github?: GitHubStatus | null
  dirtyCount?: number
  changesOpen: boolean
  changesCount: number
  toggleChangesOpen: () => void
  onStartCrew: () => void
  onOpenCanvas?: () => void
  onOpenTerminal?: () => void
  onHandoff?: () => void
  // Composer
  composerMode: Mode
  setComposerMode: (m: Mode) => void
  composer: string
  setComposer: React.Dispatch<React.SetStateAction<string>>
  onSend: () => void
  /** Fires a custom slash-command body immediately on pick. */
  onRunCommand?: (body: string) => void
  onQueueFollowUp?: () => void
  queuedFollowUps?: Array<{ id: string; text: string }>
  onRemoveQueuedFollowUp?: (followUpId: string) => void
  isRunning?: boolean
  loadingStatus?: string | null
  onStop?: () => void
  agentRequest?: AgentUserRequest | null
  /** A tripped execution-custody invariant: this thread refuses prompts until reauthorized. */
  custodyHalt?: CustodyHaltPayload | null
  onReauthorizeCustody?: () => void | Promise<void>
  onAgentRequestResponse?: (response: AgentUserResponse) => void | Promise<{ ok?: boolean; error?: string }>
  agents: AgentInfo[]
  activeAgentId: string
  setActiveAgentId: (id: string) => void
  model: string
  setModel: (m: string) => void
  effort: EffortLevel
  setEffort: (e: EffortLevel) => void
  // MCP — registry + this session's opt-in selection. Picker hidden when disabled.
  mcpEnabled?: boolean
  mcpServers?: McpServerConfig[]
  selectedMcpIds?: string[]
  onToggleMcp?: (id: string) => void
  shortcutOverrides: any
  /** Switch to the code view and reveal the given file in the editor. */
  onOpenFile?: (path: string) => void
  /** File to focus when the code view mounts (relative to workspace root). */
  editorInitialFile?: string | null
  /** Right-click on the thread area — used to open the chat context menu. */
  onThreadContextMenu?: (e: React.MouseEvent) => void
  /** Opens the global Prompt Picker — forwarded to Composer. */
  onOpenPrompts?: () => void
  onOpenBrowser?: (url?: string) => void
  delegationEnabled?: boolean
  onToggleDelegation?: () => void
  modePromptsEnabled?: boolean
  modePromptsLocked?: boolean
  onToggleModePrompts?: () => void
  pluginChatHeaderItems?: RegisteredPluginChatHeaderItem[]
  onPluginChatHeaderItem?: (target: { pluginId: string; sidebarPanel?: string; tab?: string; command?: string }) => void
  prompts?: Prompt[]
  skills?: Skill[]
  commands?: CustomCommand[]
  onInsertPromptBody?: (body: string, prompt?: Prompt) => void

  /** Skills currently enabled in the library — drives the visible "skills active" strip. */
  enabledSkills?: Skill[]
  /** Skill IDs already delivered as a system block to this session. */
  deliveredSkillIds?: string[]
  /** Toggle a skill's enabled flag (called by the × on a skill chip). */
  onToggleSkillEnabled?: (skillId: string) => void

  /** Optional copy for specialized chat surfaces such as Writer Workspace. */
  freshChat?: { kicker?: string; title: string; body: string; suggestions: string[] }

  /** Files attached to the composer — the parent reads these on send. */
  attachments?: ChatAttachment[]
  /** Mirror of `attachments` back to the parent so it can read the latest list at send time. */
  onAttachmentsChange?: (attachments: ChatAttachment[]) => void

  branchPicker?: {
    currentBranch: string
    branches: GitBranchRef[]
    handlers: Pick<GitSidebarHandlers, 'onCheckoutBranch' | 'onCreateBranch'>
    onRefresh?: () => void
  }
}

export function SoloChatView(props: SoloChatViewProps) {
  const freshChatLogo = useIsDark() ? logoDark : logoLight
  const {
    workspace, effectivePath, effectiveBranch, worktreeBranch,
    threadView, setThreadView, messages, sessionKey, threadRef, density,
    pendingGitDiff, setPendingGitDiff,
    hideHeader = false,
    agentLabel, modelLabel, voiceControl,
    gitOpen, setGitOpen, github, dirtyCount = 0, changesOpen, changesCount, toggleChangesOpen, onStartCrew, onOpenCanvas, onOpenTerminal, onHandoff,
    composerMode, setComposerMode, composer, setComposer, onSend, onRunCommand, onQueueFollowUp, queuedFollowUps = [], onRemoveQueuedFollowUp, isRunning, loadingStatus = null, onStop, agentRequest, custodyHalt, onReauthorizeCustody, onAgentRequestResponse,
    agents, activeAgentId, setActiveAgentId, model, setModel, effort, setEffort,
    mcpEnabled, mcpServers, selectedMcpIds, onToggleMcp,
    shortcutOverrides, onOpenFile, editorInitialFile, onThreadContextMenu, onOpenPrompts, onOpenBrowser,
    delegationEnabled, onToggleDelegation,
    modePromptsEnabled, modePromptsLocked, onToggleModePrompts,
    pluginChatHeaderItems = [], onPluginChatHeaderItem,
    prompts, skills, commands, onInsertPromptBody,
    enabledSkills, deliveredSkillIds, onToggleSkillEnabled,
    freshChat,
    attachments, onAttachmentsChange,
    branchPicker,
  } = props

  // Capture the thread scroll element as state so the virtualized message list
  // gets a non-null customScrollParent on the render it first needs it (a thread
  // can load already past the virtualization threshold from persistence).
  const [threadEl, setThreadEl] = useState<HTMLDivElement | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const pinnedToBottomRef = useRef(true)

  const setThreadNode = useCallback((el: HTMLDivElement | null) => {
    (threadRef as React.MutableRefObject<HTMLDivElement | null>).current = el
    setThreadEl(el)
  }, [threadRef])

  const updateBottomState = useCallback((el: HTMLElement | null = threadEl) => {
    if (!el) return
    const pinned = isThreadNearBottom(el)
    pinnedToBottomRef.current = pinned
    setShowScrollToBottom(!pinned)
  }, [threadEl])

  const scrollToThreadBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = threadRef.current ?? threadEl
    if (!el) return
    pinnedToBottomRef.current = true
    setShowScrollToBottom(false)
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [threadEl, threadRef])

  const onThreadScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    updateBottomState(event.currentTarget)
  }, [updateBottomState])

  useEffect(() => {
    pinnedToBottomRef.current = true
    setShowScrollToBottom(false)
    const frame = window.requestAnimationFrame(() => scrollToThreadBottom('auto'))
    return () => window.cancelAnimationFrame(frame)
  }, [scrollToThreadBottom, sessionKey, threadView])

  useEffect(() => {
    if (threadView !== 'chat') return
    // A synchronous layout effect read scrollHeight after every structural row
    // append, forcing the whole shell to reflow during React's commit. Follow in
    // the next frame instead so the drawer and workspace chrome can paint first.
    const frame = window.requestAnimationFrame(() => {
      if (pinnedToBottomRef.current) scrollToThreadBottom('auto')
      else updateBottomState()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [messages, scrollToThreadBottom, threadView, updateBottomState])

  const todoActivity = useMemo(() => latestTodoActivity(messages), [messages])
  const sentMessageHistory = useMemo(() => (
    messages
      .flatMap(message => {
        if (message.kind !== 'user' || message.speaker || message.text.trim().length === 0) return []
        return [message.text]
      })
      .reverse()
  ), [messages])

  const openThreadLink = useCallback((href: string) => {
    const filePath = workspaceFilePathFromHref(href, effectivePath)
    if (filePath && onOpenFile) {
      onOpenFile(filePath)
      return
    }
    onOpenBrowser?.(href)
  }, [effectivePath, onOpenBrowser, onOpenFile])
  const isFreshChat = threadView === 'chat' && messages.length === 0
  const suggestions = freshChat?.suggestions ?? [
    `Summarize ${workspace.name}`,
    'Find the next bug',
    'Plan a small refactor',
    'Explain the architecture',
  ]

  const composerNode = (
    <Composer
      repo={workspace.name}
      branch={branchPicker?.currentBranch ?? effectiveBranch}
      workspacePath={effectivePath}
      mode={composerMode}
      setMode={setComposerMode}
      value={composer}
      onChange={setComposer}
      onSend={onSend}
      onRunCommand={onRunCommand}
      onQueueFollowUp={onQueueFollowUp}
      queuedFollowUps={queuedFollowUps}
      onRemoveQueuedFollowUp={onRemoveQueuedFollowUp}
      sentMessageHistory={sentMessageHistory}
      isRunning={isRunning}
      onStop={onStop}
      voiceControl={voiceControl}
      dictationScopeId={sessionKey}
      agents={agents}
      activeAgentId={activeAgentId}
      onSelectAgent={setActiveAgentId}
      model={model}
      onSelectModel={setModel}
      effort={effort}
      onSelectEffort={setEffort}
      mcpEnabled={mcpEnabled}
      mcpServers={mcpServers}
      selectedMcpIds={selectedMcpIds}
      onToggleMcp={onToggleMcp}
      shortcutOverrides={shortcutOverrides}
      onOpenPrompts={onOpenPrompts}
      prompts={prompts}
      skills={skills}
      commands={commands}
      onInsertPromptBody={onInsertPromptBody}
      onToggleSkillEnabled={onToggleSkillEnabled}
      attachments={attachments}
      onAttachmentsChange={onAttachmentsChange}
      branchPicker={branchPicker ? {
        currentBranch: branchPicker.currentBranch,
        branches: branchPicker.branches,
        onCheckoutBranch: branchPicker.handlers.onCheckoutBranch,
        onCreateBranch: branchPicker.handlers.onCreateBranch,
        onRefresh: branchPicker.onRefresh,
      } : undefined}
    />
  )

  const headerNode = !hideHeader ? (
    <ChatHeader
      repo={workspace.name}
      branch={effectiveBranch}
      path={effectivePath}
      worktreeBranch={worktreeBranch ?? undefined}
      isGitRepo={workspace.kind !== 'folder'}
      agentLabel={agentLabel}
      modelLabel={modelLabel}
      voiceControl={voiceControl}
      view={threadView}
      setView={setThreadView}
      github={github}
      dirtyCount={dirtyCount}
      gitOpen={gitOpen}
      onToggleGit={() => setGitOpen(!gitOpen)}
      changesOpen={changesOpen}
      changesCount={changesCount}
      onToggleChanges={toggleChangesOpen}
      onStartCrew={onStartCrew}
      onOpenCanvas={onOpenCanvas}
      onOpenTerminal={onOpenTerminal}
      onOpenBrowser={onOpenBrowser}
      onHandoff={onHandoff}
      delegationEnabled={delegationEnabled}
      onToggleDelegation={onToggleDelegation}
      modePromptsEnabled={modePromptsEnabled}
      modePromptsLocked={modePromptsLocked}
      onToggleModePrompts={onToggleModePrompts}
      pluginChatHeaderItems={pluginChatHeaderItems}
      onPluginChatHeaderItem={onPluginChatHeaderItem}
    />
  ) : null

  if (isFreshChat) {
    return (
      <>
        {headerNode}
        <div className="fresh-chat" onContextMenu={onThreadContextMenu}>
          <div className="fresh-chat-main">
            <div className="fresh-chat-inner">
              <img className="fresh-chat-logo" src={freshChatLogo} alt="CrewCode" draggable={false} />
              <div className="fresh-chat-kicker">{freshChat?.kicker ?? effectiveBranch}</div>
              <h1>{freshChat?.title ?? `Ready to code in ${workspace.name}?`}</h1>
              <p>{freshChat?.body ?? 'Start a chat for this workspace.'}</p>
              <div className="fresh-chat-suggestions">
                {suggestions.map(text => (
                  <button key={text} type="button" onClick={() => setComposer(text)}>
                    <span className="fresh-chat-suggestion-dot" />
                    {text}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="fresh-chat-composer">{composerNode}</div>
        </div>
      </>
    )
  }

  return (
    <>
      {headerNode}
      <div className="thread-shell">
        <div className={`thread${threadView === 'md' ? ' markdown-editor-thread' : ''}`} ref={setThreadNode} onScroll={onThreadScroll} onContextMenu={onThreadContextMenu}>
          <div className={`thread-content density-${density}`}>
            {threadView === 'chat' && (
              messages.length === 0
                ? <div className="thread-empty">start typing below to begin a chat in <b>{workspace.name}</b></div>
                : <Messages messages={messages} workspacePath={effectivePath} isRunning={isRunning} loadingStatus={loadingStatus} onOpenFile={onOpenFile} onOpenLink={openThreadLink} scrollParent={threadEl} />
            )}
            {threadView === 'md' && <MarkdownEditor root={workspace.path} persistKey={sessionKey} />}
          </div>
        </div>
        {threadView === 'chat' && showScrollToBottom && messages.length > 0 && (
          <button type="button" className="thread-scroll-bottom" onClick={() => scrollToThreadBottom()}>
            Scroll to bottom
          </button>
        )}
      </div>
      {threadView === 'chat' && (
        <div className="composer-dock">
          {enabledSkills && enabledSkills.length > 0 && (
            <ActiveSkillsStrip
              enabledSkills={enabledSkills}
              deliveredIds={deliveredSkillIds ?? []}
              onToggleEnabled={(id) => onToggleSkillEnabled?.(id)}
            />
          )}
          {custodyHalt && onReauthorizeCustody && (
            <CustodyHaltBanner halt={custodyHalt} onReauthorize={onReauthorizeCustody} />
          )}
          {(agentRequest || todoActivity) && (
            <div className="composer-activity-shell">
              <AgentActivityOverlay
                todos={todoActivity?.todos ?? []}
                isStreaming={todoActivity?.isStreaming ?? !!agentRequest}
                request={agentRequest ?? undefined}
                onRespond={onAgentRequestResponse}
              />
            </div>
          )}
          {composerNode}
        </div>
      )}
    </>
  )
}

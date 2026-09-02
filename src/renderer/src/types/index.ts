import type {
  BrowserAwaitGrabSelectionArgs,
  BrowserAwaitGrabSelectionResult,
  BrowserCancelGrabArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverArgs,
  BrowserExtractHoverResult,
  BrowserSetGrabModeArgs,
} from '../../../shared/browser-grab-types'
import type { PluginApprovalResult, PluginAuditEntry, PluginCopyExampleResult, PluginInvokeRequest, PluginInvokeResult, PluginOpenContext, PluginRegistryChangedEvent, PluginRegistrySnapshot, PluginResolveTabResult, PluginSetEnabledResult } from '../../../shared/plugin-types'
import type { McpServerConfig, McpFileSnapshot } from '../../../shared/mcp-types'
import type { AgentCompletionRequest, AgentCompletionResult } from '../../../shared/agent-completion-types'
import type { LanguageServerMessageEvent, LanguageServerStartResult, LanguageServerStatusEvent } from '../../../shared/language-server-types'
import type { WriterBinaryFormat, WriterDocumentExportResult, WriterDocumentImportResult } from '../../../shared/writer-document-types'
import type { AppBuildInfo, UpdaterConfig, UpdaterEvent } from '../../../shared/updater-types'
import type { DelegatedMergeOutcome, DelegationCredentials, DelegationRendererRequest, DelegationResult } from '../../../shared/delegation-types'
import type { CustodyHaltPayload, CustodyViolation } from '../../../shared/custody-types'
import type { GitHubCommandResponse, GitHubMergeMethod, GitHubPullRequestCreateContext, GitHubPullRequestCreateOptions, GitHubPullRequestDetail, GitHubPullRequestReviewOptions } from '../../../shared/github-types'

export type { CustodyHaltPayload, CustodyInvariantId, CustodyViolation } from '../../../shared/custody-types'

export type AgentProviderId = 'pi' | 'opencode' | 'codex' | 'claude' | 'hermes' | 'crewcoder' | 'grok' | 'ollama' | 'openrouter' | `plugin:${string}`

export type { CrewCodePluginManifest, InstalledPlugin, PluginRegistryError, PluginRegistrySnapshot } from '../../../shared/plugin-types'

export interface CrewIntegrationLane { laneId: string; label: string; branch: string; head: string; worktreePath: string; files: string[] }
export interface CrewIntegrationCheckExecution { token: string; pid?: number; pidFile?: string; state: 'running' | 'exited' | 'unknown'; checkedAt?: number; detail?: string }
export interface CrewIntegrationCheck { id: string; label: string; command: string; script: string; status: 'running' | 'passed' | 'failed' | 'interrupted'; output: string; execution?: CrewIntegrationCheckExecution }
export interface CrewIntegrationRecord {
  id: string
  sessionId: string
  repoPath: string
  baseBranch: string
  baseHead: string
  lanes: CrewIntegrationLane[]
  retentionRef: string
  integrationHead?: string
  conflictLaneId?: string
  conflictBranch?: string
  conflicts?: string[]
  phase: 'preflight' | 'combining' | 'checking' | 'ready' | 'applying' | 'complete'
  status: 'running' | 'passed' | 'failed' | 'conflict' | 'interrupted' | 'applied' | 'stale'
  checks: CrewIntegrationCheck[]
  startedAt: number
  updatedAt: number
  finishedAt?: number
  error?: string
}
export interface CrewIntegrationRequest {
  sessionId: string
  repoPath: string
  baseBranch: string
  baseHead: string
  lanes: CrewIntegrationLane[]
}

// ─── Tab ────────────────────────────────────────────────────────────────────

export type BuiltinTabKind = 'chat' | 'crew' | 'canvas' | 'git' | 'code' | 'writer' | 'terminal' | 'browser' | 'settings' | 'plugins' | 'prompts' | 'mission' | 'archive'
export type TabKind = BuiltinTabKind | 'plugin'

export type BrowserSessionMode = 'isolated' | 'shared'

export interface Tab {
  id:         string
  kind:       TabKind
  label:      string
  live?:      boolean
  contextId?: string    // workspace ID or worktree ID (overrides active workspace)
  pinned?:    boolean
  color?:     string
  url?:       string    // initial URL for browser tabs
  browserSessionMode?: BrowserSessionMode
  splitCloneOf?: string // split-pane clones stay grouped with their source tab
  /** Owner chat/writer tab for a session viewport used in window splits. */
  sessionOwnerTabId?: string
  /** Session shown by a viewport tab; does not steal the owner's active session. */
  pinnedSessionId?: string
  pluginId?: string
  pluginTabId?: string
  pluginRegistrationId?: string
  pluginEntry?: string
  pluginIcon?: string
  pluginSingleton?: boolean
  pluginOpenContext?: PluginOpenContext
}

export const TAB_COLOR_PALETTE = [
  { id: 'red',    value: '#ef4444', label: 'Red' },
  { id: 'orange', value: '#f97316', label: 'Orange' },
  { id: 'yellow', value: '#eab308', label: 'Yellow' },
  { id: 'green',  value: '#22c55e', label: 'Green' },
  { id: 'blue',   value: '#3b82f6', label: 'Blue' },
  { id: 'purple', value: '#a855f7', label: 'Purple' },
  { id: 'pink',   value: '#ec4899', label: 'Pink' },
  { id: 'none',   value: '',        label: 'None' },
] as const

export type TabColorId = typeof TAB_COLOR_PALETTE[number]['id']

// ─── Message ─────────────────────────────────────────────────────────────────

export type MessageBlock = ['t', string] | ['c', string]

export interface ChatAttachment {
  rel: string
  name: string
  mimeType?: string
}

export interface UserMessage {
  kind: 'user'
  text: string
  time: string
  attachments?: ChatAttachment[]
  /**
   * Group-chat attribution. Set when the turn comes from a crew worker relayed
   * into the Supervisor thread — renders as a labeled incoming bubble instead of
   * the local "you" bubble. Absent for the user's own messages.
   */
  speaker?: string
}

/**
 * Token accounting for one completed turn (mirrors main's bridge TurnUsage).
 * Every field is optional — providers report different subsets and the UI only
 * renders what's present.
 */
export interface CompactionStatus {
  used?: number
  limit?: number
  percent?: number
  threshold?: number
  state?: 'unknown' | 'safe' | 'warning' | 'critical' | 'compacting' | 'compacted'
  metric?: 'tokens' | 'messages' | 'bytes' | 'provider-specific'
  providerLabel?: string
  reason?: string
}

export interface ContextCategory {
  name:      string
  tokens:    number
  deferred?: boolean
}

export interface TurnUsage {
  inputTokens?:   number
  outputTokens?:  number
  totalTokens?:   number
  contextTokens?: number
  contextWindow?: number
  model?:         string
  compaction?:    CompactionStatus
  contextBreakdown?: ContextCategory[]
}

export interface AgentMessage {
  kind:       'agent'
  time:       string
  blocks:     MessageBlock[]
  text?:      string          // accumulating raw text for streaming bridges
  /** Readable chronological stream chunks; coalesced from token deltas for live rendering. */
  chunks?:    string[]
  turnId?:    string          // turn this bubble belongs to
  processId?: string
  streaming?: boolean
  durationMs?: number         // elapsed time of the turn in milliseconds
  /** Token usage for the turn — drives the tok/s + context strip on the bubble. */
  usage?:     TurnUsage
  /** Mode that was active when the turn started — drives Plan-mode rendering affordances. */
  mode?:      ModeLevel
}

export interface ThinkingMessage {
  kind:      'thinking'
  time:      string
  turnId:    string
  /** Distinguishes multiple reasoning blocks inside one turn. */
  segmentId?: string
  text:      string
  /** Readable chronological stream chunks; coalesced from token deltas for live rendering. */
  chunks?:   string[]
  streaming: boolean
}

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'error'

/**
 * Snapshot of a single file edited inside a turn — `before` is captured at
 * `tool_start`, `after` at `tool_end`. `patch` is a unified diff suitable for
 * rendering with PierreDiff.
 */
export interface TurnFileChange {
  path:       string
  beforeText: string
  afterText:  string
  patch:      string
}

export interface ToolCallMessage {
  kind:        'toolcall'
  time:        string
  turnId:      string
  toolCallId:  string
  toolName:    string
  args:        unknown
  status:      ToolCallStatus
  result?:     unknown
  isError?:    boolean
  /** Latest metadata payload received via `tool_update` (preview/diff/output/etc.). */
  metadata?:   Record<string, unknown>
  /** Latest title hint from the bridge (opencode populates this per tool). */
  title?:      string
  /** Set for file-editing tool calls once before/after have both been captured. */
  fileChange?:  TurnFileChange
  /** All files touched by this tool call. Single-file tools mirror `fileChange`. */
  fileChanges?: TurnFileChange[]
}

export type CrewCodeActivityStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'interrupted'

/**
 * CrewCode-owned execution lifecycle for one user turn. This is distinct from
 * provider tool telemetry: it records only states CrewCode directly observed.
 */
export interface CrewCodeActivityMessage {
  kind:          'activity'
  time:          string
  activityRunId: string
  runtimeId:     string
  text:          string
  status:        CrewCodeActivityStatus
  activeForm?:   string
  turnId?:       string
}

export interface WorkLogMessage {
  kind: 'worklog'
  count: number
  command: string
  time: string
}

export interface SystemMessage {
  kind: 'system'
  time: string
  text: string
  tone?: 'info' | 'error'
}

export interface CompactionMessage {
  kind: 'compaction'
  time: string
  bridgeId: string
  status: 'started' | 'completed' | 'failed' | 'detected'
  automatic: boolean
  message: string
  percent?: number
  provider?: string
}

export interface HandoffMessage {
  kind: 'handoff'
  id: string
  time: string
  status: 'started' | 'completed' | 'failed'
  message: string
  fromProvider?: string
  toProvider?: string
  percent?: number
}

export interface HandoffSummaryMessage {
  kind: 'handoff_summary'
  time: string
  summary: string
  fromProvider?: string
  toProvider?: string
  reason?: 'handoff' | 'compact'
}

export interface HandoffPromptOptions {
  fromProvider?: string
  toProvider?:   string
  model?:        string
  mode?:         ModeLevel
  workspace?: {
    name?:   string
    path?:   string
    branch?: string
  }
}

export interface ChatPromptOptions {
  // One follow-up behavior: deliver into the running turn at the next safe point.
  // pi-bridge maps this to pi's 'steer'; Claude buffers until its turn ends.
  streamingBehavior?: 'followUp'
  handoff?: HandoffPromptOptions
}

export type Message =
  | UserMessage
  | AgentMessage
  | ThinkingMessage
  | ToolCallMessage
  | CrewCodeActivityMessage
  | WorkLogMessage
  | SystemMessage
  | CompactionMessage
  | HandoffMessage
  | HandoffSummaryMessage

// ─── Bridge events (renderer side) ───────────────────────────────────────────

export interface AgentUserRequest {
  requestId: string
  bridgeId: string
  turnId?: string
  kind: 'permission' | 'prompt' | 'select' | 'editor' | 'notification'
  title: string
  message?: string
  detail?: string
  options?: Array<{ id: string; label: string; description?: string }>
  placeholder?: string
  defaultValue?: string
  dangerous?: boolean
  source?: string
  /** Main-issued capability for Build-mode permission requests. */
  allowAllForTurn?: boolean
}

export interface AgentUserResponse {
  requestId: string
  action: 'accept' | 'accept_for_turn' | 'decline' | 'submit' | 'cancel'
  value?: string
  optionId?: string
}

export type BridgeEvent =
  | { type: 'ready';          bridgeId: string }
  | { type: 'status';         bridgeId: string; message: string; phase?: 'starting' | 'resuming' | 'replaying_history' | 'handoff' }
  | { type: 'session_id';     bridgeId: string; sessionId: string; resumed: boolean }
  | { type: 'turn_start';     bridgeId: string; turnId: string }
  | { type: 'text_delta';     bridgeId: string; turnId: string; delta: string }
  | { type: 'thinking_delta'; bridgeId: string; turnId: string; delta: string }
  | { type: 'history_user';   bridgeId: string; text: string }
  | { type: 'history_agent';  bridgeId: string; turnId: string; text: string }
  | { type: 'history_thinking'; bridgeId: string; turnId: string; text: string }
  | { type: 'tool_start';     bridgeId: string; turnId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_update';    bridgeId: string; turnId: string; toolCallId: string; partial: unknown; args?: unknown; title?: string }
  | { type: 'tool_end';       bridgeId: string; turnId: string; toolCallId: string; result: unknown; isError: boolean; args?: unknown; title?: string }
  | { type: 'usage_update';   bridgeId: string; turnId: string; usage: TurnUsage }
  | { type: 'turn_end';       bridgeId: string; turnId: string; usage?: TurnUsage }
  | { type: 'compaction_event'; bridgeId: string; turnId?: string; status: 'started' | 'completed' | 'failed' | 'detected'; automatic: boolean; message?: string; beforeTokens?: number; afterTokens?: number; percent?: number; provider?: string; resetContext?: boolean }
  | { type: 'handoff_summary'; bridgeId: string; summary: string; fromProvider?: string; toProvider?: string; reason?: 'handoff' | 'compact' }
  | { type: 'user_request';   request: AgentUserRequest }
  | { type: 'user_request_resolved'; bridgeId: string; requestId: string }
  // Follow-up queue visibility from bridges that hold prompts locally while a
  // turn runs (claude). 'sent' = drained into a turn, 'removed' = user cancel,
  // 'cleared' = abort/stop dropped the whole queue.
  | { type: 'follow_up_queued';  bridgeId: string; followUpId: string; text: string }
  | { type: 'follow_up_removed'; bridgeId: string; followUpId: string; reason: 'sent' | 'removed' | 'cleared' }
  | { type: 'error';          bridgeId: string; message: string }
  | { type: 'closed';         bridgeId: string; code: number | null }
  // Idle sweep stopped a long-idle bridge to free its process; the renderer
  // forgets the bridge silently and resumes it on the next prompt.
  | { type: 'idle_stopped';   bridgeId: string }
  // An execution-custody invariant tripped: the thread refuses privileged
  // actions until the user explicitly reauthorizes. See shared/custody-types.
  | { type: 'custody_halt';    bridgeId: string; halt: CustodyHaltPayload }
  | { type: 'custody_cleared'; bridgeId: string; scopeKey: string }
  // An authority mutation was refused mid-turn and deferred to the next turn.
  | { type: 'custody_deferred'; bridgeId: string; message: string }

// ─── Session ─────────────────────────────────────────────────────────────────

// Canonical union lives in shared/ so main's bridge/delegation code and the
// renderer can't drift; re-exported here to keep every existing import working.
export type { ModeLevel } from '../../../shared/mode-types'
import type { ModeLevel } from '../../../shared/mode-types'

export interface Session {
  id:      string
  tabId:   string
  label:   string
  agentId: string
  model:   string
  mode:    ModeLevel
  /** CrewCoder agent profile; independent from CrewCode execution permissions. */
  crewcoderMode?: import('../../../shared/crewcoder-types').CrewCoderMode
  /** CrewCoder-native approval policy; defaults to review for older sessions. */
  crewcoderApprovalMode?: import('../../../shared/crewcoder-types').CrewCoderApprovalMode
  effort:  'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
  // Ids of MCP servers (from Settings → MCP) this session opts into. Empty by
  // default — MCP is never auto-attached. May be absent on sessions persisted
  // before MCP shipped, so read with `?? []`.
  mcpServerIds: string[]
  // Skill activation is chat-scoped. Definitions are shared library content,
  // but enabling one must never affect another solo session.
  enabledSkillIds: string[]
  // Whether CrewCode injects the selected mode's advisory prompt when this
  // session first sends. Provider-native permission policy is independent.
  modePromptsEnabled?: boolean
  // One-shot branch provisioning request captured from Settings when a new chat
  // is created. App clears it after selecting/creating the matching worktree.
  initialBranch?: string
  // Local roots granted to this session in addition to its workspace.
  externalDirectories?: string[]
  // Pinned sessions sort before unpinned peers in their existing drawer group.
  // Optional for sessions persisted before thread pinning shipped.
  pinned?: boolean
  // Wall-clock ms when the chat was first created and when it was last used.
  // Optional only for sessions persisted before chat timestamps shipped; the
  // session hook backfills those from transcript metadata on first launch.
  createdAt?: number
  lastUsedAt?: number
  // Browser-only transcript recovery fallback. These rows are never persisted
  // back into the Brain catalogue unless the user actually continues them.
  continuityRecovered?: true
  // Archived sessions are hidden from the normal session list (and from every
  // derived surface: completed chats, recency, agent status) but keep their
  // transcript on disk. Absent on sessions persisted before archiving shipped.
  archived?: boolean
  // Wall-clock ms the session was archived — the clock the retention policy
  // measures against. Backfilled to "first seen" for sessions archived before
  // this field existed, so enabling retention can never retroactively expire
  // history that was archived at an unknown time.
  archivedAt?: number
  // ─── Delegation ──────────────────────────────────────────────────────────
  // Per-chat opt-in: when true this session's agent receives delegation API
  // credentials and may spawn threads. Off by default and absent on existing
  // sessions, so an unrelated chat pays neither the token nor the preamble.
  delegationEnabled?: boolean
  // Set when an agent created this thread through the local delegation API.
  // Absent on every session created by a human, so `origin === 'delegated'` is
  // the only positive test — never infer delegation from the other fields.
  // Provenance is history, not current ownership: continuing a delegated thread
  // yourself does not clear these.
  origin?: 'delegated'
  // Session id of the thread whose agent spawned this one.
  delegatedBy?: string
  delegatedAt?: number
  // Only for `isolation: 'worktree'` children (write-capable modes). Read-only
  // children share the parent's worktree and carry none of these.
  delegatedWorktreePath?: string
  delegatedBranch?: string
  // Commit the child forked from, and the ref its work merges back onto.
  delegationBase?: string
  // Cohort this thread belongs to: every thread spawned since the parent's last
  // user message shares one id. Lets a fan-out report as a group ("3 of 5 done")
  // instead of as N unrelated pings. Absent on threads spawned before cohorts.
  delegationRunId?: string
  // The thread was spawned during an AUTONOMOUS parent turn (one that a report
  // started), not one the user drove. This is the recursive case the wake budget
  // bounds — a wide fan-out from a user-driven turn is free however large.
  delegatedDuringWake?: boolean
  // Wall-clock ms the delegating agent called `close` on this thread. It marks
  // the thread DONE — it frees a concurrency slot and dims the drawer row — and
  // deliberately does NOT archive: only the user decides when a thread is
  // finished with. Cleared if the thread is given more work.
  delegationClosedAt?: number
}

// ─── Workspace ───────────────────────────────────────────────────────────────

export type WorkspaceStatus = 'ready' | 'live' | 'plan' | 'idle' | 'error'
export type WorkspaceKind   = 'repo' | 'folder' | 'remote'

export interface Worktree {
  id:     string
  path:   string
  branch: string
  head:   string
  locked: boolean
  dirty:  number
}

export interface GitHubPR {
  number: number
  title:  string
  state:  'OPEN' | 'CLOSED' | 'MERGED'
  branch: string
  base?:  string
  url:    string
  isDraft?: boolean
  author?: string
  updatedAt?: string
  body?: string
  mergeStateStatus?: string
  reviewDecision?: string | null
}

export interface GitHubRun {
  id:         number
  name:       string
  status:     'queued' | 'in_progress' | 'completed'
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null
  branch:     string
}

export interface GitHubStatus {
  owner:  string
  repo:   string
  prs:    GitHubPR[]
  runs:   GitHubRun[]
  issues: number
}

export interface RemoteInfo {
  host:  string
  user?: string
  port?: number
}

export interface Workspace {
  id:        string
  name:      string
  path:      string            // local abs path, or an ssh:// URI when kind === 'remote'
  branch:    string | null
  dirty:     number
  status:    WorkspaceStatus
  kind:      WorkspaceKind
  pinned:    boolean
  folder:    string | null
  remote?:   RemoteInfo | null
  agents:    string[]
  updated:   string
  projectIconDataUrl?: string | null
  worktrees: Worktree[]
  github:    GitHubStatus | null
}

// ─── Filesystem ──────────────────────────────────────────────────────────────

export interface FsNode {
  name: string
  path: string
  rel:  string
  kind: 'dir' | 'file'
  size?: number
}

// ─── Git ─────────────────────────────────────────────────────────────────────

export interface GitStatusFile {
  path:   string
  status: string   // M, A, D, R, ?, etc.
  staged: boolean
}

export interface GitCommit {
  hash:      string
  shortHash: string
  author:    string
  date:      string
  message:   string
}

export interface GitBranch {
  name:    string
  current: boolean
}

export interface GitStatus {
  branch:   string
  ahead:    number
  behind:   number
  hasUpstream: boolean
  staged:   GitStatusFile[]
  unstaged: GitStatusFile[]
  untracked: GitStatusFile[]
}

// ─── Command palette ─────────────────────────────────────────────────────────

export interface Command {
  id: string
  label: string
  icon: string
  hint: string
  kbd: string
  group: string
}

export interface CommandGroup {
  group: string
  items: Omit<Command, 'group'>[]
}

// ─── Tweaks ──────────────────────────────────────────────────────────────────

export interface TweakConfig {
  density: 'compact' | 'regular'
  drawerHeight: number
  drawerWidth: number
  drawerPosition: 'bottom' | 'left' | 'right'
  showTerminal: boolean
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export interface AgentInfo {
  id:           string
  name:         string
  cmd?:         string             // default binary name (e.g. 'claude', 'codex')
  path:         string | null      // effective resolved path (override OR default)
  defaultPath?: string | null      // auto-detected path, ignoring override
  available:    boolean
  transport:    'pty' | 'bridge'
  source?:       'builtin' | 'plugin'
  pluginId?:     string
  description?:  string
  // Hosted providers (e.g. OpenRouter): need an API key, and whether one is set.
  requiresApiKey?: boolean
  hasKey?:         boolean
}

// ─── Pty pane (live terminal pane in the UI) ─────────────────────────────────

export interface PtyPane {
  paneId:  string
  wsId:    string
  tabId:   string            // owning tab — isolates chat panel panes from terminal tab panes
  agentId: string | null     // null = plain shell
  title:   string
  sub:     string
  cwd:     string
  live:    boolean
  // Overrides for the spawn. SSH panes set shell='ssh' + argv=[target] so
  // the pty wraps the remote session instead of a local shell.
  shell?:  string
  argv?:   string[]
}

// ─── Electron API ────────────────────────────────────────────────────────────

export interface PtyCreateOpts {
  paneId: string
  cwd?:   string
  cols?:  number
  rows?:  number
  shell?: string
  argv?:  string[]
  env?:   Record<string, string>
  /** YuHeard metadata. Mirrors the main-side `PtyCreateOpts` extras. */
  agentId?: string | null
  autoWrap?: boolean
  wrapAgentIds?: string[]
  /** When false, this pane is a chat/crew sidecar and must not join YuHeard. */
  yuheard?: boolean
}

export interface PtyDataEvent { paneId: string; data: string }
export interface PtyExitEvent { paneId: string; exitCode: number; signal?: number }

export interface StoredWorkspace {
  id:      string
  name:    string
  path:    string
  kind:    WorkspaceKind
  pinned:  boolean
  folder:  string | null
  remote?: RemoteInfo | null
  addedAt: number
  branch:  string | null
  dirty:   number
  status:  WorkspaceStatus
  agents:  string[]
  updated: string
  projectIconDataUrl?: string | null
}

export interface RemoteDirEntry {
  name: string
  kind: 'dir' | 'file'
}

export {}
declare global {
  interface Window {
    electronAPI?: {
      minimize: () => void
      maximize: () => void
      close:    () => void
      trayConfigure?: (enabled: boolean) => Promise<{ ok: boolean }>
      setUiZoom: (percent: number) => void

      agentRegistry:   () => Promise<AgentInfo[]>
      agentListModels: (provider: string) => Promise<{ id: string; label: string; provider: string; contextWindow?: number }[]>
      agentSetPath:    (id: string, path: string | null) => Promise<{ ok: boolean; error?: string; registry?: AgentInfo[]; resolved?: string | null }>
      agentGetKey:     (id: string) => Promise<{ key: string | null }>
      agentSetKey:     (id: string, key: string | null) => Promise<{ ok: boolean; error?: string; registry?: AgentInfo[] }>
      agentCompletion: (request: AgentCompletionRequest) => Promise<AgentCompletionResult>
      agentCompletionCancel: (requestId: string) => void

      // Realtime voice. Permanent provider keys never cross this boundary.
      voiceProviderAvailability: () => Promise<import('../../../shared/voice-types').VoiceProviderAvailabilityMap>
      voiceSetProviderKey: (
        provider: import('../../../shared/voice-types').RemoteVoiceProviderId,
        key: string | null,
      ) => Promise<{
        ok: boolean
        error?: string
        availability?: import('../../../shared/voice-types').VoiceProviderAvailabilityMap
      }>
      voiceCreateClientSecret: (
        request: import('../../../shared/voice-types').VoiceClientSecretRequest,
      ) => Promise<import('../../../shared/voice-types').VoiceClientSecretResult>
      voiceTranscribe: (
        request: import('../../../shared/voice-types').VoiceTranscriptionRequest,
      ) => Promise<import('../../../shared/voice-types').VoiceTranscriptionResult>
      voiceSynthesize: (
        request: import('../../../shared/voice-types').VoiceSpeechRequest,
      ) => Promise<import('../../../shared/voice-types').VoiceSpeechResult>
      voiceLocalStart: (
        request: import('../../../shared/voice-types').LocalVoiceStartRequest,
      ) => Promise<import('../../../shared/voice-types').LocalVoiceServiceStatus>
      voiceLocalPrewarm: (
        request: import('../../../shared/voice-types').LocalVoiceStartRequest,
        capability: import('../../../shared/voice-types').LocalVoiceWarmupCapability,
      ) => Promise<import('../../../shared/voice-types').LocalVoiceServiceStatus>
      voiceLocalStatus: () => Promise<import('../../../shared/voice-types').LocalVoiceServiceStatus>
      voiceLocalTranscribe: (audio: Uint8Array) => Promise<import('../../../shared/voice-types').LocalVoiceTranscriptionResult>
      voiceLocalSynthesize: (
        text: string,
        voice: string,
        speed?: number,
      ) => Promise<import('../../../shared/voice-types').LocalVoiceSpeechResult>

      // Shell detection
      shellsDetect: () => Promise<{ bash: string | null; zsh: string | null; fish: string | null; defaultShell: string }>

      // PTY
      ptyCreate: (opts: PtyCreateOpts) => Promise<{ ok?: boolean; error?: string; pid?: number; cwd?: string; shell?: string; attached?: boolean; buffer?: string }>
      ptyWrite:  (paneId: string, data: string) => void
      ptyResize: (paneId: string, cols: number, rows: number) => void
      ptyKill:   (paneId: string) => void
      onPtyData: (cb: (data: PtyDataEvent) => void) => () => void
      onPtyDataForPane: (paneId: string, cb: (data: string) => void) => () => void
      onPtyExit: (cb: (data: PtyExitEvent) => void) => () => void

      // Agent bridge (pi, opencode)
      bridgeStart: (opts: {
        bridgeId:    string
        provider:    AgentProviderId
        cwd:         string
        externalDirectories?: string[]
        model?:      string
        mode?:       'ask' | 'plan' | 'build' | 'full'
        crewcoderMode?: import('../../../shared/crewcoder-types').CrewCoderMode
        crewcoderApprovalMode?: import('../../../shared/crewcoder-types').CrewCoderApprovalMode
        toolPolicy?: 'default' | 'read-only'
        thinking?:   'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
        apiKey?:     string
        env?:        Record<string, string>
        sessionKey?: string
        conversationScopeKey?: string
        freshSession?: boolean
        mcpServers?: McpServerConfig[]
        suppressProviderHistoryReplay?: boolean
        // A start refused because an execution-custody halt is still in force
        // for the thread returns the halt alongside the error, so the caller
        // can surface the banner without relying on event routing.
      }) => Promise<{ ok?: boolean; error?: string; custodyHalt?: CustodyHaltPayload }>
      bridgePrompt: (bridgeId: string, text: string, options?: ChatPromptOptions) => Promise<{ ok: boolean; error?: string }>
      bridgeCompact: (bridgeId: string) => Promise<{ ok: boolean; error?: string; unsupported?: boolean }>
      bridgeHandoff: (bridgeId: string, sourceConversationKey: string, options: HandoffPromptOptions) => Promise<{ ok: boolean; error?: string }>
      bridgeRemoveFollowUp: (bridgeId: string, followUpId: string) => Promise<{ ok: boolean; error?: string }>
      bridgeRespondUserRequest: (response: AgentUserResponse) => Promise<{ ok?: boolean; error?: string }>
      bridgeSetMode: (bridgeId: string, mode: ModeLevel) => void
      // Execution custody — explicit reauthorization after a tripped invariant,
      // plus the read-only record behind the halt banner.
      bridgeReauthorize: (args: { bridgeId?: string; scopeKey?: string }) => Promise<{ ok: boolean; error?: string; cleared?: number }>
      bridgeCustodyState: (args: { sessionKey?: string | null; bridgeId?: string }) => Promise<{
        ok: boolean
        scopeKey: string
        halt: CustodyViolation | null
        record: { interruptedPrompt?: string; interruptedPartial?: string } | null
      }>
      bridgeAbort:  (bridgeId: string) => void
      bridgeStop:   (bridgeId: string) => void
      bridgeResetSession: (sessionKey: string, conversationScopeKey?: string) => Promise<{ ok?: boolean; error?: string }>
      onBridgeEvent: (cb: (event: BridgeEvent) => void) => () => void

      // Delegation — main marshals local delegation API calls into the renderer,
      // which answers by correlation id.
      onDelegationRequest: (cb: (request: DelegationRendererRequest & { id: string }) => void) => () => void
      delegationRespond: (id: string, result: DelegationResult<unknown>) => void
      delegationEnable: (sessionId: string, policy: {
        allowFullAccess: boolean
        parentMode: ModeLevel
        maxConcurrent: number
        remote: boolean
      }) => Promise<{ ok: boolean; error?: string; credentials?: DelegationCredentials }>
      delegationDisable: (sessionId: string) => Promise<{ ok: boolean }>

      // Workspaces
      workspacesList:       () => Promise<StoredWorkspace[]>
      workspacesAdd:        (path: string) => Promise<{ ok?: boolean; error?: string; workspace?: StoredWorkspace }>
      workspacesRemove:     (id: string)   => Promise<{ ok?: boolean; error?: string }>
      workspacesPin:        (id: string, pinned: boolean) => Promise<{ ok?: boolean; error?: string }>
      workspacesRename:     (id: string, name: string)    => Promise<{ ok?: boolean; error?: string }>
      workspacesSetFolder:  (id: string, folder: string | null) => Promise<{ ok?: boolean; error?: string }>
      workspacesPickFolder: () => Promise<{ ok?: boolean; canceled?: boolean; path?: string }>
      pickExternalDirectory: () => Promise<{ ok?: boolean; canceled?: boolean; path?: string }>
      workspacesCloneRepo:   (url: string, parentDir: string, folderName?: string) => Promise<{ ok?: boolean; path?: string; error?: string }>
      workspacesInitProject: (parentDir: string, folderName: string, asGit: boolean) => Promise<{ ok?: boolean; path?: string; error?: string }>
      workspacesAddRemote:   (opts: { host: string; user?: string; port?: number; path: string; name?: string }) => Promise<{ ok?: boolean; error?: string; workspace?: StoredWorkspace }>

      // Chat transcripts (authoritative on-disk store)
      transcriptsLoadAll: () => Promise<Record<string, Message[]>>
      transcriptsLoad:   (scopeId: string) => Promise<Message[]>
      transcriptsCatalogue?: () => Promise<import('../../../shared/continuity-state-types').ContinuityTranscriptEntry[]>
      transcriptsMtimes:  () => Promise<Record<string, number>>
      transcriptsSave:    (scopeId: string, messages: Message[]) => Promise<{ ok?: boolean; error?: string }>
      transcriptsRemove:  (scopeId: string) => Promise<{ ok?: boolean; error?: string }>
      transcriptsSaveSyncBatch: (entries: { scopeId: string; messages: Message[] }[]) => boolean

      // FS
      fsReadDir:   (root: string, sub?: string)               => Promise<{ nodes?: FsNode[]; error?: string }>
      fsListFiles: (root: string)                             => Promise<{ files?: string[]; error?: string }>
      fsReadFile:  (root: string, sub: string)                => Promise<{ ok?: boolean; text?: string; name?: string; size?: number; error?: string }>
      fsReadDataUrl: (root: string, sub: string)              => Promise<{ ok?: boolean; dataUrl?: string; name?: string; size?: number; mimeType?: string; error?: string }>
      fsWriteFile: (root: string, sub: string, text: string)  => Promise<{ ok?: boolean; error?: string }>
      fsMkdir:     (root: string, sub: string)                => Promise<{ ok?: boolean; error?: string }>
      fsFormat:    (root: string, sub: string, text: string)  => Promise<{ ok?: boolean; text?: string; error?: string }>
      fsDelete:    (root: string, sub: string)                => Promise<{ ok?: boolean; error?: string }>
      fsRename:    (root: string, sub: string, newName: string) => Promise<{ ok?: boolean; rel?: string; error?: string }>
      fsCopyFile:  (root: string, sub: string, destDirRel?: string) => Promise<{ ok?: boolean; rel?: string; error?: string }>
      fsMove:      (root: string, srcRel: string, destDirRel: string) => Promise<{ ok?: boolean; rel?: string; error?: string }>
      writerDocumentsImport: (root: string, sourceRel: string) => Promise<WriterDocumentImportResult>
      writerDocumentsExport: (root: string, sourceRel: string, markdown: string, format: WriterBinaryFormat) => Promise<WriterDocumentExportResult>

      // Editor live-reload (watch open files for on-disk changes)
      editorWatchAdd:    (root: string, rel: string) => void
      editorWatchRemove: (root: string, rel: string) => void
      onEditorFileChanged: (cb: (event: { root: string; rel: string }) => void) => () => void

      // TypeScript/JavaScript language server
      editorLanguageServerStart: (root: string) => Promise<LanguageServerStartResult>
      editorLanguageServerSend: (handleId: string, message: string) => void
      editorLanguageServerStop: (handleId: string) => void
      onEditorLanguageServerMessage: (cb: (event: LanguageServerMessageEvent) => void) => () => void
      onEditorLanguageServerStatus: (cb: (event: LanguageServerStatusEvent) => void) => () => void

      // File attachments
      attachmentsPick:   () => Promise<{ canceled: boolean; filePaths: string[] }>
      attachmentsImport: (root: string, items: Array<{ name: string; data: ArrayBuffer | Uint8Array }>) =>
        Promise<{ rels?: string[]; error?: string }>

      // Git worktrees
      worktreeList:   (repoPath: string) => Promise<{ worktrees?: Worktree[]; error?: string }>
      worktreeCreate: (repoPath: string, branch: string, worktreePath?: string, startPoint?: string) => Promise<{ ok?: boolean; path?: string; error?: string }>
      worktreeRemove: (worktreePath: string) => Promise<{ ok?: boolean; error?: string }>

      // Shell
      openExternal: (url: string) => Promise<{ ok?: boolean }>
      openInEditor: (path: string) => Promise<{ ok?: boolean; error?: string; via?: string }>

      // Keybindings file (~/.crewcode/keys.json), keyed by action id
      keybindsRead:  () => Promise<{ ok: boolean; data?: Record<string, string[]> | null; error?: string }>
      keybindsWrite: (data: Record<string, string[]>) => Promise<{ ok: boolean; error?: string }>
      keybindsOpen:  (seed: Record<string, string[]>) => Promise<{ ok: boolean; path?: string; error?: string }>
      onKeybindsChanged: (cb: (event: { ok: boolean; data?: Record<string, string[]> | null }) => void) => () => void
      notify: (payload: { title: string; body: string; scopeId?: string; silent?: boolean }) => Promise<{ ok: boolean; error?: string }>
      onNotificationClick: (cb: (event: { scopeId: string }) => void) => () => void

      // YuHeard terminal agent alerts
      yuheardStatus: () => Promise<{ socket: string | null; running: boolean }>
      onYuheardState: (cb: (event: { paneId: string; state: 'running' | 'complete'; message: string | null; source: string; at: number }) => void) => () => void
      clipboardWriteText: (text: string) => Promise<{ ok: boolean; error?: string }>
      clipboardReadText: () => Promise<{ ok: boolean; text?: string; error?: string }>
      clipboardWriteImageDataUrl: (dataUrl: string) => Promise<{ ok: boolean; error?: string }>

      // Browser tools
      browserSetGrabMode: (args: BrowserSetGrabModeArgs) => Promise<{ ok: boolean; error?: string }>
      browserAwaitGrabSelection: (args: BrowserAwaitGrabSelectionArgs) => Promise<BrowserAwaitGrabSelectionResult>
      browserCancelGrab: (args: BrowserCancelGrabArgs) => Promise<{ ok: boolean; error?: string }>
      browserCaptureSelectionScreenshot: (args: BrowserCaptureSelectionScreenshotArgs) => Promise<BrowserCaptureSelectionScreenshotResult>
      browserExtractHover: (args: BrowserExtractHoverArgs) => Promise<BrowserExtractHoverResult>

      // GitHub
      githubStatus:   (repoPath: string) => Promise<GitHubStatus | { error: string }>
      githubPrCreateContext: (repoPath: string, base: string) => Promise<GitHubPullRequestCreateContext | { error: string }>
      githubPrDetail: (repoPath: string, num: number) => Promise<GitHubPullRequestDetail | { error: string }>
      githubPrDiff: (repoPath: string, num: number) => Promise<{ ok: boolean; patch: string; error?: string }>

      // Git
      gitStatus:   (cwd: string) => Promise<GitStatus & { ok?: boolean; error?: string }>
      gitStage:    (cwd: string, paths: string[]) => Promise<{ ok?: boolean; error?: string }>
      gitStageAll: (cwd: string) => Promise<{ ok?: boolean; error?: string }>
      gitUnstage:  (cwd: string, paths: string[]) => Promise<{ ok?: boolean; error?: string }>
      gitDiscard:  (cwd: string, path: string) => Promise<{ ok?: boolean; error?: string }>
      gitDiff:     (cwd: string, path: string, staged: boolean) => Promise<{ ok?: boolean; diff?: string; error?: string }>
      gitChangesVsRef: (cwd: string, ref: string) => Promise<{ ok?: boolean; files?: GitStatusFile[]; error?: string }>
      gitDiffVsRef: (cwd: string, ref: string, path: string) => Promise<{ ok?: boolean; diff?: string; error?: string }>
      gitCommit:   (cwd: string, message: string, amend?: boolean, noSign?: boolean) => Promise<{ ok?: boolean; output?: string; error?: string; signingFailure?: boolean }>
      gitCommitWithPassphrase: (cwd: string, message: string, amend: boolean | undefined, passphrase: string) => Promise<{ ok?: boolean; output?: string; error?: string; signingFailure?: boolean }>
      gitPush:     (cwd: string) => Promise<{ ok?: boolean; output?: string; error?: string }>
      gitPushWithCredentials: (cwd: string, username: string, password: string) => Promise<{ ok?: boolean; output?: string; error?: string }>
      gitPull:     (cwd: string) => Promise<{ ok?: boolean; output?: string; error?: string }>
      gitFetch:    (cwd: string) => Promise<{ ok?: boolean; error?: string }>
      gitLog:      (cwd: string, limit?: number) => Promise<{ ok?: boolean; commits?: GitCommit[]; error?: string }>
      gitBranches: (cwd: string) => Promise<{ ok?: boolean; branches?: GitBranch[]; error?: string }>
      gitCheckout: (cwd: string, branch: string) => Promise<{ ok?: boolean; error?: string }>
      gitCreateBranch:    (cwd: string, name: string) => Promise<{ ok?: boolean; error?: string }>
      gitMerge:           (cwd: string, ref: string) => Promise<{ ok?: boolean; conflicts?: boolean; output?: string; error?: string }>
      gitSuggestedCrewChecks: (cwd: string) => Promise<{ ok?: boolean; checks?: { id: 'typecheck' | 'test'; label: string; command: string; args: string[]; script: string }[]; error?: string }>
      gitRunSuggestedCrewCheck: (cwd: string, id: string) => Promise<{ ok?: boolean; output?: string; error?: string }>
      gitCrewIntegrationStatus: (sessionId: string) => Promise<{ ok?: boolean; record?: CrewIntegrationRecord | null; error?: string }>
      gitVerifyCrewIntegration: (request: CrewIntegrationRequest) => Promise<{ ok?: boolean; status?: string; record?: CrewIntegrationRecord | null; error?: string }>
      gitApplyCrewIntegration: (sessionId: string) => Promise<{ ok?: boolean; record?: CrewIntegrationRecord | null; error?: string }>
      gitMergeDelegated: (request: { worktreePath: string; repoPath: string; branch: string; base: string }) => Promise<DelegatedMergeOutcome>
      gitDiffDelegated: (worktreePath: string, base: string, branch: string) => Promise<{ ok?: boolean; stat?: string; patch?: string; error?: string }>
      gitMergeAbort:      (cwd: string) => Promise<{ ok?: boolean; error?: string }>
      gitMergeContinue:   (cwd: string) => Promise<{ ok?: boolean; output?: string; error?: string }>
      gitResolveConflict: (cwd: string, file: string, strategy: string) => Promise<{ ok?: boolean; error?: string }>
      gitRemotes:         (cwd: string) => Promise<{ ok?: boolean; isRepo?: boolean; remotes?: string[]; remoteUrls?: string[]; error?: string }>
      gitInit:            (cwd: string) => Promise<{ ok?: boolean; error?: string }>

      // Auto-updater
      appBuildInfo:          () => Promise<AppBuildInfo>
      brainDesktopStatus: (probeHub?: boolean) => Promise<import('../../../shared/brain-desktop-types').BrainDesktopStatus>
      brainDesktopSetEnabled: (enabled: boolean) => Promise<import('../../../shared/brain-desktop-types').BrainDesktopStatus>
      brainDesktopStop: () => Promise<import('../../../shared/brain-desktop-types').BrainDesktopStatus>
      brainDesktopStopAndQuit: () => Promise<{ ok: boolean }>
      brainDesktopRpc: <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>
      brainDesktopUploadAttachment: (root: string, name: string, body: Uint8Array) => Promise<{ rel?: string; error?: string }>
      onBrainDesktopEvent: (cb: (event: unknown) => void) => () => void
      continuityStateGet: () => Promise<import('../../../shared/continuity-state-types').ContinuityStateSnapshot>
      continuityStateUpdate: (values: Record<string, string>) => Promise<import('../../../shared/continuity-state-types').ContinuityStateSnapshot>
      continuityDesktopSeed?: (values: Record<string, string>) => Promise<import('../../../shared/continuity-state-types').ContinuityStateSnapshot>
      appHomePath:           () => Promise<string>
      updaterCheck:          () => Promise<{ ok: boolean; version?: string | null; error?: string }>
      updaterDownload:       () => Promise<{ ok: boolean; error?: string }>
      updaterQuitAndInstall: () => Promise<{ ok: boolean; error?: string }>
      updaterConfigure:      (config: UpdaterConfig) => Promise<{ ok: boolean }>
      onUpdaterEvent: (cb: (event: UpdaterEvent) => void) => () => void

      // gh CLI auth
      ghStatus:      () => Promise<GhStatus>
      ghLoginStart:  () => Promise<{ ok: boolean; error?: string }>
      ghLoginCancel: () => Promise<{ ok: boolean }>
      ghLogout:      () => Promise<{ ok: boolean; error?: string }>
      ghPrCreate:    (cwd: string, options: GitHubPullRequestCreateOptions) => Promise<GitHubCommandResponse>
      ghPrMerge:     (cwd: string, num: number, method: GitHubMergeMethod) => Promise<GitHubCommandResponse>
      ghPrApprove:   (cwd: string, num: number) => Promise<GitHubCommandResponse>
      ghPrUpdateBranch: (cwd: string, num: number) => Promise<GitHubCommandResponse>
      ghPrComment:   (cwd: string, num: number, body: string) => Promise<GitHubCommandResponse>
      ghPrClose:     (cwd: string, num: number) => Promise<GitHubCommandResponse>
      ghPrReview:    (cwd: string, num: number, options: GitHubPullRequestReviewOptions) => Promise<GitHubCommandResponse>
      ghRepoCreate:  (cwd: string, opts: { name: string; visibility: 'private' | 'public'; description?: string }) => Promise<{ ok: boolean; output: string; error?: string }>
      onGhAuthEvent: (cb: (event: GhAuthEvent) => void) => () => void

      // SSH config + keys
      sshListConfig: () => Promise<SshConfigHost[]>
      sshListKeys:   () => Promise<SshKeyFile[]>
      sshAddKey:     (path: string, passphrase?: string) => Promise<{ ok: boolean; error?: string; needsPassphrase?: boolean }>
      sshRemoveKey:  (path: string) => Promise<{ ok: boolean; error?: string }>
      sshOpenConfig: () => Promise<{ ok: boolean; error?: string }>
      sshTest:       (target: string) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>

      // Remote (SSH) workspaces
      sshRemoteHome:       (spec: RemoteInfo) => Promise<{ ok?: boolean; path?: string; error?: string }>
      sshListRemoteDir:    (spec: RemoteInfo, path: string) => Promise<{ ok?: boolean; path?: string; parent?: string | null; entries?: RemoteDirEntry[]; error?: string }>
      sshConnectRemote:    (spec: RemoteInfo, path: string) => Promise<{ ok: boolean; error?: string }>
      sshDisconnectRemote: (connId: string) => Promise<{ ok: boolean }>
      onRemoteStatus:      (cb: (event: { connId: string; status: string; error: string | null }) => void) => () => void

      // Custom slash-commands / home CrewCode config
      crewcodeConfigDir: () => Promise<{ ok: boolean; path?: string; error?: string }>
      commandsOpenDir:   () => Promise<{ ok: boolean; path?: string; error?: string }>

      // MCP file registry (~/.crewcode/mcp.json)
      mcpList:     () => Promise<McpFileSnapshot>
      mcpOpenFile: () => Promise<{ ok: boolean; path?: string; error?: string }>
      onMcpChanged: (cb: (event: McpFileSnapshot & { at: number }) => void) => () => void

      // Local plugins
      pluginsList:       () => Promise<PluginRegistrySnapshot>
      pluginsWatch:      () => Promise<{ ok: boolean; registry: PluginRegistrySnapshot; error?: string }>
      pluginsRefresh:    () => Promise<PluginRegistrySnapshot>
      pluginsCopyExample:(exampleId?: string) => Promise<PluginCopyExampleResult>
      pluginsInspectGit: (request: import('../../../shared/plugin-types').PluginGitInspectRequest) => Promise<import('../../../shared/plugin-types').PluginGitInspectResult>
      pluginsInstallGit: (token: string) => Promise<import('../../../shared/plugin-types').PluginGitInstallResult>
      pluginsResolveTab: (registrationId: string) => Promise<PluginResolveTabResult>
      pluginsInvoke:     (request: PluginInvokeRequest) => Promise<PluginInvokeResult>
      pluginsAudit:      () => Promise<PluginAuditEntry[]>
      pluginsSetApproval:(pluginId: string, approved: boolean) => Promise<PluginApprovalResult>
      pluginsSetEnabled: (pluginId: string, enabled: boolean) => Promise<PluginSetEnabledResult>
      pluginsOpenDir:    () => Promise<{ ok: boolean; path?: string; error?: string }>
      pluginsOpenPluginDir:(pluginId: string) => Promise<{ ok: boolean; path?: string; error?: string }>
      pluginsOpenManifest:(pluginId: string) => Promise<{ ok: boolean; path?: string; error?: string }>
      pluginsRecordRuntimeError:(pluginId: string, registrationId: string, message: string) => Promise<{ ok: boolean }>
      onPluginsChanged:  (cb: (event: PluginRegistryChangedEvent) => void) => () => void

      // System monitor
      systemStats:      () => Promise<SystemStatsSnapshot>
      systemProcesses:  () => Promise<SystemProcessesSnapshot>
      systemStopDaemon: (bridgeId: string) => Promise<{ ok: boolean }>

      // Rate limits
      rateLimits: {
        get: () => Promise<import('../../../shared/rate-limit-types').RateLimitState>
        refresh: () => Promise<import('../../../shared/rate-limit-types').RateLimitState>
        setPollingInterval: (ms: number) => Promise<void>
        onUpdate: (cb: (state: import('../../../shared/rate-limit-types').RateLimitState) => void) => () => void
      }
    }
  }
}

// ─── System monitor shapes ───────────────────────────────────────────────────

export interface SystemStatsSnapshot {
  cpuPercent:   number    // CrewCode combined CPU load; >100% = more than one core busy
  cores:        number
  memTotal:     number    // physical RAM, bytes
  appMemBytes:  number    // CrewCode's own resident memory, bytes
  uptime:       number
  platform:     string
  bridgeCount:  number
  ptyProcCount: number
}

export interface ProcessSample {
  kind:        'bridge' | 'pty'
  id:          string             // bridgeId or paneId
  pid:         number
  cpu:         number             // % (100 = one full core); summed over the process tree
  memBytes:    number             // resident memory summed over the process tree
  provider?:   string
  sessionKey?: string | null      // "tabId:agentId"
  startedAt?:  number
}

export interface SystemProcessesSnapshot {
  appCpu:          number
  appMemBytes:     number
  processes:       ProcessSample[]
  combinedCpu:     number    // app + every tracked process
  trackedMemBytes: number    // app + every tracked process
}

// ─── Updater / gh / ssh shapes ───────────────────────────────────────────────

// Single source of truth lives in shared/ so main and renderer cannot drift.
export type { AppBuildInfo, UpdaterChannel, UpdaterConfig, UpdaterEvent } from '../../../shared/updater-types'

export interface GhStatus {
  available: boolean
  loggedIn:  boolean
  user:      string | null
  host:      string | null
  raw:       string
  error?:    string
}

export interface GhAuthEvent {
  type:  'code' | 'url' | 'success' | 'failure' | 'cancelled' | 'output'
  code?: string
  url?:  string
  text?: string
  error?: string
}

export interface SshConfigHost {
  host:        string
  hostname?:   string
  user?:       string
  port?:       string
  identityFile?: string
}

export interface SshKeyFile {
  name:    string
  path:    string
  type:    string
  loaded:  boolean
  fingerprint?: string
  comment?:     string
}

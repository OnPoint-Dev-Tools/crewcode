// Normalized event stream shared by all agent providers.
// Each provider (pi, opencode, claude/code-stream) maps its native events to these.

import type { McpServerConfig } from '../../shared/mcp-types'
import type { CustodyHaltPayload } from '../../shared/custody-types'
export type { McpServerConfig } from '../../shared/mcp-types'
export type { CustodyHaltPayload } from '../../shared/custody-types'
// Re-exported (not redeclared) so main and the renderer share one union.
import type { ModeLevel } from '../../shared/mode-types'
import type { CrewCoderMode } from '../../shared/crewcoder-types'

/**
 * Token accounting for one completed turn. Providers report different subsets,
 * so every field is optional — the UI only renders what's present. `contextTokens`
 * is the running size of the model's context (input already includes the full
 * history), used against `contextWindow` to compute a usage percentage.
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

// One slice of the context window (system prompt, tools, MCP, memory files,
// messages, …). Only providers that report a breakdown populate it (claude via
// getContextUsage); the UI shows it so "what's using my context" is inspectable.
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
  /** Main-issued capability: this Build permission can grant the remaining turn. */
  allowAllForTurn?: boolean
}

export interface AgentUserResponse {
  requestId: string
  action: 'accept' | 'accept_for_turn' | 'decline' | 'submit' | 'cancel'
  value?: string
  optionId?: string
}

export type RequestUserFn = (request: Omit<AgentUserRequest, 'requestId' | 'bridgeId'>) => Promise<AgentUserResponse>

export type BridgeEvent =
  | { type: 'ready';            bridgeId: string }
  | { type: 'status';           bridgeId: string; message: string; phase?: 'starting' | 'resuming' | 'replaying_history' | 'handoff' }
  | { type: 'session_id';       bridgeId: string; sessionId: string; resumed: boolean }
  | { type: 'turn_start';       bridgeId: string; turnId: string }
  | { type: 'text_delta';       bridgeId: string; turnId: string; delta: string }
  | { type: 'thinking_delta';   bridgeId: string; turnId: string; delta: string }
  // Non-streaming history replay from providers that send transcript chunks on resume.
  | { type: 'history_user';     bridgeId: string; text: string }
  | { type: 'history_agent';    bridgeId: string; turnId: string; text: string }
  | { type: 'history_thinking'; bridgeId: string; turnId: string; text: string }
  | { type: 'tool_start';       bridgeId: string; turnId: string; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_update';      bridgeId: string; turnId: string; toolCallId: string; partial: unknown; args?: unknown; title?: string }
  | { type: 'tool_end';         bridgeId: string; turnId: string; toolCallId: string; result: unknown; isError: boolean; args?: unknown; title?: string }
  | { type: 'usage_update';     bridgeId: string; turnId: string; usage: TurnUsage }
  | { type: 'turn_end';         bridgeId: string; turnId: string; usage?: TurnUsage }
  | { type: 'compaction_event'; bridgeId: string; turnId?: string; status: 'started' | 'completed' | 'failed' | 'detected'; automatic: boolean; message?: string; beforeTokens?: number; afterTokens?: number; percent?: number; provider?: string; resetContext?: boolean }
  | { type: 'handoff_summary'; bridgeId: string; summary: string; fromProvider?: string; toProvider?: string; reason?: 'handoff' | 'compact' }
  | { type: 'user_request';     request: AgentUserRequest }
  | { type: 'user_request_resolved'; bridgeId: string; requestId: string }
  // Follow-up queue visibility: bridges that hold prompts locally while a turn
  // is running (claude) report queue changes so the composer can show/cancel
  // pending messages. `reason` distinguishes drain ('sent'), user cancel
  // ('removed'), and abort/stop ('cleared').
  | { type: 'follow_up_queued';  bridgeId: string; followUpId: string; text: string }
  | { type: 'follow_up_removed'; bridgeId: string; followUpId: string; reason: 'sent' | 'removed' | 'cleared' }
  | { type: 'error';            bridgeId: string; message: string }
  | { type: 'closed';           bridgeId: string; code: number | null }
  // Emitted when the idle sweep stops a long-idle bridge to free its process
  // memory. Distinct from 'closed' so the renderer cleans up silently (no "agent
  // exited" notice) — the thread resumes on the next prompt via the saved id.
  | { type: 'idle_stopped';     bridgeId: string }
  // An execution-custody invariant tripped. Privileged actions on this thread
  // are refused until the user explicitly reauthorizes. Never inferred away.
  | { type: 'custody_halt';     bridgeId: string; halt: CustodyHaltPayload }
  // The user reauthorized the thread; the banner clears and prompts resume.
  | { type: 'custody_cleared';  bridgeId: string; scopeKey: string }
  // An authority mutation was refused while a turn was in flight and will apply
  // at the next turn instead. Not a violation — the deferral IS the enforcement.
  | { type: 'custody_deferred'; bridgeId: string; message: string }

export type EffortLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export type { ModeLevel } from '../../shared/mode-types'
export type BridgeToolPolicy = 'default' | 'read-only'

export type AgentProviderId = 'pi' | 'opencode' | 'codex' | 'claude' | 'hermes' | 'crewcoder' | 'grok' | 'ollama' | 'openrouter' | `plugin:${string}`

// Bridge providers that talk to an HTTP server instead of a spawned CLI, so
// bridge:start must NOT require a resolved binary path for them.
export const HTTP_ONLY_PROVIDERS = new Set<string>(['ollama', 'openrouter'])

// HTTP providers that require a stored API key (injected by main at start).
export const API_KEY_PROVIDERS = new Set<string>(['openrouter'])

export interface BridgeStartOpts {
  bridgeId:  string
  provider:  AgentProviderId
  cwd:       string
  // Session-scoped local roots explicitly granted in addition to cwd.
  externalDirectories?: string[]
  model?:    string                  // optional model id
  mode?:     ModeLevel
  // CrewCoder's agent profile, passed as `crewcoder acp --mode`. This is not
  // CrewCode's Ask/Plan/Build/Full execution-permission mode above.
  crewcoderMode?: CrewCoderMode
  // CrewCoder's native tool-approval policy. Older clients omit it and receive
  // the fail-closed interactive review default.
  crewcoderApprovalMode?: import('../../shared/crewcoder-types').CrewCoderApprovalMode
  // Supervisor and other constrained bridge roles can force read-only tools
  // without relying on a chat-mode prompt to behave correctly.
  toolPolicy?: BridgeToolPolicy
  thinking?: EffortLevel             // provider-native reasoning effort
  apiKey?:   string
  env?:      Record<string, string>
  // Upstream session id to resume. If the provider supports resume and the id
  // is still valid, the bridge picks up where the previous run left off and
  // emits a 'session_id' event with resumed=true. If resume fails (id stale,
  // server forgot it, provider doesn't support it), the bridge falls back to
  // creating a fresh session and emits 'session_id' with resumed=false.
  resumeSessionId?: string
  // Handoffs intentionally start a fresh native provider session and seed it
  // from CrewCode's summary instead of resuming stale provider-owned context.
  freshSession?: boolean
  // Suppress provider-emitted resume transcript events when CrewCode already
  // has the richer local UI history (thinking/tool cards/original ordering).
  suppressProviderHistoryReplay?: boolean
  // Stable CrewCode thread key for local transcript fallback. Stateless
  // providers use it as their canonical history store; stateful providers use
  // it if their native resume id goes stale after a restart.
  conversationKey?: string
  // MCP servers the session opted into. Providers that accept MCP at session
  // creation (ACP/hermes/CrewCoder) attach these; others ignore them for now.
  mcpServers?: McpServerConfig[]
  // One-shot operations such as editor completion must not load or persist a
  // conversation, even for stateless HTTP providers.
  ephemeral?: boolean
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

export interface PromptOptions {
  // One follow-up behavior: deliver into the running turn at the next safe point.
  // pi-bridge maps this to pi's 'steer'; Claude buffers until its turn ends.
  streamingBehavior?: 'followUp'
  handoff?: HandoffPromptOptions
}

export interface AgentBridge {
  readonly bridgeId: string
  // PID of the spawned provider process — surfaced by the system monitor so it
  // can sample the bridge's per-process CPU/memory. null if the spawn has no pid.
  readonly pid: number | null
  prompt(text: string, options?: PromptOptions): Promise<{ ok: boolean; error?: string }>
  compact?(): Promise<{
    ok: boolean
    error?: string
    unsupported?: boolean
    // Native compactors may return the authoritative replacement context.
    // This stays behind the main/Brain boundary; callers project it into the
    // local replay shard and visible handoff-summary event.
    summary?: string
    compacted?: boolean
  }>
  // Cancel a locally queued follow-up before it is sent. Only bridges that
  // queue follow-ups themselves (claude) implement this; providers that queue
  // upstream (pi) cannot un-send and leave it undefined.
  removeFollowUp?(followUpId: string): Promise<{ ok: boolean; error?: string }>
  abort():  Promise<void>
  stop():   Promise<void>
}

export type EmitFn = (event: BridgeEvent) => void

import { promises as fsp } from 'fs'
import { isAbsolute, posix, resolve as pathResolve } from 'path'
import { remoteReadFile, remoteWriteFile } from '../remote/remote-fs'
import { spawnAgentProcess } from './agent-spawn'
import { toAcpMcpServer } from '../../shared/mcp-types'
import { InactivityWatchdog } from './crewcoder-bridge'
import type {
  AgentBridge,
  AgentUserResponse,
  BridgeEvent,
  BridgeStartOpts,
  EffortLevel,
  EmitFn,
  PromptOptions,
  RequestUserFn,
  TurnUsage,
} from './bridge-types'
import { buildUsage } from './model-context'
import { enrichUsageContextWindow } from './openrouter-model-context'

// Grok Build via ACP (Agent Client Protocol) — newline-delimited JSON-RPC 2.0
// over stdio. CrewCode is the client and spawns `grok agent stdio`.
//
// Grok speaks standard ACP (initialize / session/new / session/prompt /
// session/update / session/request_permission / fs/*) but carries several
// things CrewCode needs on a vendor-private notification channel instead:
// `_x.ai/session_notification`. Token usage in particular arrives ONLY there,
// as a `response_completed` update — a by-the-book ACP client sees no usage at
// all and renders a dead context meter. Both channels must be consumed.

type JsonRpcId = number | string

interface AcpResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface AcpRequestIn {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

interface AcpContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

export interface GrokSessionUpdate {
  sessionUpdate: string
  content?: AcpContentBlock | unknown[]
  toolCallId?: string
  title?: string
  name?: string
  kind?: string
  status?: string
  rawInput?: unknown
  rawOutput?: unknown
  [key: string]: unknown
}

interface PendingRequest {
  resolve: (response: AcpResponse) => void
  reject: (error: Error) => void
  stopTimeout: () => void
  timedOut: boolean
}

export const GROK_PROMPT_INACTIVITY_TIMEOUT_MS = 10 * 60_000
const STDERR_DEDUPE_WINDOW_MS = 30_000
const GROK_PROMPT_CANCELLATION_GRACE_MS = 10_000

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function contentText(content: GrokSessionUpdate['content']): string {
  if (!content || Array.isArray(content)) return ''
  return typeof content.text === 'string' ? content.text : ''
}

function toolContent(content: GrokSessionUpdate['content']): unknown {
  if (!Array.isArray(content)) return undefined
  const text = content
    .map(item => {
      const row = record(item)
      const nested = record(row?.content)
      return typeof nested?.text === 'string' ? nested.text : ''
    })
    .filter(Boolean)
    .join('\n')
  return text || content
}

/**
 * Grok's ACP `kind` is a coarse category (`edit`, `read`), while the real tool
 * name lives in the vendor `_meta['x.ai/tool']` block. Prefer the specific name
 * so work-log rows and the read-only tool gate both see `write`, not `edit`.
 */
export function grokToolMeta(update: GrokSessionUpdate): { name: string; readOnly?: boolean } {
  const meta = record(update._meta)
  const tool = record(meta?.['x.ai/tool'])
  const name = typeof tool?.name === 'string' && tool.name.trim()
    ? tool.name.trim()
    : typeof update.title === 'string' && update.title.trim()
      ? update.title.trim()
      : typeof update.kind === 'string' ? update.kind : 'tool'
  return { name, readOnly: typeof tool?.read_only === 'boolean' ? tool.read_only : undefined }
}

// ---------------------------------------------------------------------------
// Permission policy
// ---------------------------------------------------------------------------

/**
 * Grok resolves its permission mode from `~/.grok/config.toml`, project
 * `.grok/config.toml`, and Claude-compatible `.claude/settings.json`. A user
 * with `permission_mode = "always-approve"` gets a Grok session that never asks
 * the client at all and just runs tools — silently voiding CrewCode's Ask, Plan,
 * and Build modes. Passing the flag explicitly overrides config for the spawned
 * process, which is what guarantees a `session/request_permission` reaches the
 * bridge for anything CrewCode has to police.
 *
 * Measured, not assumed: `dontAsk` still *prompts* for a client-side write
 * rather than auto-denying it, so read-only enforcement cannot rest on the mode
 * alone. CrewCode refuses the permission request and the `fs/write_text_file`
 * call itself; the mode's job here is only to stop Grok self-approving.
 */
export function grokPermissionMode(opts: Pick<BridgeStartOpts, 'mode' | 'toolPolicy'>): string {
  // A constrained role (supervisor, completion) outranks the composer mode.
  if (opts.toolPolicy === 'read-only') return 'dontAsk'
  if (opts.mode === 'ask' || opts.mode === 'plan') return 'dontAsk'
  if (opts.mode === 'full') return 'bypassPermissions'
  return 'default'
}

/**
 * Grok exposes low/medium/high only. CrewCode's wider enum is clamped rather
 * than passed through: Grok rejects an unknown value for the whole process, so
 * a silent clamp beats a bridge that dies at spawn. There is no "off" — the
 * lowest Grok setting is `low`.
 */
export function grokReasoningEffort(effort: EffortLevel | undefined): string | undefined {
  if (!effort) return undefined
  if (effort === 'off' || effort === 'low') return 'low'
  if (effort === 'medium') return 'medium'
  return 'high'
}

export function grokSpawnArgs(opts: Pick<BridgeStartOpts, 'mode' | 'toolPolicy' | 'model' | 'thinking'>): string[] {
  // `--permission-mode` is a top-level flag and must precede the `agent`
  // subcommand; `agent stdio` itself accepts none of these.
  const args = ['--permission-mode', grokPermissionMode(opts)]
  if (opts.model?.trim()) args.push('--model', opts.model.trim())
  const effort = grokReasoningEffort(opts.thinking)
  if (effort) args.push('--effort', effort)
  args.push('agent', 'stdio')
  return args
}

function writeBlocked(opts: Pick<BridgeStartOpts, 'mode' | 'toolPolicy'>): boolean {
  return opts.toolPolicy === 'read-only' || opts.mode === 'ask' || opts.mode === 'plan'
}

const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'apply_patch', 'bash', 'shell', 'execute', 'run', 'run_terminal_cmd'])

/**
 * Bridge-level tool gate, independent of Grok's own permission mode. Grok's
 * `read_only` flag is trusted when present and the name check is the fallback,
 * so a renamed or unknown mutating tool still fails closed in a read-only mode.
 */
export function grokToolBlocked(
  opts: Pick<BridgeStartOpts, 'mode' | 'toolPolicy'>,
  tool: { name: string; readOnly?: boolean },
): boolean {
  if (!writeBlocked(opts)) return false
  if (tool.readOnly === true) return false
  if (tool.readOnly === false) return true
  const lower = tool.name.toLowerCase()
  return WRITE_TOOL_NAMES.has(lower)
    || lower.includes('write')
    || lower.includes('edit')
    || lower.includes('bash')
    || lower.includes('shell')
    || lower.includes('terminal')
}

/**
 * Grok offers `allow-edits-session` ("allow all edits during this session"),
 * which outlives the turn and would let a remembered agent decision survive a
 * later composer-mode change. Only once-only choices are surfaced; CrewCode's
 * own turn-scoped grant store owns "allow all for this turn".
 * Filtering is by ACP `kind`, not id, because the ids are vendor spellings.
 */
export function grokPermissionOptions(params: Record<string, unknown>): Array<{ id: string; label: string; description?: string }> {
  const options = Array.isArray(params.options) ? params.options : []
  const mapped = options.flatMap((option, index) => {
    const row = record(option)
    if (!row) return []
    const id = typeof row.optionId === 'string'
      ? row.optionId
      : typeof row.id === 'string' ? row.id : String(index)
    const kind = typeof row.kind === 'string' ? row.kind : ''
    if (kind !== 'allow_once' && kind !== 'reject_once') return []
    return [{
      id,
      kind,
      label: typeof row.name === 'string' ? row.name : typeof row.label === 'string' ? row.label : id,
      description: typeof row.description === 'string' ? row.description : undefined,
    }]
  })
  if (mapped.length === 0) return [
    { id: 'allow-once', label: 'Allow' },
    { id: 'reject-once', label: 'Reject' },
  ]
  return mapped.map(({ id, label, description }) => ({ id, label, description }))
}

/** Resolve the option id Grok expects for an allow/reject decision. */
export function grokSelectedOption(
  response: AgentUserResponse,
  params: Record<string, unknown>,
  options: Array<{ id: string }>,
): string | null {
  if (response.action === 'cancel' || response.action === 'decline') return null
  const requested = response.optionId
  if (requested && options.some(option => option.id === requested)) return requested
  const raw = Array.isArray(params.options) ? params.options : []
  const byKind = raw.flatMap(option => {
    const row = record(option)
    return row && row.kind === 'allow_once' && typeof row.optionId === 'string' ? [row.optionId] : []
  })
  return byKind[0] ?? options[0]?.id ?? 'allow-once'
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Per-turn usage rides on the `session/prompt` response `_meta`. `inputTokens`
 * there is the last model call's input, i.e. live context occupancy — the same
 * mapping CrewCoder uses for `lastInputTokens`. The sibling `usage` object is
 * cumulative across the turn's model calls and must NOT be read as context, or
 * a two-call turn reports double the real occupancy.
 */
export function grokUsageFromPromptResult(
  result: unknown,
  model?: string,
  contextWindow?: number,
): TurnUsage | undefined {
  const meta = record(record(result)?._meta)
  if (!meta) return undefined
  const cumulative = record(meta.usage)
  const inputTokens = finiteNumber(meta.inputTokens) ?? finiteNumber(cumulative?.inputTokens)
  const outputTokens = finiteNumber(meta.outputTokens) ?? finiteNumber(cumulative?.outputTokens)
  const usage = buildUsage({
    inputTokens,
    outputTokens,
    contextTokens: finiteNumber(meta.totalTokens) ?? inputTokens,
    contextWindow,
    model: typeof meta.modelId === 'string' ? meta.modelId : model,
  })
  if (!usage) return undefined
  const explicitTotal = finiteNumber(cumulative?.totalTokens)
  return explicitTotal === undefined ? usage : { ...usage, totalTokens: explicitTotal }
}

/** Context window for the active model, read off initialize/session-new `_meta`. */
export function grokContextWindow(meta: unknown, model?: string): number | undefined {
  const modelState = record(record(meta)?.modelState) ?? record(record(meta)?.models)
  const available = modelState?.availableModels
  if (!Array.isArray(available)) return undefined
  const wanted = model?.trim() || (typeof modelState?.currentModelId === 'string' ? modelState.currentModelId : undefined)
  const match = available.find(entry => record(entry)?.modelId === wanted) ?? available[0]
  return finiteNumber(record(record(match)?._meta)?.totalContextTokens)
}

/**
 * Grok puts the useless half of a failure in `error.message` and the entire
 * actionable half in `error.data`. A rate limit arrives as
 * `{ code: -32003, message: 'Rate limited', data: "API error (status 429 ...):
 * subscription:free-usage-exhausted: You've used all the included free usage
 * for model grok-4.5 ... Upgrade ..." }`. Reporting only `message` tells the
 * user "Rate limited" with no quota, no reset window, and no link.
 */
export function grokRequestErrorMessage(
  method: string,
  error: { message?: string; data?: unknown },
): string {
  const summary = error.message?.trim() || 'request failed'
  const detail = typeof error.data === 'string'
    ? error.data.trim()
    : error.data === undefined || error.data === null
      ? ''
      : JSON.stringify(error.data)
  if (!detail || detail === summary) return `${method}: ${summary}`
  // Grok's data often already restates the summary; don't say it twice.
  if (detail.toLowerCase().includes(summary.toLowerCase())) return `${method}: ${detail}`
  return `${method}: ${summary} — ${detail}`
}

// Grok's stderr is tracing-formatted: ANSI colour codes, an RFC3339 timestamp,
// then a level. Emitting it raw puts escape sequences in the chat, and it
// repeats the same failure once per retry attempt.
const ANSI_PATTERN = /\[[0-9;]*m/g
const TRACING_PREFIX = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+/

export function grokStderrMessage(raw: string): string | null {
  const line = raw.replace(ANSI_PATTERN, '').trim()
  if (!line) return null
  const body = line.replace(TRACING_PREFIX, '').trim()
  if (!body) return null
  // Only surface things that read as failures; grok writes benign notices
  // (shell cwd resets, update checks) to stderr too.
  if (!/\b(error|fatal|panic)\b/i.test(line) && !/^Traceback /.test(body)) return null
  return body
}

// ---------------------------------------------------------------------------
// Update projection
// ---------------------------------------------------------------------------

export interface GrokToolProjectionState {
  announced: Set<string>
  settled: Set<string>
  argsById: Map<string, unknown>
  titleById: Map<string, string>
  nameById: Map<string, string>
}

export function createGrokToolProjectionState(): GrokToolProjectionState {
  return {
    announced: new Set(),
    settled: new Set(),
    argsById: new Map(),
    titleById: new Map(),
    nameById: new Map(),
  }
}

// Only these carry turn content. Grok also pushes session/update notifications
// that belong to no turn at all — `available_commands_update` fires twice right
// after session/new, before any prompt exists. Starting a turn on those invents
// a turn nothing can ever end, which pins the composer as "running" and makes
// the first real prompt fail with "a turn is already running".
const TURN_CONTENT_UPDATES = new Set([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
])

export function grokUpdateStartsTurn(sessionUpdate: string): boolean {
  return TURN_CONTENT_UPDATES.has(sessionUpdate)
}

/** Pure ACP update projection, shared by the live bridge and regression tests. */
export function grokEventsFromUpdate(
  update: GrokSessionUpdate,
  bridgeId: string,
  turnId: string,
  tools: GrokToolProjectionState,
): BridgeEvent[] {
  const kind = update.sessionUpdate
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    const delta = contentText(update.content)
    if (!delta) return []
    return [kind === 'agent_message_chunk'
      ? { type: 'text_delta', bridgeId, turnId, delta }
      : { type: 'thinking_delta', bridgeId, turnId, delta }]
  }

  if (kind === 'tool_call' || kind === 'tool_call_update') {
    const toolCallId = update.toolCallId
    if (!toolCallId) return []
    const name = tools.nameById.get(toolCallId) ?? grokToolMeta(update).name
    const title = update.title ?? tools.titleById.get(toolCallId)
    const args = update.rawInput ?? tools.argsById.get(toolCallId)
    const events: BridgeEvent[] = []

    if (!tools.announced.has(toolCallId)) {
      tools.announced.add(toolCallId)
      tools.nameById.set(toolCallId, name)
      events.push({ type: 'tool_start', bridgeId, turnId, toolCallId, toolName: name, args })
    }
    if (title) tools.titleById.set(toolCallId, title)
    if (update.rawInput !== undefined) tools.argsById.set(toolCallId, update.rawInput)

    const status = update.status
    if (status === 'completed' || status === 'failed') {
      tools.settled.add(toolCallId)
      events.push({
        type: 'tool_end',
        bridgeId,
        turnId,
        toolCallId,
        result: update.rawOutput ?? toolContent(update.content) ?? {},
        isError: status === 'failed',
        args,
        title,
      })
      tools.argsById.delete(toolCallId)
      tools.titleById.delete(toolCallId)
      tools.nameById.delete(toolCallId)
    } else if (kind === 'tool_call_update') {
      // A bare `tool_call` only announces the row, so it needs no second event.
      events.push({
        type: 'tool_update',
        bridgeId,
        turnId,
        toolCallId,
        partial: update.rawOutput ?? toolContent(update.content) ?? { status: status ?? 'in_progress' },
        args,
        title,
      })
    }
    return events
  }

  return []
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

export async function createGrokBridge(
  grokPath: string,
  opts: BridgeStartOpts,
  emit: EmitFn,
  requestUser?: RequestUserFn,
): Promise<AgentBridge> {
  const args = grokSpawnArgs(opts)

  const { proc, dir, remote } = await spawnAgentProcess({
    command: grokPath,
    args,
    cwd: opts.cwd,
    env: { ...(opts.env ?? {}) },
  })

  let nextRequestId = 1
  const pending = new Map<JsonRpcId, PendingRequest>()
  let sessionId: string | null = null
  let currentTurnId: string | null = null
  let lastUsage: TurnUsage | undefined
  let contextWindow: number | undefined
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let lastStderrMessage = ''
  let lastStderrAt = 0
  let replayingSessionLoad = false
  let replayTurnSequence = 0
  let replayTurnId: string | null = null
  let tools = createGrokToolProjectionState()
  let promptWatchdog: InactivityWatchdog | null = null
  // True only while a session/prompt request is outstanding. Turn content that
  // arrives outside that window belongs to a turn that already ended, and must
  // never open a new one — see handleSessionUpdate.
  let promptInFlight = false
  let stopping = false
  let unusable = false
  let followUpSeq = 0
  const followUpQueue: Array<{ id: string; text: string; options?: PromptOptions }> = []
  const debug = process.env.CREWCODE_GROK_DEBUG === '1'

  // Grok would also accept a concurrent session/prompt and queue it upstream,
  // but it runs the queued prompt as a fresh turn after the current one stops —
  // the same semantics as a local queue, minus the ability to show or cancel
  // pending items. Queue locally so the composer can do both, and so only one
  // session/prompt is ever in flight.
  function clearFollowUps(reason: 'removed' | 'cleared'): void {
    for (const item of followUpQueue) {
      emit({ type: 'follow_up_removed', bridgeId: opts.bridgeId, followUpId: item.id, reason })
    }
    followUpQueue.length = 0
  }

  function drainFollowUps(): void {
    if (currentTurnId || followUpQueue.length === 0) return
    const next = followUpQueue.shift()
    if (!next) return
    emit({ type: 'follow_up_removed', bridgeId: opts.bridgeId, followUpId: next.id, reason: 'sent' })
    void bridge.prompt(next.text, next.options)
  }

  function dbg(direction: '>>' | '<<', label: string, extra?: string): void {
    if (!debug) return
    process.stderr.write(`[grok ${opts.bridgeId}] ${direction} ${label}${extra ? ` ${extra}` : ''}\n`)
  }

  function send(message: Record<string, unknown>): boolean {
    if (proc.stdin.destroyed || !proc.stdin.writable) return false
    dbg('>>', String(message.method ?? `response id=${String(message.id)}`))
    proc.stdin.write(`${JSON.stringify(message)}\n`)
    return true
  }

  function notify(method: string, params: Record<string, unknown>): boolean {
    return send({ jsonrpc: '2.0', method, params })
  }

  function request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
    timeoutOptions: {
      activityBased?: boolean
      cancelOnTimeout?: () => void
      onCancellationGraceExpired?: () => void
    } = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = nextRequestId++
      const timeoutError = new Error(`grok acp: ${method} timed out`)
      let watchdog: InactivityWatchdog | null = null
      let fixedTimer: ReturnType<typeof setTimeout> | null = null
      let activeWatchdog: InactivityWatchdog | null = null
      const clearTimeoutState = (): void => {
        watchdog?.stop()
        watchdog = null
        if (fixedTimer) clearTimeout(fixedTimer)
        fixedTimer = null
        if (promptWatchdog && promptWatchdog === activeWatchdog) promptWatchdog = null
      }
      const entry: PendingRequest = {
        stopTimeout: clearTimeoutState,
        timedOut: false,
        reject,
        resolve: response => {
          if (entry.timedOut) reject(timeoutError)
          else if (response.error) reject(new Error(grokRequestErrorMessage(method, response.error)))
          else resolve(response.result as T)
        },
      }
      const rejectTimedOut = (): void => {
        pending.delete(id)
        clearTimeoutState()
        reject(timeoutError)
      }
      const onTimeout = (): void => {
        if (!timeoutOptions.cancelOnTimeout) {
          rejectTimedOut()
          return
        }
        // A real timeout must cancel the running Grok turn before CrewCode ends
        // it, or the next prompt overlaps live provider work.
        entry.timedOut = true
        timeoutOptions.cancelOnTimeout()
        fixedTimer = setTimeout(() => {
          timeoutOptions.onCancellationGraceExpired?.()
          rejectTimedOut()
        }, GROK_PROMPT_CANCELLATION_GRACE_MS)
      }

      if (timeoutOptions.activityBased) {
        watchdog = new InactivityWatchdog(timeoutMs, onTimeout)
        activeWatchdog = watchdog
        promptWatchdog = watchdog
      } else {
        fixedTimer = setTimeout(onTimeout, timeoutMs)
      }
      pending.set(id, entry)
      if (!send({ jsonrpc: '2.0', id, method, params })) {
        entry.stopTimeout()
        pending.delete(id)
        reject(new Error('grok acp: process not writable'))
      }
    })
  }

  function startTurn(): string {
    if (currentTurnId) return currentTurnId
    currentTurnId = `${opts.bridgeId}-t-${Date.now().toString(36)}`
    lastUsage = undefined
    tools = createGrokToolProjectionState()
    emit({ type: 'turn_start', bridgeId: opts.bridgeId, turnId: currentTurnId })
    return currentTurnId
  }

  async function endTurn(): Promise<void> {
    promptInFlight = false
    if (!currentTurnId) return
    const turnId = currentTurnId
    const turnTools = tools
    currentTurnId = null
    tools = createGrokToolProjectionState()
    // Denial, cancellation, or a provider failure can end a turn with no
    // terminal tool update. Never leave a pending row spinning forever.
    for (const toolCallId of turnTools.announced) {
      if (turnTools.settled.has(toolCallId)) continue
      emit({
        type: 'tool_end',
        bridgeId: opts.bridgeId,
        turnId,
        toolCallId,
        result: { outcome: 'cancelled' },
        isError: true,
        args: turnTools.argsById.get(toolCallId),
        title: turnTools.titleById.get(toolCallId),
      })
    }
    const usage = await enrichUsageContextWindow(lastUsage)
    lastUsage = undefined
    emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId, usage })
  }

  function ensureReplayTurn(): string {
    replayTurnId ??= `${opts.bridgeId}-history-${++replayTurnSequence}`
    return replayTurnId
  }

  function handleReplayUpdate(update: GrokSessionUpdate): boolean {
    if (!replayingSessionLoad) return false
    const kind = update.sessionUpdate
    if (kind !== 'user_message_chunk' && kind !== 'agent_message_chunk') return false
    if (opts.suppressProviderHistoryReplay) return true
    const text = contentText(update.content)
    if (!text) return true
    if (kind === 'user_message_chunk') {
      emit({ type: 'history_user', bridgeId: opts.bridgeId, text })
      replayTurnId = `${opts.bridgeId}-history-${++replayTurnSequence}`
    } else {
      emit({ type: 'history_agent', bridgeId: opts.bridgeId, turnId: ensureReplayTurn(), text })
    }
    return true
  }

  function handleSessionUpdate(params: { sessionId?: string; update: GrokSessionUpdate }): void {
    const update = params.update
    if (!update || handleReplayUpdate(update)) return
    if (sessionId && params.sessionId && params.sessionId !== sessionId) return
    promptWatchdog?.activity()
    // Session chrome (available commands, mode echo, titles) must never open a
    // turn; only turn content does.
    if (!grokUpdateStartsTurn(update.sessionUpdate)) {
      dbg('<<', `non-turn update:${update.sessionUpdate}`)
      return
    }

    // Grok keeps flushing updates after it has answered the session/prompt —
    // a trailing tool_call_update, or content flushed after a cancel. With no
    // request left in flight nothing will ever call endTurn for those, so
    // opening a turn here pins the composer as "working" after the reply is
    // visibly done and makes the user's next message fail with "a turn is
    // already running". Drop them instead; endTurn already settled the tools.
    if (!currentTurnId && !promptInFlight) {
      dbg('<<', `out-of-turn update:${update.sessionUpdate}`)
      return
    }

    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const meta = grokToolMeta(update)
      const known = update.toolCallId ? tools.announced.has(update.toolCallId) : false
      if (!known && grokToolBlocked(opts, meta)) {
        // Grok's own permission mode should already have refused this; the
        // bridge gate is the independent second layer that does not depend on
        // the user's grok config being what we asked for.
        emit({
          type: 'error',
          bridgeId: opts.bridgeId,
          message: `Tool "${meta.name}" is not allowed in ${opts.toolPolicy === 'read-only' ? 'read-only' : String(opts.mode)} mode`,
        })
        return
      }
    }

    const turnId = startTurn()
    for (const event of grokEventsFromUpdate(update, opts.bridgeId, turnId, tools)) emit(event)
  }

  // Grok's vendor channel. `response_completed` is the only place streaming
  // usage appears; the rest is UI chrome (announcements, queue, settings) that
  // CrewCode deliberately ignores.
  function handleVendorNotification(params: Record<string, unknown>): void {
    const update = record(params.update)
    if (!update) return
    promptWatchdog?.activity()
    if (update.sessionUpdate !== 'response_completed') return
    const usage = record(update.usage)
    if (!usage) return
    const built = buildUsage({
      inputTokens: finiteNumber(usage.input_tokens),
      outputTokens: finiteNumber(usage.output_tokens),
      contextTokens: finiteNumber(usage.input_tokens),
      contextWindow,
      model: opts.model,
    })
    if (!built || !currentTurnId) return
    lastUsage = built
    emit({ type: 'usage_update', bridgeId: opts.bridgeId, turnId: currentTurnId, usage: built })
  }

  function resolveClientPath(value: string): string {
    if (remote) return posix.isAbsolute(value) ? value : posix.join(dir, value)
    return isAbsolute(value) ? value : pathResolve(dir, value)
  }

  async function handlePermissionRequest(requestMessage: AcpRequestIn, params: Record<string, unknown>): Promise<void> {
    const options = grokPermissionOptions(params)
    if (opts.mode === 'full' && opts.toolPolicy !== 'read-only') {
      send({
        jsonrpc: '2.0',
        id: requestMessage.id,
        result: { outcome: { outcome: 'selected', optionId: grokSelectedOption({ requestId: '', action: 'accept' }, params, options) } },
      })
      return
    }
    if (writeBlocked(opts) || !requestUser) {
      send({ jsonrpc: '2.0', id: requestMessage.id, result: { outcome: { outcome: 'cancelled' } } })
      return
    }

    const toolCall = record(params.toolCall)
    const meta = toolCall ? grokToolMeta(toolCall as unknown as GrokSessionUpdate) : { name: 'tool', readOnly: undefined }
    promptWatchdog?.pause()
    try {
      const response = await requestUser({
        kind: 'permission',
        turnId: currentTurnId ?? undefined,
        title: typeof toolCall?.title === 'string' ? toolCall.title : 'Permission required',
        message: typeof params.message === 'string' ? params.message : undefined,
        detail: JSON.stringify(toolCall ?? params, null, 2).slice(0, 1600),
        options,
        dangerous: meta.readOnly !== true,
        source: 'grok',
      })
      const optionId = grokSelectedOption(response, params, options)
      send({
        jsonrpc: '2.0',
        id: requestMessage.id,
        result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } },
      })
    } finally {
      promptWatchdog?.resume()
    }
  }

  async function handleAgentRequest(requestMessage: AcpRequestIn): Promise<void> {
    promptWatchdog?.activity()
    const params = requestMessage.params ?? {}
    try {
      if (requestMessage.method === 'session/request_permission') {
        await handlePermissionRequest(requestMessage, params)
        return
      }
      if (requestMessage.method === 'fs/read_text_file') {
        const requestedPath = String(params.path ?? '')
        if (!requestedPath) throw new Error('path is required')
        const absolutePath = resolveClientPath(requestedPath)
        let content: string
        if (remote) {
          const result = await remoteReadFile(opts.cwd, posix.relative(dir, absolutePath))
          if (result.error || typeof result.text !== 'string') throw new Error(result.error ?? 'read failed')
          content = result.text
        } else {
          // Saved disk bytes, matching the other ACP bridges. Dirty editor
          // buffers need a renderer-host route that does not exist yet.
          content = await fsp.readFile(absolutePath, 'utf8')
        }
        send({ jsonrpc: '2.0', id: requestMessage.id, result: { content } })
        return
      }
      if (requestMessage.method === 'fs/write_text_file') {
        if (writeBlocked(opts)) {
          send({
            jsonrpc: '2.0',
            id: requestMessage.id,
            error: { code: -32000, message: `write blocked in ${opts.toolPolicy === 'read-only' ? 'read-only' : String(opts.mode)} mode` },
          })
          return
        }
        const requestedPath = String(params.path ?? '')
        if (!requestedPath) throw new Error('path is required')
        const content = String(params.content ?? '')
        const absolutePath = resolveClientPath(requestedPath)
        if (remote) {
          const result = await remoteWriteFile(opts.cwd, posix.relative(dir, absolutePath), content)
          if (result.error) throw new Error(result.error)
        } else {
          await fsp.writeFile(absolutePath, content, 'utf8')
        }
        send({ jsonrpc: '2.0', id: requestMessage.id, result: {} })
        return
      }
      if (requestMessage.method.startsWith('terminal/')) {
        send({ jsonrpc: '2.0', id: requestMessage.id, error: { code: -32601, message: 'terminal capability not available' } })
        return
      }
      send({ jsonrpc: '2.0', id: requestMessage.id, error: { code: -32601, message: `method not implemented: ${requestMessage.method}` } })
    } catch (error) {
      send({ jsonrpc: '2.0', id: requestMessage.id, error: { code: -32000, message: (error as Error).message } })
    }
  }

  function handleLine(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch (error) {
      emit({ type: 'error', bridgeId: opts.bridgeId, message: `grok acp: bad json: ${(error as Error).message}` })
      return
    }

    // Grok numbers its own server->client requests from 0, so presence must be
    // tested explicitly. A truthiness check drops the first request of every
    // session — which is usually the first permission prompt.
    const id = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : undefined

    if (id !== undefined && typeof message.method !== 'string' && ('result' in message || 'error' in message)) {
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      entry.stopTimeout()
      entry.resolve(message as unknown as AcpResponse)
      return
    }
    if (id !== undefined && typeof message.method === 'string') {
      void handleAgentRequest(message as unknown as AcpRequestIn)
      return
    }
    if (typeof message.method !== 'string') return

    const params = record(message.params)
    if (message.method === 'session/update' && params) {
      const update = record(params.update)
      if (update) {
        handleSessionUpdate({
          sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined,
          update: update as unknown as GrokSessionUpdate,
        })
      }
      return
    }
    if (message.method === '_x.ai/session_notification' && params) {
      handleVendorNotification(params)
      return
    }
    dbg('<<', `notification ${message.method}`)
  }

  function consumeStdout(chunk: string): void {
    stdoutBuffer += chunk
    let newline: number
    while ((newline = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '')
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      if (line.trim()) handleLine(line)
    }
  }

  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', consumeStdout)

  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk
    const lines = stderrBuffer.split(/\r?\n/)
    stderrBuffer = lines.pop() ?? ''
    for (const raw of lines) {
      if (!raw.trim()) continue
      dbg('<<', 'stderr', raw.trim())
      const message = grokStderrMessage(raw)
      if (!message) continue
      // Grok retries a failing call up to 15 times and logs the identical
      // error every attempt. One rate limit produced five stderr lines and
      // would have produced five red rows in the chat.
      const now = Date.now()
      if (message === lastStderrMessage && now - lastStderrAt < STDERR_DEDUPE_WINDOW_MS) {
        lastStderrAt = now
        continue
      }
      lastStderrMessage = message
      lastStderrAt = now
      emit({ type: 'error', bridgeId: opts.bridgeId, message: `grok: ${message}` })
    }
  })

  proc.on('close', code => {
    for (const [, entry] of pending) {
      entry.stopTimeout()
      entry.reject(new Error(`grok acp closed before responding (code ${String(code)})`))
    }
    pending.clear()
    // Nothing can ever send these now, so retract them explicitly rather than
    // leaving pending pills stranded in the composer.
    clearFollowUps('cleared')
    void endTurn().finally(() => emit({ type: 'closed', bridgeId: opts.bridgeId, code }))
  })

  proc.on('error', error => {
    emit({ type: 'error', bridgeId: opts.bridgeId, message: `grok spawn failed: ${error.message}` })
    emit({ type: 'closed', bridgeId: opts.bridgeId, code: null })
  })

  try {
    const initResult = await request<Record<string, unknown>>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    })
    contextWindow = grokContextWindow(record(initResult)?._meta, opts.model)

    let resumed = false
    if (opts.resumeSessionId) {
      try {
        replayingSessionLoad = true
        replayTurnId = null
        await request('session/load', { sessionId: opts.resumeSessionId, cwd: dir, mcpServers: [] }, 30_000)
        sessionId = opts.resumeSessionId
        resumed = true
      } catch {
        sessionId = null
      } finally {
        replayingSessionLoad = false
        replayTurnId = null
      }
    }

    if (!sessionId) {
      const acpMcpServers = (opts.mcpServers ?? [])
        .filter(server => (server.transport ?? 'stdio') === 'stdio')
        .map(toAcpMcpServer)
      // `_meta.yoloMode` is deliberately never set. It only escalates, and the
      // spawn-level --permission-mode flag already carries CrewCode's policy.
      const response = await request<Record<string, unknown>>('session/new', { cwd: dir, mcpServers: acpMcpServers })
      const newSessionId = record(response)?.sessionId
      if (typeof newSessionId !== 'string' || !newSessionId) throw new Error('grok acp: session/new returned no session id')
      sessionId = newSessionId
      contextWindow = grokContextWindow(record(response)?._meta, opts.model) ?? grokContextWindow(response, opts.model) ?? contextWindow
    }

    if (opts.model && !resumed) {
      try {
        await request('session/set_model', { sessionId, modelId: opts.model }, 30_000)
      } catch (error) {
        // The model is already applied at spawn via --model; a set_model
        // failure must not discard a working session.
        dbg('<<', 'set_model failed', (error as Error).message)
      }
    }

    emit({ type: 'session_id', bridgeId: opts.bridgeId, sessionId, resumed })
    emit({ type: 'ready', bridgeId: opts.bridgeId })
  } catch (error) {
    emit({ type: 'error', bridgeId: opts.bridgeId, message: (error as Error).message })
  }

  const bridge: AgentBridge = {
    bridgeId: opts.bridgeId,
    pid: proc.pid ?? null,
    async prompt(text: string, options?: PromptOptions) {
      if (!sessionId) return { ok: false, error: 'grok acp: session not established' }
      if (unusable) return { ok: false, error: 'grok acp: bridge must restart after an unresponsive cancellation' }
      if (currentTurnId) {
        if (options?.streamingBehavior !== 'followUp') {
          return { ok: false, error: 'grok acp: a turn is already running' }
        }
        followUpSeq += 1
        const id = `${opts.bridgeId}-fu-${followUpSeq}`
        followUpQueue.push({ id, text, options })
        // Truncated for display only; the queued entry keeps the full text.
        emit({
          type: 'follow_up_queued',
          bridgeId: opts.bridgeId,
          followUpId: id,
          text: text.length > 300 ? `${text.slice(0, 300)}…` : text,
        })
        return { ok: true }
      }
      if (proc.stdin.destroyed || !proc.stdin.writable) return { ok: false, error: 'grok acp: process not writable' }
      promptInFlight = true
      startTurn()
      void (async () => {
        try {
          const result = await request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text }],
          }, GROK_PROMPT_INACTIVITY_TIMEOUT_MS, {
            activityBased: true,
            cancelOnTimeout: () => notify('session/cancel', { sessionId }),
            onCancellationGraceExpired: () => {
              unusable = true
              try { proc.kill() } catch { /* already closed */ }
            },
          })
          lastUsage = grokUsageFromPromptResult(result, opts.model, contextWindow) ?? lastUsage
        } catch (error) {
          if (!stopping) emit({ type: 'error', bridgeId: opts.bridgeId, message: (error as Error).message })
        } finally {
          await endTurn()
          drainFollowUps()
        }
      })()
      return { ok: true }
    },
    async removeFollowUp(followUpId: string) {
      const index = followUpQueue.findIndex(item => item.id === followUpId)
      if (index === -1) return { ok: false, error: 'follow-up not found (already sent or removed)' }
      followUpQueue.splice(index, 1)
      emit({ type: 'follow_up_removed', bridgeId: opts.bridgeId, followUpId, reason: 'removed' })
      return { ok: true }
    },
    async abort() {
      // Stopping a turn deliberately drops everything the user had queued
      // behind it rather than letting it fire at a turn they just cancelled.
      clearFollowUps('cleared')
      if (!sessionId) return
      notify('session/cancel', { sessionId })
    },
    async stop() {
      stopping = true
      clearFollowUps('cleared')
      if (sessionId) notify('session/cancel', { sessionId })
      try { proc.stdin.end() } catch { /* already closed */ }
      setTimeout(() => {
        if (!proc.killed) {
          try { proc.kill() } catch { /* already closed */ }
        }
      }, 500)
    },
  }

  return bridge
}

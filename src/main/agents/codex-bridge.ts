import { spawnAgentProcess } from './agent-spawn'
import type { AgentBridge, BridgeStartOpts, EmitFn, ModeLevel, RequestUserFn, TurnUsage } from './bridge-types'
import { buildUsage, contextWindowFor } from './model-context'
import { tripwireForToolCall } from './dangerous-command'
import {
  CODEX_REQUEST_USER_INPUT_METHODS,
  codexQuestionAnswer,
  codexQuestionRequest,
  parseCodexUserInputQuestions,
  type CodexAnswers,
} from './codex-user-input'

// Codex app-server JSON-RPC over stdio.
// Protocol: newline-delimited JSON (`"jsonrpc": "2.0"` header omitted on the wire).
// See docs/codex-app-server*.md for the full method/notification surface.
//
// Lifecycle: spawn `codex app-server` → initialize → initialized → thread/start →
// turn/start per prompt → stream `turn/*` + `item/*` notifications → map to BridgeEvent.

type JsonValue = string | number | boolean | null | { [k: string]: JsonValue } | JsonValue[]

interface JsonRpcRequest {
  id:     number
  method: string
  params: Record<string, unknown>
}

interface JsonRpcResponseOk  { id: number; result: Record<string, unknown> }
interface JsonRpcResponseErr { id: number; error:  { code: number; message: string } }
interface JsonRpcNotification { method: string; params: Record<string, unknown> }
interface JsonRpcServerRequest { id: number; method: string; params: Record<string, unknown> }

type IncomingMessage = JsonRpcResponseOk | JsonRpcResponseErr | JsonRpcNotification | JsonRpcServerRequest

function isResponse(msg: IncomingMessage): msg is JsonRpcResponseOk | JsonRpcResponseErr {
  return typeof (msg as { id?: unknown }).id === 'number' && !('method' in msg)
}
function isServerRequest(msg: IncomingMessage): msg is JsonRpcServerRequest {
  return typeof (msg as { id?: unknown }).id === 'number' && 'method' in msg
}

const READ_TOOLS = new Set(['read', 'glob', 'grep', 'web_search', 'webfetch'])

export const CODEX_COMPACT_METHOD = 'thread/compact/start'

export function getModeConfig(mode?: ModeLevel, toolPolicy?: BridgeStartOpts['toolPolicy']) {
  if (toolPolicy === 'read-only') return { sandbox: 'read-only' as const, approvalPolicy: 'untrusted' as const, allowTools: READ_TOOLS }
  switch (mode) {
    case 'ask':
      return { sandbox: 'read-only' as const, approvalPolicy: 'untrusted' as const, allowTools: READ_TOOLS }
    case 'plan':
      return { sandbox: 'read-only' as const, approvalPolicy: 'untrusted' as const, allowTools: READ_TOOLS }
    case 'build':
      return { sandbox: 'workspace-write' as const, approvalPolicy: 'on-request' as const, allowTools: null }
    case 'full':
      return { sandbox: 'workspace-write' as const, approvalPolicy: 'never' as const, allowTools: null }
    default:
      return { sandbox: 'workspace-write' as const, approvalPolicy: 'on-request' as const, allowTools: null }
  }
}

export function codexApprovalDecisionForMode(mode?: ModeLevel, toolPolicy?: BridgeStartOpts['toolPolicy']): 'accept' | 'decline' | null {
  if (toolPolicy === 'read-only') return 'decline'
  if (mode === 'full') return 'accept'
  if (mode === 'ask' || mode === 'plan') return 'decline'
  return null
}

function pickNum(obj: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  if (!obj) return undefined
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

// Codex's usage notification reports an effective per-request prompt budget.
// The CLI's model window can be larger because it includes reserved capacity.
// Keep both values so the meter names the full model capacity while exposing
// the tighter active budget instead of presenting it as the model's size.
function codexContextWindows(model: string | undefined, reported: number | undefined): { contextWindow?: number; promptBudgetTokens?: number } {
  const modelWindow = contextWindowFor(model)
  const promptBudgetTokens = reported !== undefined && reported > 0 ? reported : undefined
  return {
    contextWindow: modelWindow !== undefined && promptBudgetTokens !== undefined
      ? Math.max(modelWindow, promptBudgetTokens)
      : modelWindow ?? promptBudgetTokens,
    ...(promptBudgetTokens !== undefined && modelWindow !== undefined && modelWindow > promptBudgetTokens
      ? { promptBudgetTokens }
      : {}),
  }
}

function codexContextTokensFor(inputTokens: number | undefined, outputTokens: number | undefined, contextWindow: number | undefined): number | undefined {
  if (inputTokens === undefined) return undefined
  const contextTokens = inputTokens + (outputTokens ?? 0)
  return contextWindow !== undefined ? Math.min(contextTokens, contextWindow) : contextTokens
}

export function usageFromCodexTokenUsage(params: Record<string, unknown>, model: string | undefined): TurnUsage | undefined {
  const tu    = (params.tokenUsage ?? params.usage ?? params) as Record<string, unknown>
  const last  = (tu.last  ?? tu) as Record<string, unknown> | undefined
  if (!last) return undefined
  const inputTokens  = pickNum(last, 'inputTokens', 'input_tokens')
  const outputTokens = pickNum(last, 'outputTokens', 'output_tokens')
  const { contextWindow, promptBudgetTokens } = codexContextWindows(model, pickNum(tu, 'modelContextWindow', 'model_context_window', 'contextWindow'))
  const contextTokens = codexContextTokensFor(inputTokens, outputTokens, contextWindow)
  const usage = buildUsage({
    inputTokens,
    outputTokens,
    // `total` is cumulative billing for the thread. Use the latest request's
    // prompt size instead so ctx-pop reflects the live context window.
    contextTokens,
    contextWindow,
    model,
  })
  if (!usage) return undefined
  const rows: NonNullable<TurnUsage['contextBreakdown']> = []
  const add = (name: string, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value) && value > 0) rows.push({ name, tokens: value })
  }
  add('Latest request input', inputTokens)
  add('Latest request output', outputTokens)
  add('Cached input (included in input)', pickNum(last, 'cachedInputTokens', 'cached_input_tokens'))
  add('Reasoning output (included in output)', pickNum(last, 'reasoningOutputTokens', 'reasoning_output_tokens'))
  return {
    ...usage,
    ...(promptBudgetTokens !== undefined ? { promptBudgetTokens } : {}),
    ...(inputTokens !== undefined ? { contextIsAuthoritative: true } : {}),
    ...(rows.length > 0 ? { contextBreakdown: rows, contextBreakdownSource: 'usage' as const } : {}),
  }
}

export function codexNativeCompactionStatus(
  method: string,
  item: Record<string, unknown> | undefined,
): 'started' | 'completed' | null {
  if (method === 'thread/compacted') return 'completed'
  if (item?.type !== 'contextCompaction') return null
  if (method === 'item/started') return 'started'
  if (method === 'item/completed') return 'completed'
  return null
}

// Codex app-server accepts these native effort values. Keep unsupported values
// explicit instead of silently downgrading a user's selection.
export function mapCodexEffort(eff?: string): string | undefined {
  if (!eff || eff === 'off') return undefined
  if (eff === 'low' || eff === 'medium' || eff === 'high' || eff === 'xhigh' || eff === 'max' || eff === 'ultra') return eff
  throw new Error(`Codex does not support reasoning effort "${eff}"`)
}

export async function createCodexBridge(
  codexPath: string,
  opts: BridgeStartOpts,
  emit: EmitFn,
  requestUser?: RequestUserFn,
): Promise<AgentBridge> {
  const codexEnv: Record<string, string> = { ...(opts.env ?? {}) }
  if (opts.apiKey) codexEnv.OPENAI_API_KEY = opts.apiKey

  // `dir` is the on-host working directory (remote abs path when remote) — codex
  // needs it both as the process cwd and inside the thread/start protocol below.
  const { proc, dir } = await spawnAgentProcess({
    command: codexPath,
    args:    ['app-server'],
    cwd:     opts.cwd,
    env:     codexEnv,
  })

  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')

  let stderrTail = ''
  proc.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000)
  })

  let nextReqId = 1
  const pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (err: Error) => void }>()
  let threadId: string | null = null

  // Per-bridge turn state. Codex turn ids come from the server (turn.id).
  let currentTurnId: string | null = null
  // Buffer agentMessage text so we only emit incremental deltas (Codex sends both
  // deltas via `item/agentMessage/delta` and full snapshots via `item/completed`).
  const agentTextByItem: Record<string, string> = {}
  // Same idea for reasoning summary text.
  const reasoningTextByItem: Record<string, string> = {}
  // Track each agentMessage item's `phase`. `commentary` is Codex's pre-reply
  // narration ("I'll look at X, then…") and must route to the thinking stream;
  // `final_answer` is the real reply that becomes the agent bubble.
  const agentMsgPhase: Record<string, 'commentary' | 'final_answer'> = {}
  // Map item ids → tool call ids so `item/completed` can flip status without a separate map.
  const toolStartedItems = new Set<string>()
  let activePlanToolCallId: string | null = null
  let activePlanArgs: { plan: unknown[] } | null = null
  // Open question cards keyed by the server request id, so `serverRequest/resolved`
  // (Codex settled it itself) or process exit can withdraw the card.
  const openQuestionRequests = new Map<number, AbortController>()

  function emitReady() {
    emit({ type: 'ready', bridgeId: opts.bridgeId })
  }

  function send(obj: Record<string, unknown>): boolean {
    if (proc.stdin.destroyed || !proc.stdin.writable) return false
    proc.stdin.write(JSON.stringify(obj) + '\n')
    return true
  }

  function request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = nextReqId++
    const req: JsonRpcRequest = { id, method, params }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      if (!send(req as unknown as Record<string, unknown>)) {
        pending.delete(id)
        reject(new Error('codex app-server stdin not writable'))
      }
    })
  }

  function notify(method: string, params: Record<string, unknown> = {}): void {
    send({ method, params })
  }

  function respond(id: number, result: Record<string, unknown>): void {
    send({ id, result })
  }

  function respondError(id: number, message: string): void {
    send({ id, error: { code: -32000, message } })
  }

  // One overlay card per question, in order. Any unanswered question fails the
  // whole request explicitly — Codex never receives a fabricated/empty answer.
  async function handleUserInputRequest(msg: JsonRpcServerRequest): Promise<void> {
    const questions = parseCodexUserInputQuestions(msg.params)
    if (!requestUser || questions.length === 0) {
      respondError(msg.id, requestUser ? 'request_user_input had no questions' : 'no interactive user is attached')
      return
    }
    const controller = new AbortController()
    openQuestionRequests.set(msg.id, controller)
    const turnId = typeof msg.params.turnId === 'string' ? msg.params.turnId : currentTurnId ?? undefined
    try {
      const answers: CodexAnswers = {}
      for (let index = 0; index < questions.length; index++) {
        const question = questions[index]
        const response = await requestUser(codexQuestionRequest(question, index, questions.length, turnId), controller.signal)
        if (controller.signal.aborted) return
        const answer = codexQuestionAnswer(question, response)
        if (!answer) {
          respondError(msg.id, 'user cancelled request_user_input')
          return
        }
        answers[question.id] = { answers: answer }
      }
      respond(msg.id, { answers })
    } finally {
      openQuestionRequests.delete(msg.id)
    }
  }

  function handleResponse(msg: JsonRpcResponseOk | JsonRpcResponseErr) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if ('error' in msg) p.reject(new Error(msg.error.message || `codex error ${msg.error.code}`))
    else                p.resolve(msg.result ?? {})
  }

  function startTurn(turnIdFromServer?: string): string {
    if (currentTurnId) return currentTurnId
    currentTurnId = turnIdFromServer ?? `${opts.bridgeId}-t-${Date.now().toString(36)}`
    emit({ type: 'turn_start', bridgeId: opts.bridgeId, turnId: currentTurnId })
    return currentTurnId
  }

  // Codex reports usage on the thread-level `thread/tokenUsage/updated`
  // notification (not turn/completed), so we hold the latest snapshot and flush
  // it when the turn ends.
  let lastUsage: TurnUsage | undefined
  let nativeCompactionActive = false
  let nativeCompactionCompletedTurnId: string | undefined

  function emitNativeCompaction(status: 'started' | 'completed' | 'failed', notificationTurnId?: string) {
    const turnId = currentTurnId ?? notificationTurnId
    const completionKey = notificationTurnId ?? currentTurnId ?? undefined
    if (status === 'started') {
      if (nativeCompactionActive) return
      nativeCompactionActive = true
    } else if (status === 'completed') {
      if (!nativeCompactionActive && completionKey && nativeCompactionCompletedTurnId === completionKey) return
      nativeCompactionActive = false
      nativeCompactionCompletedTurnId = completionKey
      // A usage notification from before compaction must not be replayed by
      // turn_end when the app-server has not reported the new prompt yet.
      lastUsage = undefined
    } else {
      if (!nativeCompactionActive) return
      nativeCompactionActive = false
    }
    emit({
      type: 'compaction_event',
      bridgeId: opts.bridgeId,
      ...(turnId ? { turnId } : {}),
      status,
      automatic: true,
      provider: 'codex',
      percent: status === 'completed' ? 100 : undefined,
      message: status === 'started'
        ? 'Codex is compacting its native context…'
        : status === 'completed'
          ? 'Codex compacted its native context. Continuing normally.'
          : 'Codex native context compaction stopped before completion.',
      ...(status === 'completed' ? { resetContext: true } : {}),
    })
  }

  function endTurn(usage?: TurnUsage) {
    if (!currentTurnId) return
    if (activePlanToolCallId) {
      emit({
        type:       'tool_end',
        bridgeId:   opts.bridgeId,
        turnId:     currentTurnId,
        toolCallId: activePlanToolCallId,
        result:     activePlanArgs ?? {},
        isError:    false,
      })
      activePlanToolCallId = null
      activePlanArgs = null
    }
    emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId: currentTurnId, usage: usage ?? lastUsage })
    currentTurnId = null
  }

  // Extract token usage from a `thread/tokenUsage/updated` payload. Codex shape:
  //   { tokenUsage: { total: {...}, last: {...}, modelContextWindow } }
  // `total` is cumulative billing across the thread. `last.inputTokens` is the
  // best live-context proxy because it is the prompt sent for the latest call.
  function captureTokenUsage(params: Record<string, unknown>): void {
    if (process.env.CREWCODE_DEBUG_USAGE) {
      // eslint-disable-next-line no-console
      console.error('[codex usage]', JSON.stringify(params).slice(0, 600))
    }
    const usage = usageFromCodexTokenUsage(params, opts.model)
    if (!usage) return
    lastUsage = usage
    if (currentTurnId) emit({ type: 'usage_update', bridgeId: opts.bridgeId, turnId: currentTurnId, usage })
  }

  function handleItemStarted(item: Record<string, unknown>) {
    const turnId = startTurn()
    const type   = String(item.type ?? '')
    const itemId = String(item.id ?? '')

    // Tool-like items get a tool_start so the UI can render a card.
    if (type === 'commandExecution') {
      toolStartedItems.add(itemId)
      emit({
        type:       'tool_start',
        bridgeId:   opts.bridgeId,
        turnId,
        toolCallId: itemId,
        toolName:   'shell',
        args:       { command: item.command, cwd: item.cwd },
      })
      return
    }
    if (type === 'fileChange') {
      toolStartedItems.add(itemId)
      emit({
        type:       'tool_start',
        bridgeId:   opts.bridgeId,
        turnId,
        toolCallId: itemId,
        toolName:   'apply_patch',
        args:       { changes: item.changes },
      })
      return
    }
    if (type === 'mcpToolCall') {
      toolStartedItems.add(itemId)
      emit({
        type:       'tool_start',
        bridgeId:   opts.bridgeId,
        turnId,
        toolCallId: itemId,
        toolName:   `${String(item.server ?? 'mcp')}/${String(item.tool ?? 'tool')}`,
        args:       item.arguments,
      })
      return
    }
    if (type === 'webSearch') {
      toolStartedItems.add(itemId)
      emit({
        type:       'tool_start',
        bridgeId:   opts.bridgeId,
        turnId,
        toolCallId: itemId,
        toolName:   'web_search',
        args:       { query: item.query, action: item.action },
      })
      return
    }
    if (type === 'agentMessage') {
      const phase = item.phase === 'commentary' ? 'commentary' : 'final_answer'
      agentMsgPhase[itemId] = phase
      const text = typeof item.text === 'string' ? item.text : ''
      agentTextByItem[itemId] = ''
      if (text.length > 0) {
        agentTextByItem[itemId] = text
        emit({
          type:     phase === 'commentary' ? 'thinking_delta' : 'text_delta',
          bridgeId: opts.bridgeId,
          turnId,
          delta:    text,
        })
      }
      return
    }
    if (type === 'reasoning') {
      reasoningTextByItem[itemId] = ''
      return
    }
  }

  function extractPlan(params: Record<string, unknown>): unknown[] | null {
    const candidates = [
      params.plan,
      (params.update_plan as Record<string, unknown> | undefined)?.plan,
      (params.updatePlan as Record<string, unknown> | undefined)?.plan,
      (params.planUpdate as Record<string, unknown> | undefined)?.plan,
    ]
    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length > 0) return candidate
    }
    return null
  }

  function handlePlanUpdate(params: Record<string, unknown>) {
    const plan = extractPlan(params)
    if (!plan) return
    const turnId = startTurn()
    const args = { plan }
    activePlanArgs = args
    if (!activePlanToolCallId) {
      activePlanToolCallId = `${turnId}-update-plan`
      emit({
        type:       'tool_start',
        bridgeId:   opts.bridgeId,
        turnId,
        toolCallId: activePlanToolCallId,
        toolName:   'update_plan',
        args,
      })
      return
    }
    emit({
      type:       'tool_update',
      bridgeId:   opts.bridgeId,
      turnId,
      toolCallId: activePlanToolCallId,
      partial:    args,
      args,
      title:      'update plan',
    })
  }

  function handleItemCompleted(item: Record<string, unknown>) {
    const turnId = startTurn()
    const type   = String(item.type ?? '')
    const itemId = String(item.id ?? '')

    if (type === 'agentMessage') {
      // Honour the phase recorded at item/started. Falls back to whatever the
      // completed payload reports so a never-seen-started item still routes.
      const phase = agentMsgPhase[itemId]
        ?? (item.phase === 'commentary' ? 'commentary' : 'final_answer')
      const finalText = typeof item.text === 'string' ? item.text : ''
      const prev = agentTextByItem[itemId] ?? ''
      if (finalText.length > prev.length && finalText.startsWith(prev)) {
        emit({
          type:     phase === 'commentary' ? 'thinking_delta' : 'text_delta',
          bridgeId: opts.bridgeId,
          turnId,
          delta:    finalText.slice(prev.length),
        })
        agentTextByItem[itemId] = finalText
      }
      return
    }

    if (toolStartedItems.has(itemId)) {
      const status   = String(item.status ?? '')
      const isError  = status === 'failed' || status === 'declined' || status === 'error'
      let result: unknown = item
      if (type === 'commandExecution') {
        result = {
          exitCode:         item.exitCode,
          aggregatedOutput: item.aggregatedOutput,
          durationMs:       item.durationMs,
        }
      } else if (type === 'fileChange') {
        result = { changes: item.changes, status: item.status }
      } else if (type === 'mcpToolCall') {
        result = item.result ?? item.error ?? null
      }
      emit({
        type:       'tool_end',
        bridgeId:   opts.bridgeId,
        turnId,
        toolCallId: itemId,
        result,
        isError,
      })
      toolStartedItems.delete(itemId)
    }
  }

  function handleNotification(msg: JsonRpcNotification) {
    const notificationItem = msg.params.item as Record<string, unknown> | undefined
    const compactionStatus = codexNativeCompactionStatus(msg.method, notificationItem)
    if (compactionStatus) {
      emitNativeCompaction(compactionStatus, typeof msg.params.turnId === 'string' ? msg.params.turnId : undefined)
      return
    }
    if (msg.method === 'serverRequest/resolved') {
      // Codex settled a request without us (e.g. non-blocking question).
      // Withdraw the card rather than leave a stale "agent is waiting" prompt.
      const id = Number(msg.params.requestId)
      openQuestionRequests.get(id)?.abort()
      return
    }
    switch (msg.method) {
      case 'thread/started':
        emitReady()
        return

      case 'turn/started': {
        const turn = msg.params.turn as { id?: string } | undefined
        startTurn(turn?.id)
        return
      }

      case 'thread/tokenUsage/updated':
        captureTokenUsage(msg.params)
        return

      case 'turn/completed':
        if (nativeCompactionActive) emitNativeCompaction('failed')
        endTurn()
        return

      case 'turn/failed':
        emitNativeCompaction('failed')
        endTurn()
        return

      case 'item/started': {
        const item = msg.params.item as Record<string, unknown> | undefined
        if (item) handleItemStarted(item)
        return
      }

      case 'item/completed': {
        const item = msg.params.item as Record<string, unknown> | undefined
        if (item) handleItemCompleted(item)
        return
      }

      case 'item/agentMessage/delta': {
        const turnId  = startTurn()
        const itemId  = String(msg.params.itemId ?? '')
        const delta   = typeof msg.params.delta === 'string' ? msg.params.delta : ''
        if (!delta) return
        agentTextByItem[itemId] = (agentTextByItem[itemId] ?? '') + delta
        const phase = agentMsgPhase[itemId] ?? 'final_answer'
        emit({
          type:     phase === 'commentary' ? 'thinking_delta' : 'text_delta',
          bridgeId: opts.bridgeId,
          turnId,
          delta,
        })
        return
      }

      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const turnId = startTurn()
        const itemId = String(msg.params.itemId ?? '')
        const delta  = typeof msg.params.delta === 'string' ? msg.params.delta : ''
        if (!delta) return
        reasoningTextByItem[itemId] = (reasoningTextByItem[itemId] ?? '') + delta
        emit({ type: 'thinking_delta', bridgeId: opts.bridgeId, turnId, delta })
        return
      }

      case 'plan/update':
      case 'plan/update_plan':
      case 'plan/updated':
      case 'thread/plan/update':
      case 'thread/update_plan':
        handlePlanUpdate(msg.params)
        return

      case 'item/commandExecution/outputDelta': {
        const turnId     = startTurn()
        const itemId     = String(msg.params.itemId ?? '')
        const stream     = String(msg.params.stream ?? 'stdout')
        const deltaB64   = typeof msg.params.deltaBase64 === 'string' ? msg.params.deltaBase64 : ''
        let decoded = ''
        try { decoded = Buffer.from(deltaB64, 'base64').toString('utf8') } catch { /* ignore */ }
        emit({
          type:       'tool_update',
          bridgeId:   opts.bridgeId,
          turnId,
          toolCallId: itemId,
          partial:    { stream, output: decoded },
        })
        return
      }

      case 'thread/closed':
      case 'thread/archived':
        return

      // Notifications we intentionally drop for now (status, diff, tokenUsage, etc.)
      default:
        return
    }
  }

  function requestDetail(params: Record<string, unknown>): string {
    const preview = JSON.stringify(params, null, 2)
    return preview.length > 1200 ? `${preview.slice(0, 1200)}…` : preview
  }

  // Server-initiated requests need a response so app-server can continue. The
  // renderer answers these inline, then this pending handler resolves and Codex
  // resumes the same turn instead of requiring a new prompt.
  async function handleServerRequest(msg: JsonRpcServerRequest) {
    if (msg.method === 'item/commandExecution/requestApproval' ||
        msg.method === 'item/fileChange/requestApproval') {
      // Mode switches mutate opts on the live bridge; honor them even when the
      // Codex thread was started with a different approval policy.
      const modeDecision = codexApprovalDecisionForMode(opts.mode, opts.toolPolicy)
      // Full Access tripwire: a denylisted command must confirm even when the mode
      // would auto-accept. Codex's workspace-write sandbox (no network, scoped
      // writes) already blocks most of the denylist; this is defense-in-depth for
      // in-workspace destruction whenever Codex does surface an approval request.
      const itemRecord = (msg.params.item && typeof msg.params.item === 'object') ? msg.params.item as Record<string, unknown> : undefined
      const codexCommand = msg.params.command ?? itemRecord?.command
      const codexVerdict = codexCommand !== undefined ? tripwireForToolCall('shell', { command: codexCommand }) : { dangerous: false as const }
      if (!codexVerdict.dangerous && (modeDecision || !requestUser)) {
        respond(msg.id, { decision: modeDecision ?? 'accept' })
        return
      }
      if (!requestUser) {
        respond(msg.id, { decision: codexVerdict.dangerous ? 'decline' : (modeDecision ?? 'accept') })
        return
      }
      const response = await requestUser({
        kind: 'permission',
        turnId: currentTurnId ?? undefined,
        title: codexVerdict.dangerous ? 'Full Access tripwire — confirm dangerous command' : (msg.method.includes('commandExecution') ? 'approve command execution' : 'approve file change'),
        message: codexVerdict.dangerous ? codexVerdict.reason : (typeof msg.params.reason === 'string' ? msg.params.reason : undefined),
        detail: requestDetail(msg.params),
        dangerous: true,
        source: 'codex',
      })
      respond(msg.id, { decision: response.action === 'accept' || response.action === 'submit' ? 'accept' : 'decline' })
      return
    }
    if (CODEX_REQUEST_USER_INPUT_METHODS.has(msg.method)) {
      await handleUserInputRequest(msg)
      return
    }
    if (msg.method === 'account/chatgptAuthTokens/refresh') {
      respond(msg.id, { decision: 'decline' })
      return
    }
    // Unknown server requests — respond with empty object so the server can move on.
    respond(msg.id, {})
  }

  let lineBuf = ''
  proc.stdout.on('data', (chunk: string) => {
    lineBuf += chunk
    let nl
    while ((nl = lineBuf.indexOf('\n')) !== -1) {
      const line = lineBuf.slice(0, nl).replace(/\r$/, '')
      lineBuf = lineBuf.slice(nl + 1)
      if (!line.trim()) continue
      let parsed: IncomingMessage
      try {
        parsed = JSON.parse(line) as IncomingMessage
      } catch (err) {
        emit({ type: 'error', bridgeId: opts.bridgeId, message: `codex: bad json: ${(err as Error).message}` })
        continue
      }
      if (isResponse(parsed))             handleResponse(parsed)
      else if (isServerRequest(parsed))   void handleServerRequest(parsed)
      else                                handleNotification(parsed as JsonRpcNotification)
    }
  })

  proc.on('close', code => {
    // The process that asked can no longer receive an answer.
    for (const controller of openQuestionRequests.values()) controller.abort()
    openQuestionRequests.clear()
    endTurn()
    // Surface the process's stderr tail so a nonzero exit (127 = binary not on
    // the host PATH, etc.) is legible instead of a bare exit code.
    const tail = stderrTail.trim().slice(-300)
    const reason = `codex app-server exited (${code})${tail ? `: ${tail}` : ''}`
    for (const [, p] of pending) p.reject(new Error(reason))
    pending.clear()
    emit({ type: 'closed', bridgeId: opts.bridgeId, code })
  })

  proc.on('error', err => {
    emit({ type: 'error', bridgeId: opts.bridgeId, message: `codex spawn failed: ${err.message}` })
    emit({ type: 'closed', bridgeId: opts.bridgeId, code: null })
  })

  // ── Handshake: initialize → initialized → thread/start ────────────────────
  try {
    await request('initialize', {
      clientInfo: { name: 'crewcode', title: 'CrewCode', version: '0.1.0' },
    })
    notify('initialized', {})

    const modeConfig = getModeConfig(opts.mode, opts.toolPolicy)
    const threadParams: Record<string, unknown> = {
      cwd:            dir,
      approvalPolicy: modeConfig.approvalPolicy,
      sandbox:        modeConfig.sandbox,
    }
    if (opts.model)             threadParams.model  = opts.model
    const effort = mapCodexEffort(opts.thinking)
    if (effort)                 threadParams.effort = effort

    // Prefer thread/resume if the renderer handed us an id from a prior run.
    // Codex persists threads to disk; resume reopens by id and later turn/start
    // calls append to the same history. Fall back to thread/start when resume
    // fails (id stale, app-server forgot it, etc.) so the user still gets a
    // working bridge instead of a fatal startup error.
    let resumed = false
    let thread: { id?: string } | undefined
    if (opts.resumeSessionId) {
      try {
        const res = await request('thread/resume', { ...threadParams, threadId: opts.resumeSessionId })
        thread = res.thread as { id?: string } | undefined
        if (thread?.id) resumed = true
      } catch { /* fall through to fresh thread */ }
    }
    if (!thread?.id) {
      const threadRes = await request('thread/start', threadParams)
      thread = threadRes.thread as { id?: string } | undefined
    }
    if (!thread?.id) throw new Error('thread/start response missing thread.id')
    threadId = thread.id
    emit({ type: 'session_id', bridgeId: opts.bridgeId, sessionId: threadId, resumed })
  } catch (err) {
    const tail = stderrTail.trim().slice(-400)
    emit({ type: 'error', bridgeId: opts.bridgeId, message: `${(err as Error).message}${tail ? `: ${tail}` : ''}` })
    try { proc.kill() } catch { /* ignore */ }
    throw err
  }

  return {
    bridgeId: opts.bridgeId,
    pid: proc.pid ?? null,
    async prompt(text: string) {
      if (!threadId) return { ok: false, error: 'codex thread not initialised' }
      try {
        await request('turn/start', {
          threadId,
          input: [{ type: 'text', text } as JsonValue],
        })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    async compact() {
      if (!threadId) return { ok: false, error: 'codex thread not initialised' }
      try {
        await request(CODEX_COMPACT_METHOD, { threadId })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    async abort() {
      if (!threadId || !currentTurnId) return
      try { await request('turn/interrupt', { threadId, turnId: currentTurnId }) } catch { /* ignore */ }
    },
    async stop() {
      try { proc.stdin.end() } catch { /* ignore */ }
      setTimeout(() => { if (!proc.killed) try { proc.kill() } catch { /* ignore */ } }, 500)
    },
  }
}

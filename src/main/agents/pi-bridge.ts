import { spawnAgentProcess } from './agent-spawn'
import type { AgentBridge, AgentUserResponse, BridgeStartOpts, EmitFn, ModeLevel, PromptOptions, RequestUserFn, TurnUsage } from './bridge-types'
import { buildUsage } from './model-context'
import { enrichUsageContextWindow } from './openrouter-model-context'

// pi RPC mode: JSONL (LF-delimited) on stdin/stdout.
// Spec: https://pi.dev/docs/latest/rpc

interface PiMessageUpdate {
  type: 'message_update'
  message?: {
    role?: string
    content?: Array<{ type?: string; [k: string]: unknown }>
  }
  assistantMessageEvent?: {
    type:  string                          // 'text_delta' | 'thinking_delta' | 'toolcall_start' | ...
    delta?: string
    contentIndex?: number
    toolCallId?: string
    toolName?:   string
    args?:       unknown
    result?:     unknown
    isError?:    boolean
  }
}

interface PiToolStart   { type: 'tool_execution_start';  toolCallId: string; toolName: string; args: unknown }
interface PiToolUpdate  { type: 'tool_execution_update'; toolCallId: string; toolName: string; partialResult: unknown }
interface PiToolEnd     { type: 'tool_execution_end';    toolCallId: string; toolName: string; result: unknown; isError: boolean }
interface PiTurnEvent   { type: 'turn_start' | 'turn_end' | 'agent_start' | 'agent_end' }
interface PiSession     { type: 'session'; id: string }
interface PiResponse    { type: 'response'; command: string; success: boolean; id?: string; error?: string; data?: { sessionId?: string; sessionFile?: string; cancelled?: boolean } }
interface PiAutoRetry   { type: 'auto_retry_start' | 'auto_retry_end'; errorMessage?: string; finalError?: string }
interface PiExtensionUiRequest {
  type: 'extension_ui_request'
  id: string
  method: string
  title?: string
  message?: string
  placeholder?: string
  prefill?: string
  options?: unknown[]
  timeout?: number
  [k: string]: unknown
}

type PiEvent =
  | PiSession | PiResponse | PiTurnEvent | PiMessageUpdate
  | PiToolStart | PiToolUpdate | PiToolEnd | PiAutoRetry | PiExtensionUiRequest
  | { type: string; [k: string]: unknown }

const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'apply_patch', 'bash', 'shell', 'execute', 'run'])

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function usageFromPiEvent(ev: Record<string, unknown>, fallbackModel: string | undefined): TurnUsage | undefined {
  const message = ev.message as Record<string, unknown> | undefined
  const u = (message?.usage ?? ev.usage ?? ev.tokens) as Record<string, unknown> | undefined
  if (!u) return undefined
  const input  = num(u.input)  ?? num(u.inputTokens)  ?? num(u.promptTokens)
  const output = num(u.output) ?? num(u.outputTokens) ?? num(u.completionTokens)
  const model  = (typeof message?.model === 'string' ? message.model : undefined) ?? fallbackModel
  return buildUsage({
    inputTokens:    input,
    outputTokens:   output,
    // totalTokens may be billing/cumulative for some backends; only trust an
    // explicit context field for the ctx-pop live-window gauge.
    contextTokens:  num(u.contextTokens) ?? num(u.context_tokens),
    contextWindow:  num(u.contextWindow) ?? num(u.context_window),
    model,
  })
}

function isWriteToolBlocked(opts: Pick<BridgeStartOpts, 'mode' | 'toolPolicy'>, toolName: string | undefined): boolean {
  if (opts.toolPolicy !== 'read-only' && opts.mode !== 'ask' && opts.mode !== 'plan') return false
  const lower = (toolName ?? '').toLowerCase()
  return WRITE_TOOL_NAMES.has(lower)
    || lower.includes('write')
    || lower.includes('edit')
    || lower.includes('bash')
    || lower.includes('shell')
}

export function userVisiblePiStderr(chunk: string): string {
  // Pi can warn about stale scoped-model patterns while still serving RPC turns.
  // Keep real stderr visible, but don't surface benign model-filter misses as errors.
  return chunk
    .replace(/Warning:\s+No models match pattern\s+"[^"]+"/g, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
}

export async function createPiBridge(
  piPath: string,
  opts: BridgeStartOpts,
  emit: EmitFn,
  requestUser?: RequestUserFn,
): Promise<AgentBridge> {
  // Let pi save sessions to ~/.pi/agent/sessions so we can resume next launch.
  // --session <id> picks up a specific session by partial UUID; pi falls back
  // to creating a new one if the id doesn't match anything on disk.
  const args = ['--mode', 'rpc']
  if (opts.resumeSessionId) args.push('--session', opts.resumeSessionId)
  if (opts.model)           args.push('--model', opts.model)
  if (opts.thinking)        args.push('--thinking', opts.thinking)

  const piEnv: Record<string, string> = { ...(opts.env ?? {}) }
  if (opts.apiKey) piEnv.PI_API_KEY = opts.apiKey

  const { proc } = await spawnAgentProcess({ command: piPath, args, cwd: opts.cwd, env: piEnv })

  let nextReqId = 1
  let currentTurnId: string | null = null
  let buf = ''
  // pi --mode rpc emits no startup/session event, so we learn the session id by
  // sending a `get_state` command and reading its response. Captured once and
  // persisted by main so the next launch can resume via `--session <id>`.
  let capturedSession = false
  let emittedReady = false
  // Usage captured from whichever pi event carries it (turn_end/agent_end), held
  // until the turn flushes so the bubble can show tok/s and context.
  let lastUsage: TurnUsage | undefined

  function startTurn(): string {
    if (!currentTurnId) {
      currentTurnId = `${opts.bridgeId}-t-${Date.now().toString(36)}`
      lastUsage = undefined
      emit({ type: 'turn_start', bridgeId: opts.bridgeId, turnId: currentTurnId })
    }
    return currentTurnId
  }

  async function endTurn() {
    if (currentTurnId) {
      const usage = await enrichUsageContextWindow(lastUsage)
      emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId: currentTurnId, usage })
      currentTurnId = null
      lastUsage = undefined
    }
  }

  // pi reports usage on turn_end under `message.usage`. Keep billing totals
  // separate from the live context gauge so cache/cumulative counts can't make
  // ctx-pop jump past the model window.
  function captureUsage(ev: Record<string, unknown>): void {
    if (process.env.CREWCODE_DEBUG_USAGE) {
      // eslint-disable-next-line no-console
      console.error('[pi usage]', JSON.stringify(ev).slice(0, 600))
    }
    const usage = usageFromPiEvent(ev, opts.model)
    if (usage) lastUsage = usage
  }

  const stringish = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

  function normalizeOption(option: unknown, index: number): { id: string; label: string; description?: string } {
    if (typeof option === 'string') return { id: option, label: option }
    if (option && typeof option === 'object') {
      const row = option as Record<string, unknown>
      const id = stringish(row.id) ?? stringish(row.value) ?? stringish(row.label) ?? String(index)
      return {
        id,
        label: stringish(row.label) ?? stringish(row.title) ?? stringish(row.value) ?? id,
        description: stringish(row.description),
      }
    }
    return { id: String(index), label: String(option) }
  }

  function sendExtensionUiResponse(id: string, response: AgentUserResponse): void {
    if (response.action === 'cancel' || response.action === 'decline') {
      send({ type: 'extension_ui_response', id, cancelled: true, confirmed: false })
      return
    }
    send({
      type: 'extension_ui_response',
      id,
      confirmed: response.action === 'accept',
      value: response.optionId ?? response.value ?? '',
    })
  }

  async function handleExtensionUiRequest(e: PiExtensionUiRequest): Promise<void> {
    if (!requestUser || e.method === 'notify' || e.method === 'setStatus' || e.method === 'setWidget' || e.method === 'setTitle' || e.method === 'set_editor_text') return
    if (e.method === 'confirm') {
      // Full Access turns should not pause on confirmation prompts after a live mode
      // switch; ask/plan remain conservative for confirmation-style gates.
      if (opts.mode === 'full') {
        sendExtensionUiResponse(e.id, { requestId: e.id, action: 'accept' })
        return
      }
      if (opts.mode === 'ask' || opts.mode === 'plan') {
        sendExtensionUiResponse(e.id, { requestId: e.id, action: 'decline' })
        return
      }
      const response = await requestUser({
        kind: 'permission',
        turnId: currentTurnId ?? undefined,
        title: e.title ?? 'confirmation required',
        message: e.message,
        source: 'pi',
      })
      sendExtensionUiResponse(e.id, response)
      return
    }
    if (e.method === 'select') {
      const options = Array.isArray(e.options) ? e.options.map(normalizeOption) : []
      const response = await requestUser({
        kind: 'select',
        turnId: currentTurnId ?? undefined,
        title: e.title ?? 'choose an option',
        options,
        source: 'pi',
      })
      sendExtensionUiResponse(e.id, response)
      return
    }
    if (e.method === 'input' || e.method === 'editor') {
      const response = await requestUser({
        kind: e.method === 'editor' ? 'editor' : 'prompt',
        turnId: currentTurnId ?? undefined,
        title: e.title ?? 'input required',
        placeholder: e.placeholder,
        defaultValue: e.prefill,
        source: 'pi',
      })
      sendExtensionUiResponse(e.id, response)
      return
    }
  }

  // pi accepts a partial UUID for --session and reports the full one back, so a
  // resume is when the captured id starts with what we passed in (or vice versa).
  function captureSession(sid: string | undefined) {
    if (!sid || capturedSession) return
    capturedSession = true
    const resumeId = opts.resumeSessionId ?? ''
    const resumed = !!resumeId && (sid.startsWith(resumeId) || resumeId.startsWith(sid))
    emit({ type: 'session_id', bridgeId: opts.bridgeId, sessionId: sid, resumed })
  }

  function handleEvent(ev: PiEvent) {
    const t = ev.type
    // Legacy path: kept in case a future pi build emits a top-level session event.
    if (t === 'session') { captureSession((ev as PiSession).id); return }
    // pi answers `get_state` with the live session id under `data.sessionId`.
    if (t === 'response' && (ev as PiResponse).command === 'get_state') {
      captureSession((ev as PiResponse).data?.sessionId)
      return
    }
    // The session exists by the first turn, so re-poll if startup raced ahead.
    if (t === 'turn_start') { if (!capturedSession) send({ type: 'get_state' }); startTurn(); return }
    if (t === 'turn_end')   { captureUsage(ev as Record<string, unknown>); void endTurn(); return }
    if (t === 'agent_end')  { captureUsage(ev as Record<string, unknown>); void endTurn(); return }

    if (t === 'message_update') {
      const ev2 = ev as PiMessageUpdate
      const ae  = ev2.assistantMessageEvent
      if (!ae) return
      const turnId = startTurn()
      if (ae.type === 'text_delta' && typeof ae.delta === 'string') {
        const contentType = typeof ae.contentIndex === 'number'
          ? ev2.message?.content?.[ae.contentIndex]?.type
          : undefined
        // Pi's RPC stream includes the current content block type; route text
        // deltas from `thinking` blocks as reasoning so notifications only see
        // actual final assistant text.
        emit({ type: contentType === 'thinking' || contentType === 'reasoning' ? 'thinking_delta' : 'text_delta', bridgeId: opts.bridgeId, turnId, delta: ae.delta })
      } else if (ae.type === 'thinking_delta' && typeof ae.delta === 'string') {
        emit({ type: 'thinking_delta', bridgeId: opts.bridgeId, turnId, delta: ae.delta })
      } else if (ae.type === 'toolcall_start' && ae.toolCallId && ae.toolName) {
        if (isWriteToolBlocked(opts, ae.toolName)) {
          emit({ type: 'error', bridgeId: opts.bridgeId, message: `Tool "${ae.toolName}" is not allowed in ${opts.mode} mode` })
          return
        }
        emit({ type: 'tool_start', bridgeId: opts.bridgeId, turnId, toolCallId: ae.toolCallId, toolName: ae.toolName, args: ae.args })
      } else if (ae.type === 'toolcall_end' && ae.toolCallId) {
        emit({ type: 'tool_end', bridgeId: opts.bridgeId, turnId, toolCallId: ae.toolCallId, result: ae.result, isError: !!ae.isError })
      }
      return
    }

    if (t === 'tool_execution_start') {
      const e = ev as PiToolStart
      if (isWriteToolBlocked(opts, e.toolName)) {
        emit({ type: 'error', bridgeId: opts.bridgeId, message: `Tool "${e.toolName}" is not allowed in ${opts.mode} mode` })
        return
      }
      const turnId = startTurn()
      emit({ type: 'tool_start', bridgeId: opts.bridgeId, turnId, toolCallId: e.toolCallId, toolName: e.toolName, args: e.args })
      return
    }
    if (t === 'tool_execution_update') {
      const e = ev as PiToolUpdate
      const turnId = startTurn()
      emit({ type: 'tool_update', bridgeId: opts.bridgeId, turnId, toolCallId: e.toolCallId, partial: e.partialResult })
      return
    }
    if (t === 'tool_execution_end') {
      const e = ev as PiToolEnd
      const turnId = startTurn()
      emit({ type: 'tool_end', bridgeId: opts.bridgeId, turnId, toolCallId: e.toolCallId, result: e.result, isError: e.isError })
      return
    }

    if (t === 'extension_ui_request') {
      void handleExtensionUiRequest(ev as PiExtensionUiRequest)
      return
    }

    if (t === 'response') {
      const e = ev as PiResponse
      if (!e.success && e.error) {
        emit({ type: 'error', bridgeId: opts.bridgeId, message: `${e.command}: ${e.error}` })
      }
      return
    }

    if (t === 'auto_retry_end') {
      const e = ev as PiAutoRetry
      if (e.finalError) emit({ type: 'error', bridgeId: opts.bridgeId, message: e.finalError })
      return
    }
  }

  function consume(chunk: string) {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        handleEvent(JSON.parse(line) as PiEvent)
      } catch (err) {
        emit({ type: 'error', bridgeId: opts.bridgeId, message: `pi: bad json: ${(err as Error).message}` })
      }
    }
  }

  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', consume)

  // pi emits no startup event, so signal readiness ourselves and immediately
  // ask for the session id (resume relies on persisting it; see captureSession).
  if (!emittedReady) {
    emittedReady = true
    emit({ type: 'ready', bridgeId: opts.bridgeId })
    send({ type: 'get_state' })
  }

  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    const visible = userVisiblePiStderr(chunk)
    if (visible) emit({ type: 'error', bridgeId: opts.bridgeId, message: `pi stderr: ${visible}` })
  })

  proc.on('close', code => {
    endTurn()
    emit({ type: 'closed', bridgeId: opts.bridgeId, code })
  })

  proc.on('error', err => {
    emit({ type: 'error', bridgeId: opts.bridgeId, message: `pi spawn failed: ${err.message}` })
    emit({ type: 'closed', bridgeId: opts.bridgeId, code: null })
  })

  function send(obj: Record<string, unknown>): boolean {
    if (proc.stdin.destroyed || !proc.stdin.writable) return false
    proc.stdin.write(JSON.stringify(obj) + '\n')
    return true
  }

  return {
    bridgeId: opts.bridgeId,
    pid: proc.pid ?? null,
    async prompt(text: string, options?: PromptOptions) {
      const id = `req-${nextReqId++}`
      // CrewCode has one follow-up action: inject into the running turn at the
      // next safe point. That maps to pi's 'steer' (delivered between tool calls,
      // before the next LLM call) — NOT pi's 'followUp', which waits until the
      // agent fully stops. A normal prompt sends no behavior and runs as usual.
      const piBehavior = options?.streamingBehavior === 'followUp' ? 'steer' : undefined
      const ok = send({ type: 'prompt', message: text, id, streamingBehavior: piBehavior })
      if (!ok) return { ok: false, error: 'pi process not writable' }
      return { ok: true }
    },
    async abort() {
      send({ type: 'abort' })
    },
    async stop() {
      try { send({ type: 'abort' }) } catch { /* ignore */ }
      proc.stdin.end()
      // Give pi a moment to exit cleanly, then kill if needed
      setTimeout(() => { if (!proc.killed) try { proc.kill() } catch { /* ignore */ } }, 500)
    },
  }
}

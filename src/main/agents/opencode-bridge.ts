import { spawnAgentProcess } from './agent-spawn'
import { isRemoteRoot, parseRemoteTarget } from '../remote/ssh-target'
import { forwardRemotePort } from '../remote/ssh-pool'
import type { ForwardHandle } from '../remote/ssh-pool'
import type { AgentBridge, AgentUserRequest, AgentUserResponse, BridgeStartOpts, EmitFn, ModeLevel, RequestUserFn, TurnUsage } from './bridge-types'
import { buildUsage } from './model-context'
import { enrichUsageContextWindow } from './openrouter-model-context'

// opencode HTTP+SSE bridge.
// Server: `opencode serve --port <p>`. Endpoints:
//   GET  /global/health          → { healthy }
//   GET  /event                  → SSE stream of EventMessage* / session.* events
//   POST /session                → create new session, returns { id }
//   POST /session/:id/message    → submit a prompt
//   POST /session/:id/abort      → abort running session
//
// Event mapping (from opencode types.gen.ts):
//   message.part.updated  { part, delta? }
//     part.type='text'      + delta            → text_delta
//     part.type='reasoning' + delta            → thinking_delta
//     part.type='tool'      state.status=...   → tool_start/update/end
//   session.idle                                → turn_end

interface OpencodePart {
  id?:    string
  type:   'text' | 'reasoning' | 'tool' | 'file' | string
  text?:  string
  tool?:  string
  callID?: string
  state?: {
    status: 'pending' | 'running' | 'completed' | 'error'
    input?: unknown
    output?: string
    error?:  string
    title?:  string
    metadata?: Record<string, unknown>
  }
}

interface SseEvent {
  type:       string
  properties: Record<string, unknown>
}

interface OpencodeQuestionOption {
  label?: string
  description?: string
}

interface OpencodeQuestionInfo {
  question?: string
  header?: string
  options?: OpencodeQuestionOption[]
  multiple?: boolean
  custom?: boolean
}

interface OpencodeQuestionRequest {
  id?: string
  sessionID?: string
  questions?: OpencodeQuestionInfo[]
}

type AgentRequestOption = { id: string; label: string; description?: string }

interface PreparedOpencodeQuestion {
  request: Omit<AgentUserRequest, 'requestId' | 'bridgeId'>
  optionsById: Record<string, { label: string; description?: string }>
  multiple: boolean
}

const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'apply_patch', 'bash', 'shell', 'execute', 'run', 'file_write', 'file_edit'])

export function isWriteToolBlocked(opts: Pick<BridgeStartOpts, 'mode' | 'toolPolicy'>, toolName: string | undefined): boolean {
  if (opts.toolPolicy !== 'read-only' && opts.mode !== 'ask' && opts.mode !== 'plan') return false
  const lower = (toolName ?? '').toLowerCase()
  return WRITE_TOOL_NAMES.has(lower)
    || lower.includes('write')
    || lower.includes('edit')
    || lower.includes('bash')
}

function getModePreamble(mode?: ModeLevel): string | null {
  switch (mode) {
    case 'ask':   return 'You are in Ask mode. Answer questions using read-only tools only. Never write, edit, or execute commands.'
    case 'plan':  return 'You are in Plan mode. Collaborate on the plan before implementation. Ask 1-3 focused clarifying questions when the goal, constraints, UX, or acceptance criteria are unclear; if clear, state assumptions briefly then produce a structured implementation plan. Write plans in clear Markdown with headings, bullets, checklists, and file paths or commands in backticks. Do not write code or modify files. Use read-only tools for discovery.'
    case 'build': return null
    case 'full':  return 'You are in Full Access mode. Every tool is pre-approved. Move fast, minimize narration, and use all tools directly without ever asking for permission.'
    default:      return null
  }
}

export function buildOpencodePromptBody(text: string, mode?: ModeLevel, modelValue?: string, effort?: BridgeStartOpts['thinking']) {
  const model = typeof modelValue === 'string' ? parseOpencodeModel(modelValue) : null
  const modePreamble = getModePreamble(mode)
  const promptText = modePreamble ? `<system>\n${modePreamble}\n</system>\n\n${text}` : text
  return {
    // opencode prompt_async accepts user-message parts; keep CrewCode mode
    // instructions inside the text part instead of sending a rejected system part.
    parts: [{ type: 'text' as const, text: promptText }],
    ...(model ? { model } : {}),
    // OpenCode calls model-specific reasoning presets "variants".
    ...(effort && effort !== 'off' ? { variant: effort } : {}),
  }
}

export function usageFromOpencodeMessageInfo(info: {
  modelID?: string
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
} | undefined, fallbackModel: string | undefined): TurnUsage | undefined {
  if (!info?.tokens) return undefined
  const t = info.tokens
  const input = typeof t.input === 'number' && Number.isFinite(t.input) ? t.input : undefined
  const outputRaw = typeof t.output === 'number' && Number.isFinite(t.output) ? t.output : undefined
  const reasoning = typeof t.reasoning === 'number' && Number.isFinite(t.reasoning) ? t.reasoning : 0
  const outputTokens = outputRaw === undefined ? (reasoning || undefined) : outputRaw + reasoning
  const contextTokens = input === undefined ? undefined : input + (outputRaw ?? 0)
  return buildUsage({
    inputTokens:   input,
    outputTokens,
    // Cache reads are billing/cache-hit accounting, not live prompt size.
    contextTokens,
    model:         info.modelID ?? fallbackModel,
  })
}

async function pickFreePort(): Promise<number> {
  const net = await import('net')
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(); reject(new Error('failed to pick port'))
      }
    })
  })
}

async function waitForHealth(baseUrl: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${baseUrl}/global/health`, { method: 'GET' })
      if (r.ok) return
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error('opencode server health check timed out')
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function splitTypedAnswers(value: string | undefined, multiple: boolean): string[] {
  const text = value?.trim() ?? ''
  if (!text) return []
  if (!multiple) return [text]
  return text
    .split(/\r?\n|,/)
    .map(part => part.trim())
    .filter(Boolean)
}

function normalizeQuestionOptions(options: OpencodeQuestionOption[] | undefined): AgentRequestOption[] {
  const seen = new Set<string>()
  const normalized: AgentRequestOption[] = []
  for (const [index, option] of (Array.isArray(options) ? options : []).entries()) {
    const label = stringValue(option?.label)?.trim()
    if (!label) continue
    const baseId = label || String(index + 1)
    const id = seen.has(baseId) ? `${baseId}-${index + 1}` : baseId
    seen.add(id)
    normalized.push({ id, label, ...(stringValue(option.description) ? { description: stringValue(option.description) } : {}) })
  }
  return normalized
}

export function prepareOpencodeQuestionRequest(question: OpencodeQuestionInfo, index = 0, total = 1): PreparedOpencodeQuestion | null {
  const title = stringValue(question.question)?.trim()
  if (!title) return null

  const options = normalizeQuestionOptions(question.options)
  const optionsById = Object.fromEntries(options.map(option => [option.id, { label: option.label, description: option.description }]))
  const multiple = question.multiple === true
  const allowsCustom = question.custom !== false
  const header = stringValue(question.header)?.trim()
  const notes = [
    header ? `OpenCode asks: ${header}` : undefined,
    total > 1 ? `Question ${index + 1} of ${total}.` : undefined,
    multiple ? 'Select all that apply. Type multiple answers separated by commas or new lines.' : undefined,
  ].filter(Boolean).join(' ')

  const detail = multiple && options.length > 0
    ? options.map(option => `- ${option.label}${option.description ? ` — ${option.description}` : ''}`).join('\n')
    : undefined

  return {
    request: {
      kind: multiple ? 'editor' : allowsCustom || options.length === 0 ? 'prompt' : 'select',
      title,
      message: notes || undefined,
      detail,
      options: multiple ? undefined : options,
      placeholder: allowsCustom ? 'reply to OpenCode…' : undefined,
      source: 'opencode',
    },
    optionsById,
    multiple,
  }
}

export function answerOpencodeQuestion(prepared: PreparedOpencodeQuestion, response: AgentUserResponse): string[] {
  const selected = response.optionId ? prepared.optionsById[response.optionId] : undefined
  return selected ? [selected.label] : splitTypedAnswers(response.value ?? response.optionId, prepared.multiple)
}

function errorLikeToMessage(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const maybeMessage = (value as { message?: unknown }).message
    if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) return maybeMessage
  }
  if (typeof value === 'string' && value.trim().length > 0) return value
  if (typeof value === 'object' && value !== null) {
    try {
      const json = JSON.stringify(value)
      if (typeof json === 'string' && json.trim().length > 0 && json !== '{}') return json
    } catch { /* ignore */ }
  }
  const str = String(value)
  return str.trim().length > 0 && str !== '[object Object]' ? str : 'session error'
}

function parseOpencodeModel(model: string): { providerID: string, modelID: string } | null {
  const cleaned = model.trim().replace(/^\/+/, '')
  if (!cleaned) return null
  const slashIndex = cleaned.indexOf('/')
  if (slashIndex === -1) {
    // OpenCode's message API expects a provider/model pair. An empty providerID
    // can be accepted by prompt_async but then produce no assistant stream.
    // Treat unqualified values as "use server default" instead of sending a bad model object.
    return null
  }
  return {
    providerID: cleaned.slice(0, slashIndex),
    modelID: cleaned.slice(slashIndex + 1),
  }
}

export async function createOpencodeBridge(
  opencodePath: string,
  opts: BridgeStartOpts,
  emit: EmitFn,
  requestUser?: RequestUserFn,
): Promise<AgentBridge> {
  // Remote workspaces run `opencode serve` on the host; we pick a host port and
  // SSH-forward it to a local port so the HTTP/SSE client below stays transport-
  // agnostic. Locally we just pick a free local port and spawn directly.
  const remote = isRemoteRoot(opts.cwd)
  const serverPort = remote ? 40000 + Math.floor(Math.random() * 20000) : await pickFreePort()

  const { proc } = await spawnAgentProcess({
    command: opencodePath,
    args:    ['serve', '--port', String(serverPort), '--hostname', '127.0.0.1'],
    cwd:     opts.cwd,
    env:     { ...(opts.env ?? {}) },
  })

  let forward: ForwardHandle | null = null
  let baseUrl = `http://127.0.0.1:${serverPort}`
  if (remote) {
    const target = parseRemoteTarget(opts.cwd)
    if (!target) throw new Error(`invalid remote workspace: ${opts.cwd}`)
    forward = await forwardRemotePort(target, serverPort)
    baseUrl = `http://127.0.0.1:${forward.localPort}`
  }

  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  let stderrTail = ''
  proc.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000)
  })

  proc.on('close', code => {
    failPendingPrompt(`opencode exited (${code ?? 'unknown'})`)
    emit({ type: 'closed', bridgeId: opts.bridgeId, code })
  })
  proc.on('error', err => {
    failPendingPrompt(`opencode spawn failed: ${err.message}`)
    emit({ type: 'error', bridgeId: opts.bridgeId, message: `opencode spawn failed: ${err.message}` })
    emit({ type: 'closed', bridgeId: opts.bridgeId, code: null })
  })

  try {
    // Remote startup is slower — the host has to launch the server and the first
    // health probe travels back through the SSH tunnel.
    await waitForHealth(baseUrl, remote ? 20000 : 8000)
  } catch (err) {
    emit({ type: 'error', bridgeId: opts.bridgeId, message: `${(err as Error).message}: ${stderrTail.slice(-400)}` })
    forward?.close()
    try { proc.kill() } catch { /* ignore */ }
    throw err
  }

  // Resume the previous session if the renderer handed us an id and the
  // opencode server still has it (GET /session/:id 200). Otherwise create a
  // fresh one so a stale id doesn't kill the bridge.
  let sessionId = ''
  let resumed = false
  if (opts.resumeSessionId) {
    try {
      const r = await fetch(`${baseUrl}/session/${opts.resumeSessionId}`)
      if (r.ok) {
        sessionId = opts.resumeSessionId
        resumed = true
      }
    } catch { /* fall through to create */ }
  }
  if (!sessionId) {
    try {
      // MCP wiring seam: opencode's `POST /session` takes no per-session MCP
      // field — opencode resolves MCP servers from its own `opencode.json`
      // config, not over this HTTP surface. So `opts.mcpServers` can't be
      // attached here. TODO: support session-scoped MCP for opencode by writing
      // a workspace `opencode.json` (or `--config`) before `serve`, or once the
      // server API exposes a session-level field.
      const r = await fetch(`${baseUrl}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      if (!r.ok) throw new Error(`POST /session ${r.status}`)
      const json = await r.json() as { id?: string }
      sessionId = json.id ?? ''
      if (!sessionId) throw new Error('session id missing in response')
    } catch (err) {
      emit({ type: 'error', bridgeId: opts.bridgeId, message: `opencode session create failed: ${(err as Error).message}` })
      forward?.close()
      try { proc.kill() } catch { /* ignore */ }
      throw err
    }
  }
  emit({ type: 'session_id', bridgeId: opts.bridgeId, sessionId, resumed })

  // SSE consumer state
  let currentTurnId: string | null = null
  // Track per-text-part accumulated length so we only emit deltas
  const textBuf:     Record<string, string> = {}
  const reasonBuf:   Record<string, string> = {}
  const toolStatus:  Record<string, 'pending' | 'running' | 'completed' | 'error'> = {}
  // opencode 1.4+ streams text via `message.part.delta` carrying only a partID.
  // We need partID → part type and messageID → role to route those deltas to
  // text_delta vs thinking_delta, and to ignore the user-message echo opencode
  // replays on the SSE stream before the assistant response starts.
  const partType:    Record<string, string> = {}  // partID → 'text'|'reasoning'|'tool'|...
  const partMsg:     Record<string, string> = {}  // partID → messageID
  const msgRole:     Record<string, string> = {}  // messageID → 'user'|'assistant'

  // Latest token usage seen on an assistant message this turn. opencode reports
  // it on `message.updated` info, so we stash it and flush on session.idle.
  let lastUsage: TurnUsage | undefined
  const pendingQuestionRequests = new Set<string>()
  let pendingPrompt: { resolve: (result: { ok: boolean; error?: string }) => void } | null = null

  function settlePendingPrompt(result: { ok: boolean; error?: string }): void {
    if (!pendingPrompt) return
    const { resolve } = pendingPrompt
    pendingPrompt = null
    resolve(result)
  }

  function failPendingPrompt(message: string): void {
    settlePendingPrompt({ ok: false, error: message })
  }

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
      settlePendingPrompt({ ok: true })
    }
  }

  // OpenCode questions are SSE-only pauses; reply over the web-client endpoints
  // so the same turn resumes after CrewCode's shared request card is answered.
  async function postQuestionReply(requestId: string, answers: string[][]): Promise<void> {
    const r = await fetch(`${baseUrl}/question/${encodeURIComponent(requestId)}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers }),
    })
    if (!r.ok) throw new Error(`POST /question/${requestId}/reply ${r.status}`)
  }

  async function postQuestionReject(requestId: string): Promise<void> {
    const r = await fetch(`${baseUrl}/question/${encodeURIComponent(requestId)}/reject`, { method: 'POST' })
    if (!r.ok) throw new Error(`POST /question/${requestId}/reject ${r.status}`)
  }

  function opencodeQuestionFromValue(value: unknown): OpencodeQuestionInfo[] {
    if (!value || typeof value !== 'object') return []
    const rec = value as Record<string, unknown>
    return Array.isArray(rec.questions) ? rec.questions as OpencodeQuestionInfo[] : []
  }

  async function handleQuestionAsked(props: OpencodeQuestionRequest): Promise<void> {
    const requestId = props.id
    if (!requestId || pendingQuestionRequests.has(requestId)) return
    if (props.sessionID && props.sessionID !== sessionId) return
    const questions = Array.isArray(props.questions) ? props.questions : []
    if (!requestUser || questions.length === 0) {
      try { await postQuestionReject(requestId) } catch { /* ignore */ }
      return
    }

    pendingQuestionRequests.add(requestId)
    try {
      const turnId = currentTurnId ?? startTurn()
      const answers: string[][] = []
      for (let index = 0; index < questions.length; index++) {
        const prepared = prepareOpencodeQuestionRequest(questions[index], index, questions.length)
        if (!prepared) {
          answers.push([])
          continue
        }
        const response = await requestUser({ ...prepared.request, turnId })
        if (response.action === 'cancel' || response.action === 'decline') {
          await postQuestionReject(requestId)
          return
        }
        answers.push(answerOpencodeQuestion(prepared, response))
      }
      await postQuestionReply(requestId, answers)
    } catch (err) {
      emit({ type: 'error', bridgeId: opts.bridgeId, message: `opencode question failed: ${(err as Error).message}` })
    } finally {
      pendingQuestionRequests.delete(requestId)
    }
  }

  function handlePartDelta(props: Record<string, unknown>) {
    const partID    = typeof props.partID    === 'string' ? props.partID    : ''
    const messageID = typeof props.messageID === 'string' ? props.messageID : ''
    const field     = typeof props.field     === 'string' ? props.field     : ''
    const delta     = typeof props.delta     === 'string' ? props.delta     : ''
    if (!partID || !delta) return

    // Skip user-message echoes — only stream assistant content.
    const role = messageID ? msgRole[messageID] : undefined
    if (role && role !== 'assistant') return

    const type = partType[partID]
    if (type === 'text' && field === 'text') {
      const turnId = startTurn()
      textBuf[partID] = (textBuf[partID] ?? '') + delta
      emit({ type: 'text_delta', bridgeId: opts.bridgeId, turnId, delta })
      return
    }
    if (type === 'reasoning' && field === 'text') {
      const turnId = startTurn()
      reasonBuf[partID] = (reasonBuf[partID] ?? '') + delta
      emit({ type: 'thinking_delta', bridgeId: opts.bridgeId, turnId, delta })
      return
    }
  }

  function handlePartUpdated(part: OpencodePart, delta: string | undefined) {
    // Record part identity so message.part.delta events can route correctly.
    const pid = part.id ?? part.callID
    if (pid) {
      partType[pid] = part.type
      // messageID lives on the part in 1.4+ — pull it via a permissive cast.
      const mid = (part as unknown as { messageID?: string }).messageID
      if (typeof mid === 'string') partMsg[pid] = mid
    }
    // For text/reasoning parts on an assistant message, snapshots aren't useful
    // because message.part.delta carries the streaming text. Bail out early to
    // avoid double-emitting on the snapshot that lands after the deltas.
    if (part.type === 'text' || part.type === 'reasoning') {
      const mid = pid ? partMsg[pid] : undefined
      const role = mid ? msgRole[mid] : undefined
      if (role && role !== 'assistant') return
      // Only fall back to snapshot-based delta emission for older opencode
      // versions that don't send message.part.delta at all. We detect that
      // by the snapshot carrying a `delta` argument (legacy path).
      if (delta === undefined) return
    }

    const partId = part.id ?? part.callID ?? part.type

    if (part.type === 'tool') {
      const turnId = startTurn()
      const toolCallId = part.callID ?? partId
      const toolName   = part.tool ?? 'tool'
      if (toolName.toLowerCase() === 'question') {
        const questions = opencodeQuestionFromValue(part.state?.input)
        if (questions.length > 0) {
          void handleQuestionAsked({ id: toolCallId, sessionID: sessionId, questions })
          return
        }
      }
      if (isWriteToolBlocked(opts, toolName)) {
        emit({ type: 'error', bridgeId: opts.bridgeId, message: `Tool "${toolName.toLowerCase()}" is not allowed in ${opts.mode} mode` })
        return
      }
      const status     = part.state?.status
      const prevStatus = toolStatus[toolCallId]
      if (!status) return
      toolStatus[toolCallId] = status
      if (status === 'pending' || status === 'running') {
        if (!prevStatus) {
          emit({ type: 'tool_start', bridgeId: opts.bridgeId, turnId, toolCallId, toolName, args: part.state?.input })
        } else {
          // Opencode streams `state.input` / `state.title` after `tool_start`,
          // so re-send them on every update so the row can re-render with the
          // actual command / filename instead of the empty initial `{}`.
          emit({
            type:    'tool_update',
            bridgeId: opts.bridgeId,
            turnId,
            toolCallId,
            partial: part.state?.metadata,
            args:    part.state?.input,
            title:   part.state?.title,
          })
        }
      } else if (status === 'completed') {
        // Some opencode versions only surface a tool part once it has already
        // completed. Emit a synthetic start first so the renderer has a row to
        // update instead of dropping the tool_end on the floor.
        if (!prevStatus) emit({ type: 'tool_start', bridgeId: opts.bridgeId, turnId, toolCallId, toolName, args: part.state?.input })
        emit({
          type:    'tool_end',
          bridgeId: opts.bridgeId,
          turnId,
          toolCallId,
          result:  part.state?.output ?? '',
          isError: false,
          args:    part.state?.input,
          title:   part.state?.title,
        })
      } else if (status === 'error') {
        if (!prevStatus) emit({ type: 'tool_start', bridgeId: opts.bridgeId, turnId, toolCallId, toolName, args: part.state?.input })
        emit({
          type:    'tool_end',
          bridgeId: opts.bridgeId,
          turnId,
          toolCallId,
          result:  part.state?.error ?? 'error',
          isError: true,
          args:    part.state?.input,
          title:   part.state?.title,
        })
      }
      return
    }

    // Guard: don't start a turn from a no-delta text/reasoning snapshot (e.g.
    // user message echo that opencode replays before the assistant response).
    if (!currentTurnId && (delta === undefined || delta.length === 0)) return

    const turnId = startTurn()

    if (part.type === 'text') {
      const prev = textBuf[partId] ?? ''
      if (typeof delta === 'string' && delta.length > 0) {
        const nextText = typeof part.text === 'string' ? part.text : prev + delta
        if (nextText.length > prev.length && nextText.startsWith(prev)) {
          const suffix = nextText.slice(prev.length)
          textBuf[partId] = nextText
          if (suffix.length > 0) emit({ type: 'text_delta', bridgeId: opts.bridgeId, turnId, delta: suffix })
        } else if (part.text === undefined) {
          textBuf[partId] = prev + delta
          emit({ type: 'text_delta', bridgeId: opts.bridgeId, turnId, delta })
        }
      } else if (typeof part.text === 'string' && part.text.length > prev.length && part.text.startsWith(prev)) {
        const suffix = part.text.slice(prev.length)
        textBuf[partId] = part.text
        if (suffix.length > 0) emit({ type: 'text_delta', bridgeId: opts.bridgeId, turnId, delta: suffix })
      }
      return
    }

    if (part.type === 'reasoning') {
      const prev = reasonBuf[partId] ?? ''
      if (typeof delta === 'string' && delta.length > 0) {
        const nextText = typeof part.text === 'string' ? part.text : prev + delta
        if (nextText.length > prev.length && nextText.startsWith(prev)) {
          const suffix = nextText.slice(prev.length)
          reasonBuf[partId] = nextText
          if (suffix.length > 0) emit({ type: 'thinking_delta', bridgeId: opts.bridgeId, turnId, delta: suffix })
        } else if (part.text === undefined) {
          reasonBuf[partId] = prev + delta
          emit({ type: 'thinking_delta', bridgeId: opts.bridgeId, turnId, delta })
        }
      } else if (typeof part.text === 'string' && part.text.length > prev.length && part.text.startsWith(prev)) {
        const suffix = part.text.slice(prev.length)
        reasonBuf[partId] = part.text
        if (suffix.length > 0) emit({ type: 'thinking_delta', bridgeId: opts.bridgeId, turnId, delta: suffix })
      }
      return
    }

  }

  function handleSseEvent(ev: SseEvent) {
    if (process.env.CREWCODE_DEBUG_OPENCODE) {
      // eslint-disable-next-line no-console
      console.log('[opencode SSE]', ev.type, JSON.stringify(ev.properties ?? {}).slice(0, 300))
    }
    switch (ev.type) {
      case 'server.connected':
        emit({ type: 'ready', bridgeId: opts.bridgeId })
        return
      case 'message.updated': {
        // Capture role so we can ignore the user-message echo opencode replays.
        const info = ev.properties.info as {
          id?: string
          role?: string
          modelID?: string
          tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
        } | undefined
        if (info?.id && typeof info.role === 'string') msgRole[info.id] = info.role
        // Assistant usage includes cache-hit billing fields. Do not add those
        // to ctx-pop's live context gauge or long cached prompts look overfull.
        if (info?.role === 'assistant' && info.tokens) {
          const usage = usageFromOpencodeMessageInfo(info, opts.model)
          if (usage) {
            lastUsage = usage
            if (currentTurnId) emit({ type: 'usage_update', bridgeId: opts.bridgeId, turnId: currentTurnId, usage })
          }
        }
        return
      }
      case 'message.part.updated': {
        const part  = ev.properties.part as OpencodePart | undefined
        const delta = ev.properties.delta as string | undefined
        if (part) handlePartUpdated(part, delta)
        return
      }
      case 'message.part.delta': {
        handlePartDelta(ev.properties)
        return
      }
      case 'session.idle':
        void endTurn()
        return
      case 'question.asked':
        void handleQuestionAsked(ev.properties as OpencodeQuestionRequest)
        return
      case 'question.replied':
      case 'question.rejected': {
        const requestId = stringValue(ev.properties.requestID)
        if (requestId) pendingQuestionRequests.delete(requestId)
        return
      }
      case 'session.error': {
        const msg = errorLikeToMessage(ev.properties.error)
        const genericMessages = new Set(['session error', 'error', 'unknown error', 'undefined', 'null'])
        const stderrContext = stderrTail.trim().slice(-400)
        const message = genericMessages.has(msg.trim().toLowerCase()) && stderrContext
          ? `${msg}: ${stderrContext}`
          : msg
        emit({ type: 'error', bridgeId: opts.bridgeId, message })
        failPendingPrompt(message)
        return
      }
    }
  }

  // SSE connection — use fetch + ReadableStream parser
  const abortCtrl = new AbortController()
  ;(async () => {
    try {
      const r = await fetch(`${baseUrl}/event`, { method: 'GET', signal: abortCtrl.signal })
      if (!r.body) throw new Error('no SSE body')
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const dataLines = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
          if (dataLines.length === 0) continue
          const rawData = dataLines.join('\n')
          try {
            const obj = JSON.parse(rawData) as SseEvent
            handleSseEvent(obj)
          } catch (err) {
            const snippet = rawData.slice(0, 200)
            const reason = err instanceof Error ? err.message : String(err)
            emit({
              type: 'error',
              bridgeId: opts.bridgeId,
              message: `opencode SSE JSON parse failed: ${reason}; data=${JSON.stringify(snippet)}`,
            })
          }
        }
      }
    } catch (err) {
      if (!abortCtrl.signal.aborted) {
        emit({ type: 'error', bridgeId: opts.bridgeId, message: `opencode SSE: ${(err as Error).message}` })
      }
    }
  })()

  return {
    bridgeId: opts.bridgeId,
    pid: proc.pid ?? null,
    async prompt(text: string) {
      if (pendingPrompt) return { ok: false, error: 'opencode turn already running' }
      try {
        const body = buildOpencodePromptBody(text, opts.mode, opts.model, opts.thinking)
        // Use prompt_async so opencode streams parts over SSE instead of holding
        // the HTTP call open and returning the whole message at the end. The
        // synchronous /message endpoint doesn't emit message.part.updated deltas
        // to the event bus, which is why text never lands in the chat.
        const r = await fetch(`${baseUrl}/session/${sessionId}/prompt_async`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (process.env.CREWCODE_DEBUG_OPENCODE) {
          // eslint-disable-next-line no-console
          console.log('[opencode POST]', `prompt_async -> ${r.status}`, 'body=', JSON.stringify(body).slice(0, 300))
        }
        if (!r.ok && r.status !== 204) {
          const errBody = await r.text().catch(() => '')
          return { ok: false, error: `POST /session/${sessionId}/prompt_async ${r.status}: ${errBody.slice(0, 200)}` }
        }
        const turnId = startTurn()
        emit({ type: 'status', bridgeId: opts.bridgeId, message: 'OpenCode accepted prompt; waiting for response…', phase: 'starting' })
        return await new Promise<{ ok: boolean; error?: string }>(resolve => {
          pendingPrompt = { resolve }
          // If OpenCode already emitted and ended the turn synchronously somehow,
          // endTurn would have cleared currentTurnId before this assignment.
          if (!currentTurnId || currentTurnId !== turnId) settlePendingPrompt({ ok: true })
        })
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    async compact() {
      // opencode compacts server-side via /summarize; it runs as a normal turn
      // and emits session.idle (→ turn_end), which drives the completion notice.
      try {
        const parsed = parseOpencodeModel(opts.model ?? '')
        const r = await fetch(`${baseUrl}/session/${sessionId}/summarize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(parsed ? { providerID: parsed.providerID, modelID: parsed.modelID } : {}),
        })
        if (!r.ok && r.status !== 204) {
          const errBody = await r.text().catch(() => '')
          return { ok: false, error: `POST /session/${sessionId}/summarize ${r.status}: ${errBody.slice(0, 200)}` }
        }
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    async abort() {
      try { await fetch(`${baseUrl}/session/${sessionId}/abort`, { method: 'POST' }) } catch { /* ignore */ }
    },
    async stop() {
      abortCtrl.abort()
      forward?.close()
      try { proc.kill() } catch { /* ignore */ }
    },
  }
}

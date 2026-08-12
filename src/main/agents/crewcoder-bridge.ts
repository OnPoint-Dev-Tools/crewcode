import { promises as fsp } from 'fs'
import { isAbsolute, posix, resolve as pathResolve } from 'path'
import { remoteReadFile, remoteWriteFile } from '../remote/remote-fs'
import { spawnAgentProcess } from './agent-spawn'
import type {
  AgentBridge,
  AgentUserResponse,
  BridgeEvent,
  BridgeStartOpts,
  EmitFn,
  RequestUserFn,
  TurnUsage,
} from './bridge-types'
import { buildUsage } from './model-context'
import { enrichUsageContextWindow } from './openrouter-model-context'
import { tripwireForToolCall } from './dangerous-command'

// CrewCoder is an ACP agent. CrewCode is the client: it spawns `crewcoder acp`
// and maps the newline-delimited JSON-RPC stream onto the shared BridgeEvent API.

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

export interface CrewCoderSessionUpdate {
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

interface AcpSessionUpdateParams {
  sessionId: string
  update: CrewCoderSessionUpdate
}

export function crewCoderAcpErrorMessage(error: NonNullable<AcpResponse['error']>): string {
  if (error.data && typeof error.data === 'object' && !Array.isArray(error.data)) {
    const detail = (error.data as Record<string, unknown>).message
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
  }
  return error.message
}

interface PendingRequest {
  resolve: (response: AcpResponse) => void
  reject: (error: Error) => void
  stopTimeout: () => void
  timedOut: boolean
}

type RequestTimeoutOptions = {
  activityBased?: boolean
  cancelOnTimeout?: () => void
  cancellationGraceMs?: number
  onCancellationGraceExpired?: () => void
}

export const CREWCODER_PROMPT_INACTIVITY_TIMEOUT_MS = 10 * 60_000
const CREWCODER_PROMPT_CANCELLATION_GRACE_MS = 10_000

export class InactivityWatchdog {
  private readonly timeoutMs: number
  private readonly onTimeout: () => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private paused = false
  private stopped = false

  constructor(timeoutMs: number, onTimeout: () => void) {
    this.timeoutMs = timeoutMs
    this.onTimeout = onTimeout
    this.arm()
  }

  activity(): void {
    if (this.paused || this.stopped) return
    this.arm()
  }

  pause(): void {
    if (this.stopped || this.paused) return
    this.paused = true
    this.clearTimer()
  }

  resume(): void {
    if (this.stopped || !this.paused) return
    this.paused = false
    this.arm()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.clearTimer()
  }

  private arm(): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.paused || this.stopped) return
      this.stopped = true
      this.onTimeout()
    }, this.timeoutMs)
  }

  private clearTimer(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}

export interface CrewCoderToolProjectionState {
  announced: Set<string>
  settled: Set<string>
  argsById: Map<string, unknown>
  titleById: Map<string, string>
  nameById: Map<string, string>
}

export function createCrewCoderToolProjectionState(): CrewCoderToolProjectionState {
  return {
    announced: new Set(),
    settled: new Set(),
    argsById: new Map(),
    titleById: new Map(),
    nameById: new Map(),
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function contentText(content: CrewCoderSessionUpdate['content']): string {
  if (!content || Array.isArray(content)) return ''
  return typeof content.text === 'string' ? content.text : ''
}

function toolContent(content: CrewCoderSessionUpdate['content']): unknown {
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

function toolName(update: CrewCoderSessionUpdate): string {
  return update.kind ?? update.name ?? update.title ?? 'other'
}

/** Pure ACP update projection used by the live bridge and focused regression tests. */
export function crewCoderEventsFromUpdate(
  update: CrewCoderSessionUpdate,
  bridgeId: string,
  turnId: string,
  tools: CrewCoderToolProjectionState,
): BridgeEvent[] {
  const kind = update.sessionUpdate
  if (kind === 'user_message_chunk') return []
  if (kind === '_crewcoder/compaction_update') {
    const status = update.status
    if (status !== 'started' && status !== 'completed' && status !== 'failed') return []
    const message = typeof update.message === 'string' ? update.message : undefined
    const percent = finiteNumber(update.percent)
    const automatic = typeof update.automatic === 'boolean' ? update.automatic : true
    return [{
      type: 'compaction_event',
      bridgeId,
      turnId,
      status,
      automatic,
      message,
      percent,
      provider: 'crewcoder',
      ...(status === 'completed' ? { resetContext: true } : {}),
    }]
  }
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    const delta = contentText(update.content)
    if (!delta) return []
    return [kind === 'agent_message_chunk'
      ? { type: 'text_delta', bridgeId, turnId, delta }
      : { type: 'thinking_delta', bridgeId, turnId, delta }]
  }

  if (kind === 'tool_call') {
    const toolCallId = update.toolCallId
    if (!toolCallId) return []
    const name = toolName(update)
    const title = update.title ?? tools.titleById.get(toolCallId)
    const args = update.rawInput ?? tools.argsById.get(toolCallId)
    tools.nameById.set(toolCallId, name)
    if (title) tools.titleById.set(toolCallId, title)
    if (update.rawInput !== undefined) tools.argsById.set(toolCallId, update.rawInput)

    if (tools.announced.has(toolCallId)) {
      return [{
        type: 'tool_update',
        bridgeId,
        turnId,
        toolCallId,
        partial: update.rawOutput ?? toolContent(update.content) ?? { status: update.status ?? 'in_progress' },
        args,
        title,
      }]
    }

    tools.announced.add(toolCallId)
    return [{
      type: 'tool_start',
      bridgeId,
      turnId,
      toolCallId,
      toolName: name,
      args,
    }]
  }

  if (kind === 'tool_call_update') {
    const toolCallId = update.toolCallId
    if (!toolCallId) return []
    const name = tools.nameById.get(toolCallId) ?? toolName(update)
    const title = update.title ?? tools.titleById.get(toolCallId)
    const args = update.rawInput ?? tools.argsById.get(toolCallId)
    const events: BridgeEvent[] = []

    // Fail closed on malformed streams: a completion for an unseen call still
    // gets a row before its update instead of being dropped by the renderer.
    if (!tools.announced.has(toolCallId)) {
      tools.announced.add(toolCallId)
      tools.nameById.set(toolCallId, name)
      if (title) tools.titleById.set(toolCallId, title)
      if (update.rawInput !== undefined) tools.argsById.set(toolCallId, update.rawInput)
      events.push({ type: 'tool_start', bridgeId, turnId, toolCallId, toolName: name, args })
    }

    const status = update.status
    const output = update.rawOutput ?? toolContent(update.content) ?? {}
    if (status === 'completed' || status === 'failed') {
      tools.settled.add(toolCallId)
      events.push({
        type: 'tool_end',
        bridgeId,
        turnId,
        toolCallId,
        result: output,
        isError: status === 'failed',
        args,
        title,
      })
      tools.argsById.delete(toolCallId)
      tools.titleById.delete(toolCallId)
      tools.nameById.delete(toolCallId)
    } else {
      events.push({
        type: 'tool_update',
        bridgeId,
        turnId,
        toolCallId,
        partial: output,
        args,
        title,
      })
    }
    return events
  }

  return []
}

/** Prefer CrewCoder's namespaced usage because it carries live context occupancy. */
export function crewCoderUsageFromPromptResult(result: unknown, model?: string): TurnUsage | undefined {
  const response = record(result)
  const meta = record(response?._meta)
  const rich = record(meta?.['crewcoder/usage'])
  const topLevel = record(response?.usage)
  const source = rich ?? topLevel
  if (!source) return undefined

  const usage = buildUsage({
    inputTokens: source.inputTokens ?? source.input_tokens,
    outputTokens: source.outputTokens ?? source.output_tokens,
    contextTokens: rich?.lastInputTokens ?? rich?.last_input_tokens,
    contextWindow: rich?.contextWindow ?? rich?.context_window,
    model,
  })
  if (!usage) return undefined
  const explicitTotal = finiteNumber(source.totalTokens ?? source.total_tokens)
  return explicitTotal === undefined ? usage : { ...usage, totalTokens: explicitTotal }
}

export function writeBlocked(opts: Pick<BridgeStartOpts, 'mode' | 'toolPolicy'>): boolean {
  return opts.toolPolicy === 'read-only' || opts.mode === 'ask' || opts.mode === 'plan'
}

export function crewCoderPermissionOptions(params: Record<string, unknown>): Array<{ id: string; label: string; description?: string }> {
  const options = Array.isArray(params.options) ? params.options : []
  const mapped = options.flatMap((option, index) => {
    if (!option || typeof option !== 'object') return []
    const row = option as Record<string, unknown>
    const id = typeof row.optionId === 'string'
      ? row.optionId
      : typeof row.id === 'string'
        ? row.id
        : String(index)
    // Remembered ACP choices bypass later composer-mode changes. Deliberately
    // expose once-only choices so Ask/Plan/Build/Full remain live policy gates.
    if (id !== 'allow_once' && id !== 'reject_once') return []
    return [{
      id,
      label: typeof row.name === 'string' ? row.name : typeof row.label === 'string' ? row.label : id,
      description: typeof row.description === 'string' ? row.description : undefined,
    }]
  })
  return mapped.length > 0 ? mapped : [
    { id: 'allow_once', label: 'Allow' },
    { id: 'reject_once', label: 'Reject' },
  ]
}

function selectedPermissionOption(
  response: AgentUserResponse,
  options: Array<{ id: string }>,
): string | null {
  if (response.action === 'cancel') return null
  const requested = response.optionId
  if (requested && options.some(option => option.id === requested)) return requested
  const allow = response.action === 'accept' || response.action === 'submit'
  return options.find(option => option.id === (allow ? 'allow_once' : 'reject_once'))?.id
    ?? (allow ? 'allow_once' : 'reject_once')
}

function splitModel(model: string | undefined): { provider?: string; model?: string } {
  const value = model?.trim()
  if (!value) return {}
  const separator = value.indexOf(':')
  if (separator <= 0) return { model: value }
  return { provider: value.slice(0, separator), model: value.slice(separator + 1) }
}

export async function createCrewCoderBridge(
  crewCoderPath: string,
  opts: BridgeStartOpts,
  emit: EmitFn,
  requestUser?: RequestUserFn,
): Promise<AgentBridge> {
  const args = ['acp', '--approval', 'review']
  const selectedModel = splitModel(opts.model)
  const env: Record<string, string> = { ...(opts.env ?? {}) }
  if (selectedModel.provider) env.CREWCODER_PROVIDER = selectedModel.provider
  if (selectedModel.model) env.CREWCODER_MODEL = selectedModel.model

  // Remote roots intentionally use spawnAgentProcess: CrewCoder and its bash
  // tool run on the remote host, while ACP text-file requests route over SFTP.
  const { proc, dir, remote } = await spawnAgentProcess({
    command: crewCoderPath,
    args,
    cwd: opts.cwd,
    env,
  })

  let nextRequestId = 1
  const pending = new Map<JsonRpcId, PendingRequest>()
  let sessionId: string | null = null
  let currentTurnId: string | null = null
  let lastUsage: TurnUsage | undefined
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let replayingSessionLoad = false
  let replayTurnSequence = 0
  let replayTurnId: string | null = null
  let tools = createCrewCoderToolProjectionState()
  let promptWatchdog: InactivityWatchdog | null = null
  let unusable = false
  let unusableReason = 'bridge must restart after an unresponsive cancellation'
  let stopping = false
  const debug = process.env.CREWCODE_CREWCODER_DEBUG === '1'

  function dbg(direction: '>>' | '<<', label: string, extra?: string): void {
    if (!debug) return
    process.stderr.write(`[crewcoder ${opts.bridgeId}] ${direction} ${label}${extra ? ` ${extra}` : ''}\n`)
  }

  function send(message: Record<string, unknown>): boolean {
    if (proc.stdin.destroyed || !proc.stdin.writable) return false
    dbg('>>', String(message.method ?? `response id=${String(message.id)}`))
    // A false write() return is backpressure, not rejection; Node still queued
    // the complete NDJSON frame, so only writability decides send success.
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
    timeoutOptions: RequestTimeoutOptions = {},
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = nextRequestId++
      const timeoutError = new Error(`crewcoder acp: ${method} timed out`)
      let watchdog: InactivityWatchdog | null = null
      let fixedTimer: ReturnType<typeof setTimeout> | null = null
      const clearTimeoutState = (): void => {
        watchdog?.stop()
        watchdog = null
        if (fixedTimer) clearTimeout(fixedTimer)
        fixedTimer = null
        if (promptWatchdog && promptWatchdog === activeWatchdog) promptWatchdog = null
      }
      let activeWatchdog: InactivityWatchdog | null = null
      const entry: PendingRequest = {
        stopTimeout: clearTimeoutState,
        timedOut: false,
        reject,
        resolve: response => {
          if (entry.timedOut) {
            reject(timeoutError)
          } else if (response.error) {
            reject(new Error(`${method}: ${crewCoderAcpErrorMessage(response.error)}`))
          } else {
            resolve(response.result as T)
          }
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
        entry.timedOut = true
        timeoutOptions.cancelOnTimeout()
        fixedTimer = setTimeout(() => {
          timeoutOptions.onCancellationGraceExpired?.()
          rejectTimedOut()
        }, timeoutOptions.cancellationGraceMs ?? CREWCODER_PROMPT_CANCELLATION_GRACE_MS)
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
        reject(new Error('crewcoder acp: process not writable'))
      }
    })
  }

  function startTurn(): string {
    if (currentTurnId) return currentTurnId
    currentTurnId = `${opts.bridgeId}-t-${Date.now().toString(36)}`
    lastUsage = undefined
    tools = createCrewCoderToolProjectionState()
    emit({ type: 'turn_start', bridgeId: opts.bridgeId, turnId: currentTurnId })
    return currentTurnId
  }

  async function endTurn(): Promise<void> {
    if (!currentTurnId) return
    const turnId = currentTurnId
    const turnTools = tools
    currentTurnId = null
    tools = createCrewCoderToolProjectionState()
    // Permission denial, cancellation, or a provider failure may end the turn
    // without a terminal tool update. Never leave its pending row spinning.
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

  function nextReplayTurn(): string {
    replayTurnId = `${opts.bridgeId}-history-${++replayTurnSequence}`
    return replayTurnId
  }

  function handleReplayUpdate(update: CrewCoderSessionUpdate): boolean {
    if (!replayingSessionLoad) return false
    if (update.sessionUpdate !== 'user_message_chunk' && update.sessionUpdate !== 'agent_message_chunk') return false
    if (opts.suppressProviderHistoryReplay) return true
    const text = contentText(update.content)
    if (!text) return true
    if (update.sessionUpdate === 'user_message_chunk') {
      emit({ type: 'history_user', bridgeId: opts.bridgeId, text })
      nextReplayTurn()
    } else {
      emit({ type: 'history_agent', bridgeId: opts.bridgeId, turnId: ensureReplayTurn(), text })
    }
    return true
  }

  function handleSessionUpdate(params: AcpSessionUpdateParams): void {
    const update = params.update
    if (!update || handleReplayUpdate(update)) return
    if (sessionId && params.sessionId !== sessionId) return
    promptWatchdog?.activity()
    const turnId = startTurn()
    for (const event of crewCoderEventsFromUpdate(update, opts.bridgeId, turnId, tools)) emit(event)
    if (!['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
      dbg('<<', `unhandled sessionUpdate:${update.sessionUpdate}`, JSON.stringify(update).slice(0, 240))
    }
  }

  function resolveClientPath(value: string): string {
    // CrewCoder sends absolute paths. Keep relative handling for compatibility
    // with older ACP agents and route remote paths through the workspace root.
    if (remote) return posix.isAbsolute(value) ? value : posix.join(dir, value)
    return isAbsolute(value) ? value : pathResolve(dir, value)
  }

  async function handlePermissionRequest(requestMessage: AcpRequestIn, params: Record<string, unknown>): Promise<void> {
    const rawOptions = crewCoderPermissionOptions(params)
    const fullToolCall = record(params.toolCall)
    const fullVerdict = tripwireForToolCall(typeof fullToolCall?.kind === 'string' ? fullToolCall.kind : undefined, fullToolCall?.rawInput)
    if (opts.mode === 'full' && opts.toolPolicy !== 'read-only' && !fullVerdict.dangerous) {
      // Full Access auto-approves — except denylisted catastrophic commands, which
      // fall through to the confirmation prompt below (the Full Access tripwire).
      const optionId = rawOptions.find(option => option.id === 'allow_once')?.id ?? 'allow_once'
      send({ jsonrpc: '2.0', id: requestMessage.id, result: { outcome: { outcome: 'selected', optionId } } })
      return
    }
    if (opts.mode === 'full' && fullVerdict.dangerous && !requestUser) {
      // Tripwire tripped but no human to confirm — fail safe by refusing.
      send({ jsonrpc: '2.0', id: requestMessage.id, result: { outcome: { outcome: 'cancelled' } } })
      return
    }
    if (writeBlocked(opts) || !requestUser) {
      send({ jsonrpc: '2.0', id: requestMessage.id, result: { outcome: { outcome: 'cancelled' } } })
      return
    }

    const toolCall = record(params.toolCall)
    const kind = typeof toolCall?.kind === 'string' ? toolCall.kind : 'other'
    promptWatchdog?.pause()
    try {
      const response = await requestUser({
        kind: 'permission',
        turnId: currentTurnId ?? undefined,
        title: fullVerdict.dangerous ? 'Full Access tripwire — confirm dangerous command' : (typeof toolCall?.title === 'string' ? toolCall.title : 'Permission required'),
        message: fullVerdict.dangerous ? fullVerdict.reason : (typeof params.message === 'string' ? params.message : undefined),
        detail: JSON.stringify(toolCall ?? params, null, 2).slice(0, 1600),
        options: rawOptions,
        dangerous: !['read', 'search', 'fetch', 'think'].includes(kind),
        source: 'crewcoder',
      })
      const optionId = selectedPermissionOption(response, rawOptions)
      send({
        jsonrpc: '2.0',
        id: requestMessage.id,
        result: {
          outcome: optionId
            ? { outcome: 'selected', optionId }
            : { outcome: 'cancelled' },
        },
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
          // This mirrors Hermes' filesystem authority. It serves current disk
          // bytes; dirty CodeMirror buffers need a future renderer-host route.
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
            error: { code: -32000, message: `write blocked in ${opts.toolPolicy === 'read-only' ? 'read-only' : opts.mode} mode` },
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
      emit({ type: 'error', bridgeId: opts.bridgeId, message: `crewcoder acp: bad json: ${(error as Error).message}` })
      return
    }

    const id = typeof message.id === 'number' || typeof message.id === 'string' ? message.id : undefined
    if (typeof message.method === 'string') {
      const label = message.method === 'session/update'
        ? `update:${record(record(message.params)?.update)?.sessionUpdate ?? '?'}`
        : message.method
      dbg('<<', label)
    } else if (id !== undefined) {
      dbg('<<', `response id=${String(id)}${message.error ? ' error' : ''}`)
    }

    if (id !== undefined && ('result' in message || 'error' in message) && typeof message.method !== 'string') {
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
    if (typeof message.method === 'string' && message.method === 'session/update') {
      const params = record(message.params)
      const update = record(params?.update)
      if (params && update && typeof params.sessionId === 'string') {
        handleSessionUpdate({ sessionId: params.sessionId, update: update as unknown as CrewCoderSessionUpdate })
      }
    }
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
      const line = raw.trim()
      if (!line) continue
      dbg('<<', 'stderr', line)
      if (/\[acp\] suppressed stdout write:|\b(error|fatal)\b|^Traceback /i.test(line)) {
        emit({ type: 'error', bridgeId: opts.bridgeId, message: `crewcoder: ${line}` })
      }
    }
  })

  proc.on('close', code => {
    for (const [, entry] of pending) {
      entry.stopTimeout()
      entry.reject(new Error(`crewcoder acp closed before responding (code ${String(code)})`))
    }
    pending.clear()
    void endTurn().finally(() => emit({ type: 'closed', bridgeId: opts.bridgeId, code }))
  })

  proc.on('error', error => {
    emit({ type: 'error', bridgeId: opts.bridgeId, message: `crewcoder spawn failed: ${error.message}` })
    emit({ type: 'closed', bridgeId: opts.bridgeId, code: null })
  })

  try {
    await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    })

    let resumed = false
    if (opts.resumeSessionId) {
      try {
        replayingSessionLoad = true
        replayTurnId = null
        await request('session/load', {
          sessionId: opts.resumeSessionId,
          cwd: dir,
          mcpServers: [],
        }, 30_000)
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
      const response = await request<{ sessionId?: string }>('session/new', { cwd: dir, mcpServers: [] })
      if (!response.sessionId) throw new Error('crewcoder acp: session/new returned no session id')
      sessionId = response.sessionId
    }

    if (opts.externalDirectories !== undefined) {
      try {
        await request('session/set_external_directories', {
          sessionId,
          directories: opts.externalDirectories,
        }, 30_000)
      } catch (error) {
        // Filesystem grants are a security boundary. Never continue with stale
        // native-session access when synchronization failed.
        unusable = true
        unusableReason = 'bridge must restart because external directory synchronization failed'
        throw error
      }
    }

    if (opts.model) {
      try {
        await request('session/set_model', { sessionId, modelId: opts.model }, 30_000)
      } catch (error) {
        // A bad model should not discard a successfully-created ACP session;
        // surface it and let CrewCoder retain its configured default.
        emit({ type: 'error', bridgeId: opts.bridgeId, message: (error as Error).message })
      }
    }

    if (opts.thinking) {
      await request('session/set_reasoning_effort', {
        sessionId,
        effort: opts.thinking === 'off' ? 'none' : opts.thinking,
      }, 30_000)
    }

    emit({ type: 'session_id', bridgeId: opts.bridgeId, sessionId, resumed })
    emit({ type: 'ready', bridgeId: opts.bridgeId })
  } catch (error) {
    emit({ type: 'error', bridgeId: opts.bridgeId, message: (error as Error).message })
  }

  return {
    bridgeId: opts.bridgeId,
    pid: proc.pid ?? null,
    async prompt(text: string, options) {
      if (!sessionId) return { ok: false, error: 'crewcoder acp: session not established' }
      if (unusable) return { ok: false, error: `crewcoder acp: ${unusableReason}` }
      if (currentTurnId && options?.streamingBehavior === 'followUp') {
        try {
          await request('session/follow_up', { sessionId, message: text }, 30_000)
          return { ok: true }
        } catch (error) {
          return { ok: false, error: (error as Error).message }
        }
      }
      if (currentTurnId) return { ok: false, error: 'crewcoder acp: a turn is already running' }
      if (proc.stdin.destroyed || !proc.stdin.writable) return { ok: false, error: 'crewcoder acp: process not writable' }
      startTurn()
      void (async () => {
        try {
          const result = await request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text }],
          }, CREWCODER_PROMPT_INACTIVITY_TIMEOUT_MS, {
            activityBased: true,
            cancelOnTimeout: () => notify('session/cancel', { sessionId }),
            onCancellationGraceExpired: () => {
              unusable = true
              try { proc.kill() } catch { /* already closed */ }
            },
          })
          lastUsage = crewCoderUsageFromPromptResult(result, opts.model)
        } catch (error) {
          // CrewCoder deliberately reports provider/stall failures as JSON-RPC
          // errors. User-requested teardown is silent; the closed event owns it.
          if (!stopping) emit({ type: 'error', bridgeId: opts.bridgeId, message: (error as Error).message })
        } finally {
          await endTurn()
        }
      })()
      return { ok: true }
    },
    async abort() {
      if (!sessionId) return
      // ACP session/cancel is a notification. The prompt response still settles
      // with stopReason=cancelled and owns the normalized turn_end.
      notify('session/cancel', { sessionId })
    },
    async stop() {
      stopping = true
      if (sessionId) notify('session/cancel', { sessionId })
      try { proc.stdin.end() } catch { /* already closed */ }
      setTimeout(() => {
        if (!proc.killed) {
          try { proc.kill() } catch { /* already closed */ }
        }
      }, 500)
    },
  }
}

import { promises as fsp } from 'fs'
import { isAbsolute, posix, resolve as pathResolve } from 'path'
import { spawnAgentProcess } from './agent-spawn'
import { remoteReadFile, remoteWriteFile } from '../remote/remote-fs'
import { toAcpMcpServer } from '../../shared/mcp-types'
import type { AgentBridge, BridgeStartOpts, EmitFn, ModeLevel, RequestUserFn, TurnUsage } from './bridge-types'
import { buildUsage } from './model-context'
import { enrichUsageContextWindow } from './openrouter-model-context'

// Hermes via ACP (Agent Client Protocol) — JSON-RPC 2.0 over stdio.
// Spec: https://github.com/zed-industries/agent-client-protocol
// Spawn: `hermes acp`
//
// Wire format: newline-delimited JSON-RPC. Requests use { jsonrpc, id, method, params },
// responses use { jsonrpc, id, result | error }, notifications use { jsonrpc, method, params }.
// ACP streams agent output via `session/update` notifications; each carries a
// `sessionUpdate` discriminator (agent_message_chunk, agent_thought_chunk,
// tool_call, tool_call_update, …) plus a `content` block.

interface AcpResponse {
  jsonrpc: '2.0'
  id:      number
  result?: unknown
  error?:  { code: number; message: string; data?: unknown }
}

interface AcpNotification {
  jsonrpc: '2.0'
  method:  string
  params?: Record<string, unknown>
}

interface AcpContentBlock {
  type: string
  text?: string
  [k: string]: unknown
}

interface AcpSessionUpdateBody {
  sessionUpdate: string
  content?:      AcpContentBlock
  toolCallId?:   string
  title?:        string
  kind?:         string
  status?:       string
  rawInput?:     unknown
  rawOutput?:    unknown
  [k: string]:   unknown
}

// session/update params wire shape: { sessionId, update: { sessionUpdate, … } }
interface AcpSessionUpdateParams {
  sessionId: string
  update:    AcpSessionUpdateBody
}

interface AcpRequestIn {
  jsonrpc: '2.0'
  id:      number
  method:  string
  params?: Record<string, unknown>
}

const WRITE_TOOL_NAMES = new Set(['write', 'edit', 'apply_patch', 'bash', 'shell', 'execute', 'run'])

function isWriteToolBlocked(opts: Pick<BridgeStartOpts, 'mode' | 'toolPolicy'>, toolName: string | undefined): boolean {
  if (opts.toolPolicy !== 'read-only' && opts.mode !== 'ask' && opts.mode !== 'plan') return false
  const lower = (toolName ?? '').toLowerCase()
  return WRITE_TOOL_NAMES.has(lower)
    || lower.includes('write')
    || lower.includes('edit')
    || lower.includes('bash')
    || lower.includes('shell')
}

function extractText(content: AcpContentBlock | undefined): string {
  if (!content) return ''
  if (typeof content.text === 'string') return content.text
  return ''
}

export function hermesThinkingDelta(prior: string, text: string): { delta: string; next: string } {
  if (!text) return { delta: '', next: prior }
  if (!prior) return { delta: text, next: text }
  if (text === prior || prior.endsWith(text)) return { delta: '', next: prior }
  // Patched Hermes can re-fire cumulative reasoning on turn completion; keep
  // only the suffix so reload/live order matches the other streaming bridges.
  if (text.startsWith(prior)) return { delta: text.slice(prior.length), next: text }
  return { delta: text, next: prior + text }
}

function isSessionHistoryReplayUpdate(kind: string): boolean {
  return kind === 'user_message_chunk'
    || kind === 'agent_message_chunk'
    || kind === 'agent_thought_chunk'
    || kind === 'tool_call'
    || kind === 'tool_call_update'
}

function acpToolName(p: AcpSessionUpdateBody): string {
  return (p.kind as string | undefined) ?? (p.title as string | undefined) ?? 'tool'
}

export async function createHermesBridge(
  hermesPath: string,
  opts: BridgeStartOpts,
  emit: EmitFn,
  requestUser?: RequestUserFn,
): Promise<AgentBridge> {
  const args = ['acp']

  const hermesEnv: Record<string, string> = { ...(opts.env ?? {}) }
  if (opts.apiKey) hermesEnv.HERMES_API_KEY = opts.apiKey

  // `dir` is the on-host working directory (remote abs path when remote);
  // `remote` routes the ACP fs capability through SFTP instead of local disk.
  const { proc, dir, remote } = await spawnAgentProcess({
    command: hermesPath,
    args,
    cwd:     opts.cwd,
    env:     hermesEnv,
  })

  let nextReqId = 1
  const pending = new Map<number, (resp: AcpResponse) => void>()
  let currentTurnId: string | null = null
  let sessionId: string | null = null
  let buf = ''
  // Usage from the session/prompt response (when hermes reports it), flushed
  // on turn_end. ACP doesn't mandate token usage, so this is best-effort.
  let lastUsage: TurnUsage | undefined
  // Per-turn accumulated reasoning text. Patched hermes fires reasoning_callback
  // both per-delta and once more at the end with the full text (run_agent.py
  // :8581 guard misses because the ACP adapter sets no stream_delta_callback).
  // Drop the trailing duplicate by checking if accumulated already ends with it.
  const reasoningAccum: Record<string, string> = {}
  let replayingSessionLoad = false
  let replayTurnSeq = 0
  let replayTurnId: string | null = null

  const debug = process.env.CREWCODE_HERMES_DEBUG === '1'
  function dbg(dir: '>>' | '<<', kind: string, extra?: string): void {
    if (!debug) return
    process.stderr.write(`[hermes ${opts.bridgeId}] ${dir} ${kind}${extra ? ' ' + extra : ''}\n`)
  }

  function send(obj: Record<string, unknown>): boolean {
    if (proc.stdin.destroyed || !proc.stdin.writable) return false
    dbg('>>', String(obj.method ?? `resp id=${obj.id}`))
    proc.stdin.write(JSON.stringify(obj) + '\n')
    return true
  }

  function request<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = nextReqId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`hermes acp: ${method} timed out`))
      }, timeoutMs)
      pending.set(id, (resp) => {
        clearTimeout(timer)
        if (resp.error) reject(new Error(`${method}: ${resp.error.message}`))
        else resolve(resp.result as T)
      })
      const ok = send({ jsonrpc: '2.0', id, method, params: params ?? {} })
      if (!ok) {
        clearTimeout(timer)
        pending.delete(id)
        reject(new Error('hermes acp: process not writable'))
      }
    })
  }

  function startTurn(): string {
    if (!currentTurnId) {
      currentTurnId = `${opts.bridgeId}-t-${Date.now().toString(36)}`
      emit({ type: 'turn_start', bridgeId: opts.bridgeId, turnId: currentTurnId })
    }
    return currentTurnId
  }

  async function endTurn(): Promise<void> {
    if (currentTurnId) {
      const turnId = currentTurnId
      delete reasoningAccum[turnId]
      const usage = await enrichUsageContextWindow(lastUsage)
      emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId, usage })
      currentTurnId = null
      lastUsage = undefined
    }
  }

  // Read token usage off a session/prompt response if hermes includes it.
  function captureUsage(result: unknown): void {
    if (process.env.CREWCODE_DEBUG_USAGE) {
      // eslint-disable-next-line no-console
      console.error('[hermes usage] prompt result:', JSON.stringify(result).slice(0, 600))
    }
    const r = result as Record<string, unknown> | undefined
    const u = (r?.usage ?? r?.tokens) as Record<string, unknown> | undefined
    if (!u) return
    const input  = u.inputTokens  ?? u.input_tokens  ?? u.promptTokens    ?? u.prompt_tokens
    const output = u.outputTokens ?? u.output_tokens ?? u.completionTokens ?? u.completion_tokens
    const usage = buildUsage({ inputTokens: input, outputTokens: output, model: opts.model })
    if (usage) lastUsage = usage
  }

  function ensureReplayTurn(): string {
    if (!replayTurnId) replayTurnId = `${opts.bridgeId}-history-${++replayTurnSeq}`
    return replayTurnId
  }

  function nextReplayTurn(): string {
    replayTurnId = `${opts.bridgeId}-history-${++replayTurnSeq}`
    return replayTurnId
  }

  function handleReplaySessionUpdate(kind: string, p: AcpSessionUpdateBody): boolean {
    if (!replayingSessionLoad || !isSessionHistoryReplayUpdate(kind)) return false
    if (opts.suppressProviderHistoryReplay) return true

    if (kind === 'user_message_chunk') {
      const text = extractText(p.content)
      if (text) emit({ type: 'history_user', bridgeId: opts.bridgeId, text })
      nextReplayTurn()
      return true
    }
    if (kind === 'agent_message_chunk') {
      const text = extractText(p.content)
      if (text) emit({ type: 'history_agent', bridgeId: opts.bridgeId, turnId: ensureReplayTurn(), text })
      return true
    }
    if (kind === 'agent_thought_chunk') {
      const text = extractText(p.content)
      if (text) emit({ type: 'history_thinking', bridgeId: opts.bridgeId, turnId: ensureReplayTurn(), text })
      return true
    }
    if (kind === 'tool_call') {
      emit({
        type: 'tool_start',
        bridgeId: opts.bridgeId,
        turnId: ensureReplayTurn(),
        toolCallId: p.toolCallId ?? `${opts.bridgeId}-history-tc-${Date.now().toString(36)}`,
        toolName: acpToolName(p),
        args: p.rawInput,
      })
      return true
    }
    if (kind === 'tool_call_update') {
      const toolCallId = p.toolCallId
      if (!toolCallId) return true
      const status = p.status as string | undefined
      if (status === 'completed' || status === 'failed') {
        emit({
          type: 'tool_end',
          bridgeId: opts.bridgeId,
          turnId: ensureReplayTurn(),
          toolCallId,
          result: p.rawOutput,
          isError: status === 'failed',
          title: p.title as string | undefined,
        })
      } else {
        emit({
          type: 'tool_update',
          bridgeId: opts.bridgeId,
          turnId: ensureReplayTurn(),
          toolCallId,
          partial: p.rawOutput ?? {},
          title: p.title as string | undefined,
        })
      }
      return true
    }
    return false
  }

  function handleSessionUpdate(params: AcpSessionUpdateParams): void {
    const p = params.update
    if (!p) return
    const kind = p.sessionUpdate
    if (handleReplaySessionUpdate(kind, p)) return
    if (kind === 'user_message_chunk') return
    if (kind === 'agent_message_chunk') {
      const text = extractText(p.content)
      if (!text) return
      const turnId = startTurn()
      emit({ type: 'text_delta', bridgeId: opts.bridgeId, turnId, delta: text })
      return
    }
    if (kind === 'agent_thought_chunk') {
      const text = extractText(p.content)
      if (!text) return
      // Preserve every provider-supplied thought event. Some Hermes builds use
      // this channel for status-like thoughts and others for model reasoning;
      // CrewCode must not hide either from the transcript.
      const turnId = startTurn()
      const prior = reasoningAccum[turnId] ?? ''
      const deduped = hermesThinkingDelta(prior, text)
      if (!deduped.delta) return
      reasoningAccum[turnId] = deduped.next
      emit({ type: 'thinking_delta', bridgeId: opts.bridgeId, turnId, delta: deduped.delta })
      return
    }
    if (kind === 'tool_call') {
      const toolName = acpToolName(p)
      const toolCallId = p.toolCallId ?? `${opts.bridgeId}-tc-${Date.now().toString(36)}`
      if (isWriteToolBlocked(opts, toolName)) {
        emit({ type: 'error', bridgeId: opts.bridgeId, message: `Tool "${toolName}" is not allowed in ${opts.mode} mode` })
        return
      }
      const turnId = startTurn()
      emit({
        type: 'tool_start',
        bridgeId: opts.bridgeId,
        turnId,
        toolCallId,
        toolName,
        args: p.rawInput,
      })
      return
    }
    if (kind === 'tool_call_update') {
      const toolCallId = p.toolCallId
      if (!toolCallId) return
      const turnId = startTurn()
      const status = p.status as string | undefined
      if (status === 'completed' || status === 'failed') {
        emit({
          type: 'tool_end',
          bridgeId: opts.bridgeId,
          turnId,
          toolCallId,
          result: p.rawOutput,
          isError: status === 'failed',
          title: p.title as string | undefined,
        })
      } else {
        emit({
          type: 'tool_update',
          bridgeId: opts.bridgeId,
          turnId,
          toolCallId,
          partial: p.rawOutput ?? {},
          title: p.title as string | undefined,
        })
      }
      return
    }
    // Unknown sessionUpdate kind — log shape so we can see whether hermes
    // ships reasoning via a non-standard variant (e.g. plan / current_mode_update).
    dbg('<<', `unhandled sessionUpdate:${kind}`, JSON.stringify(p).slice(0, 200))
  }

  function resolvePath(p: string): string {
    // Hermes reads its own skill/config/history files plus files under the repo.
    // A workspace-only guard would block legitimate reads. Remote paths are
    // posix and resolve against the host dir; local against the local cwd.
    if (remote) return posix.isAbsolute(p) ? p : posix.join(dir, p)
    return isAbsolute(p) ? p : pathResolve(dir, p)
  }

  function permissionOptions(params: Record<string, unknown>): Array<{ id: string; label: string; description?: string }> {
    const raw = Array.isArray(params.options) ? params.options : []
    const mapped = raw.map((option, index) => {
      if (typeof option === 'string') return { id: option, label: option }
      if (option && typeof option === 'object') {
        const row = option as Record<string, unknown>
        const id = typeof row.optionId === 'string' ? row.optionId : typeof row.id === 'string' ? row.id : String(index)
        return {
          id,
          label: typeof row.name === 'string' ? row.name : typeof row.label === 'string' ? row.label : id,
          description: typeof row.description === 'string' ? row.description : undefined,
        }
      }
      return { id: String(index), label: String(option) }
    })
    return mapped.length > 0 ? mapped : [
      { id: 'allow_once', label: 'allow once' },
      { id: 'reject', label: 'deny' },
    ]
  }

  async function handleRequest(req: AcpRequestIn): Promise<void> {
    const params = (req.params ?? {}) as Record<string, unknown>
    try {
      if (req.method === 'session/request_permission') {
        // Composer mode can change without respawning the ACP session. Keep the
        // permission gate in sync with the current turn's mode.
        if (opts.mode === 'full' || !requestUser) {
          send({ jsonrpc: '2.0', id: req.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } })
          return
        }
        if (opts.mode === 'ask' || opts.mode === 'plan') {
          send({ jsonrpc: '2.0', id: req.id, result: { outcome: { outcome: 'cancelled' } } })
          return
        }
        const response = await requestUser({
          kind: 'permission',
          turnId: currentTurnId ?? undefined,
          title: typeof params.title === 'string' ? params.title : 'permission required',
          message: typeof params.message === 'string' ? params.message : typeof params.reason === 'string' ? params.reason : undefined,
          detail: JSON.stringify(params, null, 2).slice(0, 1200),
          options: permissionOptions(params),
          dangerous: true,
          source: 'hermes',
        })
        const optionId = response.optionId ?? (response.action === 'accept' || response.action === 'submit' ? 'allow_once' : 'reject')
        send({ jsonrpc: '2.0', id: req.id, result: { outcome: response.action === 'cancel' || response.action === 'decline' || optionId === 'reject'
          ? { outcome: 'cancelled' }
          : { outcome: 'selected', optionId } } })
        return
      }
      if (req.method === 'fs/read_text_file') {
        const path = String(params.path ?? '')
        const line = typeof params.line === 'number' ? params.line : undefined
        const limit = typeof params.limit === 'number' ? params.limit : undefined
        const abs = resolvePath(path)
        let content: string
        if (remote) {
          // Route through SFTP so reads hit the host's filesystem, where hermes
          // and the workspace both live. remoteReadFile resolves relative to the
          // ssh:// root and rejects paths that escape the workspace.
          const rr = await remoteReadFile(opts.cwd, posix.relative(dir, abs))
          if (rr.error || typeof rr.text !== 'string') {
            send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: rr.error ?? 'read failed' } })
            return
          }
          content = rr.text
        } else {
          content = await fsp.readFile(abs, 'utf8')
        }
        if (line !== undefined || limit !== undefined) {
          const lines = content.split('\n')
          const start = Math.max(0, (line ?? 1) - 1)
          const end = limit !== undefined ? start + limit : lines.length
          content = lines.slice(start, end).join('\n')
        }
        send({ jsonrpc: '2.0', id: req.id, result: { content } })
        return
      }
      if (req.method === 'fs/write_text_file') {
        if (opts.mode === 'ask' || opts.mode === 'plan') {
          send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: `write blocked in ${opts.mode} mode` } })
          return
        }
        const path = String(params.path ?? '')
        const content = String(params.content ?? '')
        const abs = resolvePath(path)
        if (remote) {
          const wr = await remoteWriteFile(opts.cwd, posix.relative(dir, abs), content)
          if (wr.error) {
            send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: wr.error } })
            return
          }
        } else {
          await fsp.writeFile(abs, content, 'utf8')
        }
        send({ jsonrpc: '2.0', id: req.id, result: {} })
        return
      }
      // Terminal ops aren't wired into a real PTY yet — decline cleanly so
      // hermes falls back to non-terminal tool paths instead of crashing.
      if (req.method.startsWith('terminal/')) {
        send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `terminal capability not available` } })
        return
      }
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not implemented: ${req.method}` } })
    } catch (err) {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: (err as Error).message } })
    }
  }

  function handleLine(line: string): void {
    let msg: Record<string, unknown>
    try { msg = JSON.parse(line) as Record<string, unknown> }
    catch (err) {
      emit({ type: 'error', bridgeId: opts.bridgeId, message: `hermes acp: bad json: ${(err as Error).message}` })
      return
    }
    if (typeof msg.method === 'string') {
      const kind = msg.method === 'session/update'
        ? `update:${(msg.params as { update?: { sessionUpdate?: string } })?.update?.sessionUpdate ?? '?'}`
        : msg.method
      dbg('<<', kind)
    } else if (typeof msg.id === 'number') {
      dbg('<<', `resp id=${msg.id}${msg.error ? ' error' : ''}`)
    }
    if (typeof msg.id === 'number' && ('result' in msg || 'error' in msg)) {
      const cb = pending.get(msg.id)
      if (cb) {
        pending.delete(msg.id)
        cb(msg as unknown as AcpResponse)
      }
      return
    }
    if (typeof msg.method === 'string' && typeof msg.id === 'number') {
      void handleRequest(msg as unknown as AcpRequestIn)
      return
    }
    if (typeof msg.method === 'string') {
      const notif = msg as unknown as AcpNotification
      if (notif.method === 'session/update' && notif.params) {
        handleSessionUpdate(notif.params as unknown as AcpSessionUpdateParams)
      }
      return
    }
  }

  function consume(chunk: string): void {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      handleLine(line)
    }
  }

  proc.stdout.setEncoding('utf8')
  proc.stdout.on('data', consume)

  // Hermes routes all of its lifecycle logs through stderr ([INFO], [DEBUG],
  // [WARNING], [ERROR]). Surfacing INFO/DEBUG as chat errors floods the UI, so
  // only emit lines that actually look like errors. Anything we drop is still
  // available in the user's hermes log files (~/.hermes/logs/).
  // Set when we know the next stderr Traceback/Exception lines belong to a
  // benign background failure (e.g. set_model rebuild). Cleared once a clean
  // log line shows up. Without this gate the multi-line traceback floods chat.
  let suppressTraceback = false
  proc.stderr.setEncoding('utf8')
  proc.stderr.on('data', (chunk: string) => {
    for (const raw of chunk.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      // Hermes wraps the model-rebuild failure in a generic "Background task
      // failed" line followed by a Python traceback. Both are non-fatal — the
      // session keeps working — so drop the whole block from chat.
      if (/Background task failed/i.test(line) || /session\/set_model/i.test(line)) {
        suppressTraceback = true
        dbg('<<', 'stderr suppressed', line)
        continue
      }
      if (suppressTraceback) {
        if (/^Traceback /.test(line) || /^\s/.test(raw) || /Error:|Exception:/.test(line)) {
          dbg('<<', 'stderr suppressed', line)
          continue
        }
        suppressTraceback = false
      }
      const isError =
        /\[(ERROR|CRITICAL|FATAL)\]/i.test(line) ||
        /^Traceback /.test(line) ||
        /Exception(:|$)/.test(line)
      if (isError) emit({ type: 'error', bridgeId: opts.bridgeId, message: `hermes: ${line}` })
    }
  })

  proc.on('close', code => {
    void endTurn().finally(() => emit({ type: 'closed', bridgeId: opts.bridgeId, code }))
  })

  proc.on('error', err => {
    emit({ type: 'error', bridgeId: opts.bridgeId, message: `hermes spawn failed: ${err.message}` })
    emit({ type: 'closed', bridgeId: opts.bridgeId, code: null })
  })

  // ACP handshake: initialize → session/new. Done up-front so prompt() is fast.
  try {
    await request('initialize', {
      protocolVersion: 1,
      // Advertise fs capabilities so hermes routes file ops through us instead
      // of trying to hit them directly. Without this hermes still calls
      // fs/read_text_file on first turn and our method-not-found response
      // crashes its background task, leaving the prompt hanging forever.
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    })
    // Try session/load first if the renderer passed a resume id. Hermes
    // persists sessions to ~/.hermes/state.db; load reattaches and may replay
    // history over ACP. If CrewCode has richer local UI history, suppress that
    // replay so thinking/tool cards keep their original order. If the id is
    // stale or the load handler errors, fall back to a brand-new session so the user
    // still gets a working chat instead of a dead bridge.
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
      // ACP only models stdio MCP servers; map the session's opted-in registry
      // entries (non-stdio filtered out) into the `session/new` shape. Resume
      // via session/load deliberately keeps `[]` — a restored session already
      // carries its server config.
      const acpMcpServers = (opts.mcpServers ?? [])
        .filter(s => (s.transport ?? 'stdio') === 'stdio')
        .map(toAcpMcpServer)
      const newResp = await request<{ sessionId: string }>('session/new', { cwd: dir, mcpServers: acpMcpServers })
      sessionId = newResp.sessionId
    }
    emit({ type: 'session_id', bridgeId: opts.bridgeId, sessionId, resumed })
    emit({ type: 'ready', bridgeId: opts.bridgeId })

    // Apply the picker's model via the ACP-native session/set_model method.
    // Hermes' adapter parses `modelId` as `provider:model` (colon, not slash).
    // Skip on resume: a restored session already has its model wired into the
    // rebuilt agent state, and hermes' _make_agent throws "Internal error"
    // when we try to switch the model on a freshly-loaded session. To change
    // models on a resumed thread, the UI should resetSession() first so we
    // start fresh.
    if (opts.model && sessionId && !resumed) {
      ;(async () => {
        try {
          await request('session/set_model', {
            sessionId,
            modelId: opts.model,
          }, 30_000)
        } catch (err) {
          // Non-fatal: hermes' adapter throws "Internal error" when the
          // requested model already matches the session's bootstrapped one
          // (_make_agent rebuild trips on its own state). The reply still
          // works, so surface it to debug only instead of the chat stream.
          dbg('<<', 'set_model error', (err as Error).message)
        }
      })()
    }
  } catch (err) {
    emit({ type: 'error', bridgeId: opts.bridgeId, message: (err as Error).message })
  }

  return {
    bridgeId: opts.bridgeId,
    pid: proc.pid ?? null,
    async prompt(text: string) {
      if (!sessionId) return { ok: false, error: 'hermes acp: session not established' }
      // Fire-and-forget; the streamed updates carry the turn output. Resolve
      // optimistically so the UI returns to the user immediately.
      ;(async () => {
        try {
          const res = await request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text }],
          }, 5 * 60_000)
          captureUsage(res)
        } catch (err) {
          emit({ type: 'error', bridgeId: opts.bridgeId, message: (err as Error).message })
        } finally {
          await endTurn()
        }
      })()
      return { ok: true }
    },
    async abort() {
      if (!sessionId) return
      try { await request('session/cancel', { sessionId }, 5_000) } catch { /* ignore */ }
    },
    async stop() {
      try { if (sessionId) await request('session/cancel', { sessionId }, 2_000) } catch { /* ignore */ }
      try { proc.stdin.end() } catch { /* ignore */ }
      setTimeout(() => { if (!proc.killed) try { proc.kill() } catch { /* ignore */ } }, 500)
    },
  }
}

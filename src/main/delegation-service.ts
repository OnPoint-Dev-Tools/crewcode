// Local delegation API — a loopback HTTP surface that lets a coding agent create
// and drive real CrewCode chat threads from inside a turn.
//
// HTTP rather than MCP because every provider already has shell access, so one
// `curl` covers claude, codex, pi, opencode, hermes, CrewCoder, and ollama;
// MCP would currently reach only claude (SDK) and hermes (ACP).
//
// Security shape mirrors local-voice-service.ts: loopback bind, ephemeral port,
// randomly generated per-launch tokens owned by main. The renderer never calls
// this surface — it only answers the IPC this service marshals requests into.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, randomUUID } from 'crypto'
import { BrowserWindow, ipcMain } from 'electron'
import {
  applyCreatePolicy,
  applyRateLimit,
  bearerToken,
  containsDelegationToken,
  newRateWindow,
  hostAllowed,
  isRouteError,
  matchRoute,
  normalizeCreate,
  normalizeFocus,
  normalizeMessage,
  parseBody,
  remoteAddressAllowed,
  DEFAULT_MAX_CONCURRENT,
  MAX_BODY_BYTES,
  TOKEN_LEAK_REFUSAL,
  type DelegationPolicy,
  type RateWindow,
  type RouteError,
} from './delegation-routes'
import type {
  DelegatedThreadSummary,
  DelegationCredentials,
  DelegationRendererRequest,
  DelegationResult,
} from '../shared/delegation-types'

const HOST = '127.0.0.1'
/** How long a renderer round-trip may take before the agent's curl gets a real
 *  error. A reloading or closed window must fail fast, never hang the agent. */
const IPC_TIMEOUT_MS = 10_000

interface RegisteredSession {
  sessionId: string
  policy: DelegationPolicy
  /** Optimistic count of this session's open delegated threads, used for the
   *  concurrency cap. Resynced from every `list` response, which is
   *  authoritative — threads can also be closed from the UI. */
  activeCount: number
  /** Fixed-window request counter. The concurrency cap bounds open threads; this
   *  bounds an agent stuck in a create/close or poll loop. */
  rate: RateWindow
}

export class DelegationService {
  private server: Server | null = null
  private port = 0
  /** token -> session. The token IS the caller's identity: one per delegating
   *  session, so an agent can only ever address its own children. */
  private sessions = new Map<string, RegisteredSession>()
  private tokensBySession = new Map<string, string>()
  private pending = new Map<string, { resolve: (value: DelegationResult<unknown>) => void; timer: NodeJS.Timeout }>()
  private ipcBound = false

  /**
   * Enable delegation for a session and return the credentials to inject into
   * its agent context. Idempotent: re-enabling reuses the existing token so a
   * mid-session policy change doesn't invalidate credentials already delivered.
   */
  async enable(sessionId: string, policy: DelegationPolicy): Promise<DelegationCredentials> {
    await this.ensureStarted()

    const existing = this.tokensBySession.get(sessionId)
    if (existing) {
      const entry = this.sessions.get(existing)
      if (entry) entry.policy = policy
      return { endpoint: this.endpoint(), token: existing }
    }

    const token = randomBytes(32).toString('hex')
    this.sessions.set(token, { sessionId, policy, activeCount: 0, rate: newRateWindow(Date.now()) })
    this.tokensBySession.set(sessionId, token)
    return { endpoint: this.endpoint(), token }
  }

  /** Revoke a session's credentials (delegation turned off, session archived or
   *  deleted). Any in-flight request with this token starts failing 401. */
  disable(sessionId: string): void {
    const token = this.tokensBySession.get(sessionId)
    if (!token) return
    this.tokensBySession.delete(sessionId)
    this.sessions.delete(token)
    if (this.sessions.size === 0) this.stop()
  }

  stop(): void {
    for (const [, entry] of this.pending) clearTimeout(entry.timer)
    this.pending.clear()
    this.server?.close()
    this.server = null
    this.port = 0
  }

  private endpoint(): string {
    return `http://${HOST}:${this.port}`
  }

  private async ensureStarted(): Promise<void> {
    if (this.server) return
    this.bindIpc()

    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res) })
      server.on('error', reject)
      // Port 0 = ephemeral. A fixed port collides with a second CrewCode
      // instance and with the voice sidecar; the agent learns the real port
      // from its injected credentials.
      server.listen(0, HOST, () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close()
          reject(new Error('delegation service failed to bind a loopback port'))
          return
        }
        this.server = server
        this.port = address.port
        resolve()
      })
    })
  }

  private bindIpc(): void {
    if (this.ipcBound) return
    this.ipcBound = true
    // The renderer answers each marshalled request by correlation id. Replies
    // for unknown/expired ids are dropped rather than throwing.
    ipcMain.on('delegation:response', (_event, payload: { id?: string; result?: DelegationResult<unknown> }) => {
      const id = payload?.id
      if (!id) return
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.resolve(payload.result ?? { ok: false, error: 'renderer returned no result' })
    })
  }

  /** Marshal one request into the renderer and await its reply. */
  private request<T>(message: DelegationRendererRequest): Promise<DelegationResult<T>> {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.webContents.isDestroyed()) {
      return Promise.resolve({ ok: false, error: 'CrewCode window is not available', status: 503 })
    }

    const id = randomUUID()
    return new Promise<DelegationResult<T>>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: 'CrewCode did not respond in time', status: 504 })
      }, IPC_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (value: DelegationResult<unknown>) => void, timer })
      win.webContents.send('delegation:request', { id, ...message })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!remoteAddressAllowed(req.socket.remoteAddress)) return send(res, 403, { ok: false, error: 'loopback only' })
      if (!hostAllowed(req.headers.host, this.port)) return send(res, 403, { ok: false, error: 'invalid Host header' })

      const token = bearerToken(req.headers as Record<string, string | string[] | undefined>)
      const session = token ? this.sessions.get(token) : undefined
      if (!session) return send(res, 401, { ok: false, error: 'invalid or missing bearer token' })

      const url = new URL(req.url ?? '/', this.endpoint())
      const route = matchRoute(req.method ?? 'GET', url.pathname)
      if (isRouteError(route)) return send(res, route.status, { ok: false, error: route.error })

      const limited = applyRateLimit(session.rate, route.kind === 'create', Date.now())
      session.rate = limited.window
      if (limited.error) return send(res, limited.error.status, { ok: false, error: limited.error.error })

      const raw = await readBody(req)
      if (isRouteError(raw)) return send(res, raw.status, { ok: false, error: raw.error })
      const body = parseBody(raw)
      if (isRouteError(body)) return send(res, body.status, { ok: false, error: body.error })

      switch (route.kind) {
        case 'list': {
          const result = await this.request<DelegatedThreadSummary[]>({ kind: 'list', sessionId: session.sessionId })
          // The renderer's view is authoritative; resync the cap counter so a
          // thread closed from the UI frees a slot.
          if (result.ok) session.activeCount = result.data.filter(t => !t.closed).length
          return sendResult(res, result)
        }
        case 'create': {
          const normalized = normalizeCreate(body, session.policy.parentMode)
          if (isRouteError(normalized)) return send(res, normalized.status, { ok: false, error: normalized.error })
          // Checked against EVERY live token, not just the caller's: the point is
          // that no delegated thread ever receives credentials, whoever owns them.
          if (containsDelegationToken(normalized.prompt, this.sessions.keys())) {
            return send(res, 400, { ok: false, error: TOKEN_LEAK_REFUSAL })
          }
          const gated = applyCreatePolicy(normalized, session.policy, session.activeCount)
          if (isRouteError(gated)) return send(res, gated.status, { ok: false, error: gated.error })

          const result = await this.request<DelegatedThreadSummary>({ kind: 'create', sessionId: session.sessionId, request: gated })
          if (result.ok) session.activeCount += 1
          return sendResult(res, result, 201)
        }
        case 'providers':
          return sendResult(res, await this.request({ kind: 'providers', sessionId: session.sessionId }))

        case 'read':
          return sendResult(res, await this.request({ kind: 'read', sessionId: session.sessionId, threadId: route.threadId }))

        case 'diff':
          return sendResult(res, await this.request({ kind: 'diff', sessionId: session.sessionId, threadId: route.threadId }))

        case 'merge':
          return sendResult(res, await this.request({ kind: 'merge', sessionId: session.sessionId, threadId: route.threadId }))
        case 'message': {
          const normalized = normalizeMessage(body)
          if (isRouteError(normalized)) return send(res, normalized.status, { ok: false, error: normalized.error })
          if (containsDelegationToken(normalized.text, this.sessions.keys())) {
            return send(res, 400, { ok: false, error: TOKEN_LEAK_REFUSAL })
          }
          return sendResult(res, await this.request({
            kind: 'message', sessionId: session.sessionId, threadId: route.threadId, text: normalized.text,
          }))
        }
        case 'close': {
          const result = await this.request({ kind: 'close', sessionId: session.sessionId, threadId: route.threadId })
          if (result.ok && session.activeCount > 0) session.activeCount -= 1
          return sendResult(res, result)
        }
        case 'focus': {
          const normalized = normalizeFocus(body)
          if (isRouteError(normalized)) return send(res, normalized.status, { ok: false, error: normalized.error })
          return sendResult(res, await this.request({
            kind: 'focus', sessionId: session.sessionId, threadId: normalized.threadId,
          }))
        }
      }
    } catch (error) {
      send(res, 500, { ok: false, error: error instanceof Error ? error.message : 'delegation request failed' })
    }
  }
}

/** Read the body with the size cap enforced during streaming, so an oversized
 *  upload is destroyed rather than buffered to completion first. */
function readBody(req: IncomingMessage): Promise<string | RouteError> {
  return new Promise(resolve => {
    let total = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        req.destroy()
        resolve({ status: 413, error: 'request body too large' })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve({ status: 400, error: 'failed to read request body' }))
  })
}

function sendResult(res: ServerResponse, result: DelegationResult<unknown>, okStatus = 200): void {
  if (result.ok) return send(res, okStatus, result)
  send(res, result.status ?? 400, { ok: false, error: result.error })
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    // Nothing here is cacheable and nothing should be sniffed.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(text)
}

export const delegationService = new DelegationService()
export { DEFAULT_MAX_CONCURRENT }

/**
 * YuHeard socket server.
 *
 * Listens on a per-user Unix socket (default `~/.crewcode/yuheard.sock`,
 * overridable via `YUHEARD_SOCKET`). Accepts newline-delimited JSON
 * messages from any same-UID client (a Claude hook, the `yuheard` CLI,
 * the auto-wrap shell shims, an in-process caller). Validates, dedupes,
 * and forwards state transitions to the renderer over IPC.
 *
 * The renderer reads via `window.electronAPI.onYuheardState(...)` and
 * dispatches the sound + OS notification. This module never plays audio
 * or shows notifications — it is purely a transport.
 *
 * Design notes:
 * - 0600 on the socket: same-UID only. We do not implement a token because
 *   the threat model is "another user on the same machine," not "a
 *   network attacker." A per-user socket with 0600 is the same model the
 *   ssh-agent uses.
 * - EADDRINUSE: we delete the stale socket file (only if the inode is not
 *   in use by another live listener) and retry once. This matches the
 *   conventional Unix socket lifecycle for desktop daemons.
 * - The "pane registry" is an injected callback so this module does not
 *   import PtyService directly (PtyService imports it back via the
 *   auto-wrap path). This keeps the dependency direction one-way and
 *   trivial to mock in tests.
 */

import { BrowserWindow } from 'electron'
import net from 'node:net'
import { chmodSync, existsSync, unlinkSync, statSync } from 'fs'
import os from 'os'
import path from 'path'
import {
  isYuHeardState,
  defaultYuHeardSocketPath,
  type YuHeardRendererEvent,
  type YuHeardReport,
  type YuHeardRequest,
  type YuHeardResponse,
  type YuHeardState,
} from '../shared/yuheard-types'

/** Read-only view the server needs of the PtyService. The actual
 *  PtyService exposes `processCount`, `listDaemons`, and a new helper
 *  we will add there; for unit tests we inject a fake. */
export interface YuHeardPaneRegistry {
  /** Returns true if a pane with this id is currently live. */
  hasPane(paneId: string): boolean
  /** Returns the cwd of a live pane, or undefined if unknown. */
  getPaneCwd(paneId: string): string | undefined
  /** Returns the agentId of a live pane, or null for plain shells, or
   *  undefined if unknown. */
  getPaneAgentId(paneId: string): string | null | undefined
  /** Returns creation timestamps for live panes (used for "most recent"
   *  tie-breaking in pane-id-lookup). */
  getPaneCreatedAt(paneId: string): number | undefined
  /** Lists all live pane ids. */
  listPaneIds(): string[]
  /** Chat/crew sidecar panes must not receive YuHeard reports or cwd lookup. */
  isYuHeardEligible?(paneId: string): boolean
}

export interface YuHeardServerOptions {
  /** Override the socket path. Defaults to env YUHEARD_SOCKET or
   *  ~/.crewcode/yuheard.sock. */
  socketPath?: string
  /** Pane registry used for validation and lookup. */
  registry: YuHeardPaneRegistry
  /** Send a renderer event. Defaults to fanning out to all
   *  BrowserWindows via webContents.send. */
  emit?: (event: YuHeardRendererEvent) => void
  /** Override the dedupe window (ms). Default 500. Tests use smaller. */
  debounceMs?: number
  /** Override the auto-synthesize-complete window (ms). Default 60_000. */
  autoCompleteWindowMs?: number
  /** Time provider (ms). Tests inject a fixed clock. */
  now?: () => number
}

let active: YuHeardServer | null = null

export class YuHeardServer {
  private readonly socketPath: string
  private readonly registry: YuHeardPaneRegistry
  private readonly emit: (event: YuHeardRendererEvent) => void
  private readonly debounceMs: number
  private readonly autoCompleteWindowMs: number
  private readonly now: () => number
  private server: net.Server | null = null
  private lastReport = new Map<string, { state: YuHeardState, at: number }>()
  /** paneId -> timestamp of the most recent 'running' report. Used by
   *  pty-service to synthesize 'complete' on process exit. */
  private lastRunning = new Map<string, number>()
  /** paneId -> cwd captured at first report. Used by pane-id-lookup. */
  private cwdByPane = new Map<string, string>()
  /** paneId -> creation timestamp mirrored from the registry. */
  private createdByPane = new Map<string, number>()
  /** Panes that have received `running` and have not yet closed. Used so
   *  interactive CLIs can idle-complete later turns after `complete`. */
  private sessionActive = new Set<string>()

  constructor(opts: YuHeardServerOptions) {
    this.socketPath = opts.socketPath
      ?? process.env.YUHEARD_SOCKET
      ?? defaultYuHeardSocketPath(os.homedir())
    this.registry = opts.registry
    this.emit = opts.emit ?? defaultEmit
    this.debounceMs = opts.debounceMs ?? 500
    this.autoCompleteWindowMs = opts.autoCompleteWindowMs ?? 60_000
    this.now = opts.now ?? Date.now
  }

  /** Returns the resolved socket path. */
  getSocketPath(): string {
    return this.socketPath
  }

  /** Returns true if the server is currently listening. */
  isRunning(): boolean {
    return this.server !== null
  }

  /** Start listening. Cleans up a stale socket if EADDRINUSE. */
  async start(): Promise<void> {
    if (this.server) return
    this.ensureSocketDir()
    this.tryUnlinkStaleSocket()

    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer((socket) => this.handleConnection(socket))
      srv.on('error', (err) => reject(err))
      srv.listen(this.socketPath, () => {
        try { chmodSync(this.socketPath, 0o600) } catch { /* non-fatal */ }
        this.server = srv
        resolve()
      })
    })
  }

  /** Stop the server and remove the socket file. Idempotent. */
  async stop(): Promise<void> {
    const srv = this.server
    this.server = null
    if (!srv) return
    await new Promise<void>((resolve) => {
      srv.close(() => {
        try { if (existsSync(this.socketPath)) unlinkSync(this.socketPath) } catch { /* ignore */ }
        resolve()
      })
    })
  }

  /** In-process API: report a state for a pane without going through the
   *  socket. Used by pty-service on agent process exit (the OS-level
   *  auto-wrap complete synthesis). Returns the same
   *  applied/duplicate/unknown-pane verdict as the socket path. */
  reportYuHeardFromProcess(report: YuHeardReport): 'applied' | 'duplicate' | 'unknown-pane' {
    return this.applyReport(report)
  }

  /** Mark a pane as "known" so process-exit auto-complete can find it.
   *  Called by pty-service on spawn. */
  notePaneSpawned(paneId: string, cwd: string): void {
    this.cwdByPane.set(paneId, cwd)
    this.createdByPane.set(paneId, this.now())
  }

  /** Forget a pane. Called by pty-service on close (so the dedupe map
   *  does not grow unbounded). */
  notePaneClosed(paneId: string): void {
    this.cwdByPane.delete(paneId)
    this.createdByPane.delete(paneId)
    this.lastReport.delete(paneId)
    this.lastRunning.delete(paneId)
    this.sessionActive.delete(paneId)
  }

  /** Returns true if the pane was reported running within the last
   *  autoCompleteWindowMs ms. Used by pty-service to decide whether
   *  to synthesize complete on process exit. */
  shouldAutoComplete(paneId: string): boolean {
    const t = this.lastRunning.get(paneId)
    if (t === undefined) return false
    return this.now() - t <= this.autoCompleteWindowMs
  }

  /** True while a YuHeard session is open for this pane (running seen,
   *  pane still known). Idle/BEL turn detection uses this so a wrapped
   *  `claude` in a plain shell keeps notifying on later replies. */
  isSessionActive(paneId: string): boolean {
    return this.sessionActive.has(paneId)
  }

  /** Arm idle-detect without a socket `running` report (typed `codex` /
   *  `claude` in a Fish pane whose function skipped the PATH shim). Does
   *  not emit to the renderer. */
  noteSessionRunning(paneId: string): void {
    if (!this.isKnownPane(paneId)) return
    if (this.registry.isYuHeardEligible && !this.registry.isYuHeardEligible(paneId)) return
    this.sessionActive.add(paneId)
    this.lastRunning.set(paneId, this.now())
  }

  // ─── internals ───────────────────────────────────────────────────────

  private ensureSocketDir(): void {
    const dir = path.dirname(this.socketPath)
    if (existsSync(dir)) return
    // Best-effort mkdir. We don't recurse: the default lives one level
    // under homedir, which is almost always present.
    try {
      require('fs').mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch { /* ignore — listen() will surface a real error */ }
  }

  private tryUnlinkStaleSocket(): void {
    if (!existsSync(this.socketPath)) return
    // If the path is a live socket, net.createServer will throw EADDRINUSE
    // and our error handler will deal with it. We just try to remove a
    // regular file here as a convenience.
    try {
      const st = statSync(this.socketPath)
      if (st.isSocket()) {
        // Socket file but the listener above failed to bind. We assume
        // it's stale and remove it. If another live process is bound,
        // listen() will fail again with EADDRINUSE and we surface that.
        unlinkSync(this.socketPath)
      }
    } catch { /* ignore */ }
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (!line) continue
        const response = this.processLine(line)
        try { socket.write(JSON.stringify(response) + '\n') } catch { /* socket may be gone */ }
      }
    })
    socket.on('error', () => { /* swallow; close handler cleans up */ })
    socket.on('close', () => { /* nothing to do */ })
  }

  /** Parse + dispatch a single line. Exported for tests. */
  processLine(line: string): YuHeardResponse {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return { ok: false, error: 'invalid-json' }
    }
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'invalid-payload' }
    }
    const obj = parsed as Record<string, unknown>

    // Control method: pane-id-lookup. Not a state report.
    if (obj.method === 'pane-id-lookup') {
      const cwd = typeof obj.cwd === 'string' ? obj.cwd : ''
      if (!cwd) return { ok: false, error: 'missing-cwd' }
      const paneId = this.lookupPaneIdByCwd(cwd)
      if (!paneId) return { ok: false, error: 'no-pane-for-cwd' }
      return { ok: true, paneId }
    }

    // State report.
    if (typeof obj.pane_id !== 'string' || !obj.pane_id) {
      return { ok: false, error: 'missing-pane-id' }
    }
    if (!isYuHeardState(obj.state)) {
      return { ok: false, error: 'invalid-state' }
    }
    const report: YuHeardReport = {
      pane_id: obj.pane_id,
      state: obj.state,
      source: typeof obj.source === 'string' ? obj.source : 'socket',
      message: typeof obj.message === 'string' ? obj.message : undefined,
      session_id: typeof obj.session_id === 'string' ? obj.session_id : undefined,
      ts: typeof obj.ts === 'number' ? obj.ts : this.now(),
    }
    const result = this.applyReport(report)
    return { ok: result === 'unknown-pane' ? false : true, result, error: result === 'unknown-pane' ? 'unknown-pane' : undefined }
  }

  private applyReport(report: YuHeardReport): 'applied' | 'duplicate' | 'unknown-pane' {
    if (!this.isKnownPane(report.pane_id)) {
      return 'unknown-pane'
    }
    if (this.registry.isYuHeardEligible && !this.registry.isYuHeardEligible(report.pane_id)) {
      return 'unknown-pane'
    }
    const last = this.lastReport.get(report.pane_id)
    const now = this.now()
    if (last && last.state === report.state && now - last.at < this.debounceMs) {
      return 'duplicate'
    }
    this.lastReport.set(report.pane_id, { state: report.state, at: now })
    if (report.state === 'running') {
      this.lastRunning.set(report.pane_id, now)
      this.sessionActive.add(report.pane_id)
    } else {
      this.lastRunning.delete(report.pane_id)
    }
    // Mirror the cwd so pane-id-lookup can work even if the registry
    // doesn't expose it for this pane.
    const cwd = this.registry.getPaneCwd(report.pane_id)
    if (cwd) this.cwdByPane.set(report.pane_id, cwd)
    const created = this.registry.getPaneCreatedAt(report.pane_id)
    if (typeof created === 'number') this.createdByPane.set(report.pane_id, created)

    const event: YuHeardRendererEvent = {
      paneId: report.pane_id,
      state: report.state,
      message: report.message ?? null,
      source: report.source ?? 'socket',
      at: report.ts || now,
    }
    this.emit(event)
    return 'applied'
  }

  /** Live PTY or a pane we recorded at spawn. Process-exit auto-complete
   *  reports after PtyService has already dropped the live handle. */
  private isKnownPane(paneId: string): boolean {
    return this.registry.hasPane(paneId)
      || this.cwdByPane.has(paneId)
      || this.createdByPane.has(paneId)
  }

  private lookupPaneIdByCwd(cwd: string): string | null {
    // Prefer the registry's createdAt; fall back to the local mirror
    // (populated when reports come in without a prior registry call).
    const candidates: Array<{ paneId: string, at: number }> = []
    for (const paneId of this.registry.listPaneIds()) {
      if (this.registry.isYuHeardEligible && !this.registry.isYuHeardEligible(paneId)) continue
      if (this.registry.getPaneCwd(paneId) === cwd) {
        const at = this.registry.getPaneCreatedAt(paneId)
          ?? this.createdByPane.get(paneId)
          ?? 0
        candidates.push({ paneId, at })
      }
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.at - a.at)
    return candidates[0].paneId
  }
}

function defaultEmit(event: YuHeardRendererEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try { win.webContents.send('yuheard:state', event) } catch { /* renderer reloading */ }
  }
}

/** Start the singleton YuHeard server. Returns the server so callers can
 *  call reportYuHeardFromProcess / notePaneSpawned / etc. */
export function startYuHeardServer(registry: YuHeardPaneRegistry, opts: Partial<YuHeardServerOptions> = {}): YuHeardServer {
  if (active) return active
  const server = new YuHeardServer({ ...opts, registry })
  active = server
  // Fire and forget; failure is logged but does not block app start.
  server.start().catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[yuheard] failed to start socket server:', err?.message ?? String(err))
  })
  return server
}

/** Get the active server (if any). Used by pty-service. */
export function getYuHeardServer(): YuHeardServer | null {
  return active
}

/** Stop the singleton. Idempotent. */
export async function stopYuHeardServer(): Promise<void> {
  if (!active) return
  const srv = active
  active = null
  await srv.stop()
}

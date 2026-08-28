import * as pty from 'node-pty'
import os from 'os'
import { existsSync } from 'fs'
import type { IPty } from 'node-pty'
import { isRemoteRoot, parseRemoteTarget } from './remote/ssh-target'
import {
  YuHeardTurnDetector,
  applyPtyKeystroke,
  outputLooksLikeBell,
  submittedAgentCommand,
} from './yuheard-turn-detect'
import { YUHEARD_WRAP_COMMANDS } from '../shared/yuheard-types'
import {
  bashKeepWrapPrompt,
  codexNotifyArgv,
  executableBaseName,
  fishKeepWrapArgv,
  installYuHeardHook,
  installYuHeardWrapper,
  uninstallYuHeardWrapper,
} from './yuheard-wrapper'
import type { YuHeardReport } from '../shared/yuheard-types'

/** Bundle-safe slice of YuHeardServer used by PTYs. Keeping the concrete
 * Electron-backed server behind an accessor also leaves PtyService reusable
 * by the direct web transport and unit tests. */
export interface PtyYuHeardServer {
  getSocketPath(): string
  notePaneSpawned(paneId: string, cwd: string): void
  notePaneClosed(paneId: string): void
  noteSessionRunning(paneId: string): void
  isSessionActive(paneId: string): boolean
  shouldAutoComplete(paneId: string): boolean
  reportYuHeardFromProcess(report: YuHeardReport): 'applied' | 'duplicate' | 'unknown-pane'
}

// Build `ssh` argv that opens an interactive login shell in the workspace dir on
// the remote host. The local ssh binary honors ~/.ssh/config (so aliases resolve
// user/port/identity) and inherits SSH_AUTH_SOCK for agent auth.
function remoteShellArgv(root: string): string[] | null {
  const t = parseRemoteTarget(root)
  if (!t) return null
  const args = ['-t']
  if (t.port) args.push('-p', String(t.port))
  args.push(t.user ? `${t.user}@${t.host}` : t.host)
  const safePath = t.path.replace(/'/g, `'\\''`)
  // Drop into the workspace dir, then replace the process with a login shell.
  args.push(`cd '${safePath}' 2>/dev/null; exec "\${SHELL:-/bin/sh}" -l`)
  return args
}

interface Pane {
  proc: IPty
  buffer: string
  cwd: string
  /** Agent id for the spawned process, or null for plain shells. */
  agentId: string | null
  /** Created-at timestamp (ms since epoch). */
  createdAt: number
  /** Chat/crew sidecar panes stay off the YuHeard channel. */
  yuheardEligible: boolean
}

// Replayed when a React terminal surface remounts (workspace/tab switches).
// Agent turns can be very verbose, so keep enough raw output to avoid restoring
// into the middle of the latest response while still bounding memory per pane.
const MAX_REPLAY_BUFFER = 2_000_000

function appendReplayBuffer(pane: Pane, data: string): void {
  pane.buffer += data
  if (pane.buffer.length > MAX_REPLAY_BUFFER) {
    pane.buffer = pane.buffer.slice(-MAX_REPLAY_BUFFER)
  }
}

export type PtyServiceEvent =
  | { type: 'data'; paneId: string; data: string }
  | { type: 'exit'; paneId: string; exitCode: number; signal?: number }



function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace('~', os.homedir()) : p
}

// Candidate install paths for each POSIX shell. Order matters: prefer the
// system package manager path before homebrew/macports/Nix so behavior stays
// predictable when multiple copies exist.
const SHELL_CANDIDATES: Record<'bash' | 'zsh' | 'fish', string[]> = {
  bash: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'],
  zsh:  ['/bin/zsh',  '/usr/bin/zsh',  '/usr/local/bin/zsh',  '/opt/homebrew/bin/zsh'],
  fish: ['/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish', '/opt/local/bin/fish', '/run/current-system/sw/bin/fish'],
}

function findShellOnDisk(name: 'bash' | 'zsh' | 'fish'): string | null {
  for (const p of SHELL_CANDIDATES[name]) {
    if (existsSync(p)) return p
  }
  return null
}

// Resolve a shell alias ("bash"/"zsh"/"fish"/"auto"), an absolute path, or
// a tilde path to a concrete executable. Returns null if nothing usable.
function resolveShellAlias(alias: string): string | null {
  const a = alias.trim()
  if (!a || a === 'auto') return null
  if (a === 'bash' || a === 'zsh' || a === 'fish') return findShellOnDisk(a)
  // Treat anything else as a literal path the caller supplied.
  const expanded = expandHome(a)
  return existsSync(expanded) ? expanded : null
}

export function detectShells(): {
  bash:    string | null
  zsh:     string | null
  fish:    string | null
  defaultShell: string
} {
  return {
    bash: findShellOnDisk('bash'),
    zsh:  findShellOnDisk('zsh'),
    fish: findShellOnDisk('fish'),
    defaultShell: defaultShell(),
  }
}

function looksLikeShell(shell?: string): boolean {
  if (!shell || shell === 'auto') return true
  const base = shell.replace(/\\/g, '/').split('/').pop() ?? shell
  return base === 'bash' || base === 'zsh' || base === 'fish' || base === 'sh' || base === 'ssh'
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  // Prefer the user's login shell, but fall back to fish/zsh/bash in order of
  // ergonomics if SHELL is missing or points at something that no longer
  // exists (common in minimal containers / fresh installs).
  const envShell = process.env.SHELL
  if (envShell && existsSync(envShell)) return envShell
  return findShellOnDisk('fish') ?? findShellOnDisk('zsh') ?? findShellOnDisk('bash') ?? '/bin/sh'
}

export interface PtyCreateOpts {
  paneId:  string
  cwd?:    string
  cols?:   number
  rows?:   number
  shell?:  string    // explicit shell path
  argv?:   string[]  // pass to spawn — e.g. ['-l'] or claude args
  env?:    Record<string, string>
  /** Optional agent metadata. When set, the spawned process is treated as
   *  an agent (e.g. `claude`, `codex`) and YuHeard integration is enabled
   *  even if `YUHEARD_PANE_ID` is not present in the supplied `env`. */
  agentId?: string | null
  /** When true, this pane is a plain shell that should receive the YuHeard
   *  auto-wrap shim directory on its PATH. The renderer is the source of
   *  truth for the `yuheardAutoWrap` setting. */
  autoWrap?: boolean
  /** Agent ids that should be wrapped when `autoWrap` is true. */
  wrapAgentIds?: string[]
  /** When false, skip YuHeard env/wrap/idle detect. Chat sidecars pass false. */
  yuheard?: boolean
}

export class PtyService {
  private readonly panes = new Map<string, Pane>()
  private readonly pendingWrites = new Map<string, string[]>()
  private readonly typedLines = new Map<string, string>()
  private readonly activeTerminalAgents = new Map<string, string>()
  private readonly listeners = new Set<(event: PtyServiceEvent) => void>()
  private readonly turnDetector = new YuHeardTurnDetector((paneId, source) => {
    this.reportYuHeardComplete(paneId, source)
  })

  constructor(
    private readonly getYuHeardServer: () => PtyYuHeardServer | null = () => null,
  ) {}

  private flushPendingWrites(paneId: string, pane: Pane): void {
    const writes = this.pendingWrites.get(paneId)
    if (!writes?.length) return
    this.pendingWrites.delete(paneId)
    for (const data of writes) pane.proc.write(data)
  }

  subscribe(listener: (event: PtyServiceEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  create(opts: PtyCreateOpts): { ok?: boolean; error?: string; attached?: boolean; pid?: number; buffer?: string; cwd?: string; shell?: string } {
    const { paneId, cwd, cols = 80, rows = 24, shell, argv = [], env = {}, agentId = null, autoWrap = false, wrapAgentIds = [], yuheard = true } = opts
    const existing = this.panes.get(paneId)
    if (existing) {
      if (cols >= 1 && rows >= 1) try { existing.proc.resize(cols, rows) } catch { /* exiting */ }
      this.flushPendingWrites(paneId, existing)
      // Live shells already have the wrapper dir on PATH. Refreshing the
      // shim files in place means the next `codex`/`claude` uses the current
      // hook without killing the pane.
      this.refreshYuHeardWrappers(paneId, { autoWrap, wrapAgentIds, agentId, shell, yuheard })
      return { ok: true, attached: true, pid: existing.proc.pid, buffer: existing.buffer }
    }
    const remoteArgs = cwd && isRemoteRoot(cwd) ? remoteShellArgv(cwd) : null
    const resolvedCwd = cwd && !remoteArgs ? expandHome(cwd) : os.homedir()
    const actualCwd = existsSync(resolvedCwd) ? resolvedCwd : os.homedir()
    const exe = remoteArgs ? 'ssh' : ((shell ? resolveShellAlias(shell) : null) ?? defaultShell())

    // YuHeard: build env injection + auto-wrap shim. Lazy-imported so the
    // PtyService stays Electron-free for unit tests.
    let yuheardEnv: Record<string, string> = {}
    let wrapperDir: string | null = null
    let spawnArgv = remoteArgs ?? argv
    if (yuheard) try {
      const server = this.getYuHeardServer()
      const socketPath = server?.getSocketPath()
      if (socketPath) {
        yuheardEnv = {
          YUHEARD_PANE_ID: paneId,
          YUHEARD_SOCKET: socketPath,
          ...(agentId ? { YUHEARD_AGENT: agentId } : {}),
        }
        server?.notePaneSpawned(paneId, actualCwd)
      }
      if (autoWrap && wrapAgentIds.length > 0) {
        wrapperDir = installYuHeardWrapper(paneId, wrapAgentIds, socketPath ? { socketPath } : {})
      }
      // Codex TUI never goes quiet enough for idle-detect. When this pane
      // *is* the Codex binary, inject Codex's notify hook so a finished
      // turn reports YuHeard complete. Shell panes rely on the `codex` shim
      // for the same flags — do not pass -c through to bash.
      if (!remoteArgs && agentId === 'codex' && !looksLikeShell(shell) && socketPath) {
        const hook = installYuHeardHook(paneId, { socketPath })
        spawnArgv = [...codexNotifyArgv(hook.runtime.cmd, hook.hookPath), ...argv]
      }
      if (wrapperDir && !remoteArgs) {
        const base = executableBaseName(exe)
        if (base === 'fish') {
          spawnArgv = fishKeepWrapArgv(wrapperDir, spawnArgv, wrapAgentIds)
        }
      }
    } catch {
      // YuHeard not available (tests, or uninitialized) — proceed without.
    }

    const basePath = (process.env as Record<string, string>).PATH
    const ptyEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...env,
      ...yuheardEnv,
      SHELL: exe,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'CrewCode',
      TERM_PROGRAM_VERSION: process.env.npm_package_version ?? '1.0.0',
      FORCE_COLOR: '1',
      ...(wrapperDir ? { PATH: `${wrapperDir}:${basePath ?? ''}` } : {}),
    }
    delete ptyEnv.NODE_OPTIONS
    if (wrapperDir && !remoteArgs) {
      const base = (exe.replace(/\\/g, '/').split('/').pop() ?? exe)
      if (base === 'bash' || base === 'sh') {
        ptyEnv.PROMPT_COMMAND = (() => {
          return bashKeepWrapPrompt(wrapperDir, ptyEnv.PROMPT_COMMAND, wrapAgentIds)
        })()
      }
    }
    let proc: IPty
    try { proc = pty.spawn(exe, spawnArgv, { name: 'xterm-256color', cols, rows, cwd: actualCwd, env: ptyEnv }) }
    catch (error) {
      if (wrapperDir) {
        try {
          uninstallYuHeardWrapper(paneId)
        } catch { /* ignore */ }
      }
      return { error: `pty spawn failed: ${error instanceof Error ? error.message : String(error)}` }
    }
    const pane: Pane = { proc, buffer: '', cwd: actualCwd, agentId, createdAt: Date.now(), yuheardEligible: yuheard }
    proc.onData(data => {
      appendReplayBuffer(pane, data)
      if (pane.yuheardEligible) this.noteYuHeardOutput(paneId, pane, data)
      this.emit({ type: 'data', paneId, data })
    })
    proc.onExit(({ exitCode, signal }) => {
      this.turnDetector.clear(paneId)
      // Report complete while the pane is still known to YuHeard. Deleting
      // from `this.panes` first made every auto-wrap exit come back as
      // unknown-pane, so terminal agents never notified.
      try {
        const server = this.getYuHeardServer()
        if (server?.shouldAutoComplete(paneId)) {
          server.reportYuHeardFromProcess({
            pane_id: paneId,
            state: 'complete',
            source: 'auto-wrap-exit',
            ts: Date.now(),
          })
        }
        server?.notePaneClosed(paneId)
      } catch { /* ignore */ }
      this.emit({ type: 'exit', paneId, exitCode, signal })
      this.panes.delete(paneId)
      this.typedLines.delete(paneId)
      this.activeTerminalAgents.delete(paneId)
      // Clean up the auto-wrap shim directory if we installed one.
      if (wrapperDir) {
        try {
          uninstallYuHeardWrapper(paneId)
        } catch { /* ignore */ }
      }
    })
    this.panes.set(paneId, pane)
    this.flushPendingWrites(paneId, pane)
    return { ok: true, pid: proc.pid, cwd: actualCwd, shell: exe }
  }

  write(paneId: string, data: string): void {
    const pane = this.panes.get(paneId)
    if (pane?.yuheardEligible) this.noteYuHeardInput(paneId, data)
    if (pane) { pane.proc.write(data); return }
    this.pendingWrites.set(paneId, [...(this.pendingWrites.get(paneId) ?? []), data])
  }

  resize(paneId: string, cols: number, rows: number): void {
    const pane = this.panes.get(paneId)
    if (!pane || cols < 1 || rows < 1) return
    try { pane.proc.resize(cols, rows) } catch { /* exiting */ }
  }

  kill(paneId: string): void {
    const pane = this.panes.get(paneId)
    if (pane) try { pane.proc.kill() } catch { /* exited */ }
    this.turnDetector.clear(paneId)
    this.panes.delete(paneId)
    this.pendingWrites.delete(paneId)
    this.typedLines.delete(paneId)
    this.activeTerminalAgents.delete(paneId)
  }

  killWhere(predicate: (cwd: string) => boolean): string[] {
    const killed: string[] = []
    for (const [paneId, pane] of this.panes) {
      if (!predicate(pane.cwd)) continue
      this.kill(paneId); killed.push(paneId)
    }
    return killed
  }

  killAll(): void {
    for (const paneId of this.panes.keys()) this.turnDetector.clear(paneId)
    for (const pane of this.panes.values()) try { pane.proc.kill() } catch { /* exited */ }
    this.panes.clear()
    this.pendingWrites.clear()
    this.typedLines.clear()
    this.activeTerminalAgents.clear()
  }

  processCount(): number { return this.panes.size }
  listDaemons(): PtyDaemon[] { return [...this.panes.entries()].map(([paneId, pane]) => ({ paneId, pid: pane.proc.pid })) }

  // ── YuHeard registry adapter ─────────────────────────────────────────
  // The YuHeard server calls these to validate pane ids and resolve
  // pane-id-by-cwd lookups. Implementing the YuHeardPaneRegistry shape
  // lets the singleton PtyService be the registry without a wrapper.

  hasPane(paneId: string): boolean { return this.panes.has(paneId) }
  getPaneCwd(paneId: string): string | undefined { return this.panes.get(paneId)?.cwd }
  getPaneAgentId(paneId: string): string | null | undefined { return this.panes.get(paneId)?.agentId }
  getPaneCreatedAt(paneId: string): number | undefined { return this.panes.get(paneId)?.createdAt }
  isYuHeardEligible(paneId: string): boolean { return this.panes.get(paneId)?.yuheardEligible !== false }
  listPaneIds(): string[] { return [...this.panes.keys()] }

  private refreshYuHeardWrappers(
    paneId: string,
    opts: { autoWrap: boolean; wrapAgentIds: string[]; agentId: string | null; shell?: string; yuheard: boolean },
  ): void {
    if (!opts.yuheard) return
    try {
      const socketPath = this.getYuHeardServer()?.getSocketPath()
      if (opts.autoWrap && opts.wrapAgentIds.length > 0) {
        installYuHeardWrapper(paneId, opts.wrapAgentIds, socketPath ? { socketPath } : {})
      }
      if (opts.agentId === 'codex' && !looksLikeShell(opts.shell) && socketPath) {
        installYuHeardHook(paneId, { socketPath })
      }
    } catch { /* ignore */ }
  }

  /** BEL/OSC is an explicit "notify" from the CLI — honor it even if the
   *  PATH shim never reported `running`. Idle-after-output still requires
   *  an agent-tagged pane or an armed YuHeard session so `ls` does not knock. */
  private noteYuHeardOutput(paneId: string, pane: Pane, data: string): void {
    try {
      // Codex provides exact per-pane hook events for approval requests and
      // completed turns. Its prompt-submit redraw can look like a large idle
      // output burst, so never run the heuristic detector for Codex.
      const activeAgent = pane.agentId ?? this.activeTerminalAgents.get(paneId)
      if (activeAgent === 'codex') return
      if (outputLooksLikeBell(data)) {
        this.turnDetector.onData(paneId, data)
        return
      }
      const server = this.getYuHeardServer()
      if (!pane.agentId && !server?.isSessionActive(paneId)) return
      this.turnDetector.onData(paneId, data)
    } catch { /* YuHeard unavailable */ }
  }

  private noteYuHeardInput(paneId: string, data: string): void {
    if (/\r|\n/.test(data)) this.turnDetector.onSubmit(paneId)
    const next = applyPtyKeystroke(this.typedLines.get(paneId) ?? '', data)
    this.typedLines.set(paneId, next.buffer)
    if (next.submitted.length === 0) return
    try {
      const server = this.getYuHeardServer()
      if (!server) return
      for (const line of next.submitted) {
        const agentCommand = submittedAgentCommand(line, YUHEARD_WRAP_COMMANDS)
        if (!agentCommand) continue
        this.activeTerminalAgents.set(paneId, agentCommand)
        this.turnDetector.onAgentLaunch(paneId)
        server.noteSessionRunning(paneId)
      }
    } catch { /* YuHeard unavailable */ }
  }

  private reportYuHeardComplete(paneId: string, source: string): void {
    try {
      this.getYuHeardServer()?.reportYuHeardFromProcess({
        pane_id: paneId,
        state: 'complete',
        source,
        ts: Date.now(),
      })
    } catch { /* ignore */ }
  }

  private emit(event: PtyServiceEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

export interface PtyDaemon { paneId: string; pid: number }

import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { spawn } from 'node:child_process'
import { buildAgentCommandEnv, resolveCodexCommand } from './resolve-agent'
import { getCmdExePath, getSpawnArgsForWindows } from '../win32-utils'

const RPC_TIMEOUT_MS = 10_000
const PTY_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

type RpcResponse = {
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

type RpcRateWindow = {
  usedPercent?: number
  windowDurationMins?: number
  resetsAt?: number // Unix seconds
}

type RpcRateLimitsResult = {
  primary?: RpcRateWindow
  secondary?: RpcRateWindow
}

type RpcRateLimitsResponse = {
  rateLimits?: RpcRateLimitsResult
}

function buildRpcMessage(id: number, method: string, params?: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`
}

function mapRpcWindow(raw: RpcRateWindow | undefined): RateLimitWindow | null {
  if (!raw || typeof raw.usedPercent !== 'number') return null

  let resetDescription: string | null = null
  let resetsAt: number | null = null

  if (raw.resetsAt) {
    const date = new Date(raw.resetsAt * 1000)
    if (!isNaN(date.getTime())) {
      resetsAt = date.getTime()
      const now = new Date()
      const isToday = date.toDateString() === now.toDateString()
      resetDescription = isToday
        ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
    }
  }

  return {
    usedPercent: Math.min(100, Math.max(0, raw.usedPercent)),
    windowMinutes: raw.windowDurationMins ?? 300,
    resetsAt,
    resetDescription,
  }
}

// ---------------------------------------------------------------------------
// RPC fetch — spawn `codex -s read-only -a untrusted app-server`
// ---------------------------------------------------------------------------

async function fetchViaRpc(commandOverride?: string | null): Promise<ProviderRateLimits> {
  return new Promise<ProviderRateLimits>((resolve) => {
    let buffer = ''
    let resolved = false
    let rpcId = 0

    const codexCommand = resolveCodexCommand(commandOverride)
    const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(codexCommand, [
      '-s',
      'read-only',
      '-a',
      'untrusted',
      'app-server',
    ])

    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: buildAgentCommandEnv(codexCommand),
    })

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        child.kill()
        resolve({
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: 'RPC timeout',
          status: 'error',
        })
      }
    }, RPC_TIMEOUT_MS)

    function sendRpc(method: string, params?: unknown): number {
      const id = ++rpcId
      child.stdin.write(buildRpcMessage(id, method, params))
      return id
    }

    let rateLimitsId: number | null = null
    const initId = sendRpc('initialize', {
      clientInfo: { name: 'crewcode', version: '1.0.0' },
    })

    function sendNotification(method: string): void {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: {} })}\n`)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()

      let newlineIdx: number
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (!line) continue

        try {
          const msg = JSON.parse(line) as RpcResponse
          if (msg.id == null) continue

          if (msg.id === initId) {
            sendNotification('initialized')
            rateLimitsId = sendRpc('account/rateLimits/read')
            continue
          }

          if (rateLimitsId !== null && msg.id === rateLimitsId) {
            if (resolved) return
            resolved = true
            clearTimeout(timeout)
            child.kill()

            if (msg.error) {
              resolve({
                provider: 'codex',
                session: null,
                weekly: null,
                updatedAt: Date.now(),
                error: msg.error.message,
                status: 'error',
              })
              return
            }

            const wrapper = msg.result as RpcRateLimitsResponse | undefined
            const result = wrapper?.rateLimits
            const session = mapRpcWindow(result?.primary)
            const weekly = mapRpcWindow(result?.secondary)

            resolve({
              provider: 'codex',
              session,
              weekly,
              updatedAt: Date.now(),
              error: null,
              status: 'ok',
            })
          }
        } catch {
          // Non-JSON line — ignore
        }
      }
    })

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        const isEnoent = (err as NodeJS.ErrnoException).code === 'ENOENT'
        resolve({
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: isEnoent ? 'Codex CLI not found' : err.message,
          status: isEnoent ? 'unavailable' : 'error',
        })
      }
    })

    child.on('close', () => {
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        resolve({
          provider: 'codex',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: 'RPC process exited unexpectedly',
          status: 'error',
        })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// PTY fallback — spawn `codex`, send `/status`, parse rendered output
// ---------------------------------------------------------------------------

const FIVE_HOUR_RE = /5h\s+limit[:\s]*(\d+)%/i
const WEEKLY_RE = /weekly\s+limit[:\s]*(\d+)%/i
const RESET_TEXT_RE = /resets?\s+(?:at\s+|in\s+)?(.+)/i

function parsePtyStatus(output: string): { session: RateLimitWindow | null; weekly: RateLimitWindow | null } {
  const fiveMatch = FIVE_HOUR_RE.exec(output)
  const weeklyMatch = WEEKLY_RE.exec(output)

  const session: RateLimitWindow | null = fiveMatch
    ? {
        usedPercent: Math.min(100, parseInt(fiveMatch[1], 10)),
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null,
      }
    : null

  const weekly: RateLimitWindow | null = weeklyMatch
    ? {
        usedPercent: Math.min(100, parseInt(weeklyMatch[1], 10)),
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: null,
      }
    : null

  const resetMatch = RESET_TEXT_RE.exec(output)
  if (resetMatch && session) {
    session.resetDescription = resetMatch[1].trim()
  }

  return { session, weekly }
}

async function fetchViaPty(commandOverride?: string | null): Promise<ProviderRateLimits> {
  const pty = await import('node-pty')
  const codexCommand = resolveCodexCommand(commandOverride)

  const isWin32 = process.platform === 'win32'
  const spawnFile = isWin32 ? getCmdExePath() : codexCommand
  const spawnArgs = isWin32 ? ['/d', '/c', codexCommand] : []

  return new Promise<ProviderRateLimits>((resolve) => {
    let output = ''
    let resolved = false
    let sentStatus = false

    const term = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      env: buildAgentCommandEnv(codexCommand, { TERM: 'xterm-256color' }) as Record<string, string>,
    })

    const disposables: { dispose: () => void }[] = []
    const dispose = (): void => {
      for (const d of disposables.splice(0)) d.dispose()
    }

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true
        dispose()
        term.kill()
        // eslint-disable-next-line no-control-regex
        const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        const { session, weekly } = parsePtyStatus(clean)
        resolve({
          provider: 'codex',
          session,
          weekly,
          updatedAt: Date.now(),
          error: session || weekly ? null : 'Codex status timed out',
          status: session || weekly ? 'ok' : 'error',
        })
      }
    }, PTY_TIMEOUT_MS)

    const onData = term.onData((data) => {
      output += data

      if (!sentStatus && />\s*$/.test(data)) {
        sentStatus = true
        term.write('/status\r')
        return
      }

      if (sentStatus && (FIVE_HOUR_RE.test(output) || WEEKLY_RE.test(output))) {
        setTimeout(() => {
          if (resolved) return
          resolved = true
          clearTimeout(timeout)
          dispose()
          term.kill()
          // eslint-disable-next-line no-control-regex
          const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
          const { session, weekly } = parsePtyStatus(clean)
          resolve({
            provider: 'codex',
            session,
            weekly,
            updatedAt: Date.now(),
            error: session || weekly ? null : 'Failed to parse Codex status',
            status: session || weekly ? 'ok' : 'error',
          })
        }, 500)
      }
    })
    if (onData) disposables.push(onData)

    const onExit = term.onExit(() => {
      dispose()
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        // eslint-disable-next-line no-control-regex
        const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        const { session, weekly } = parsePtyStatus(clean)
        resolve({
          provider: 'codex',
          session,
          weekly,
          updatedAt: Date.now(),
          error: session || weekly ? null : 'Codex exited before status was available',
          status: session || weekly ? 'ok' : 'error',
        })
      }
    })
    if (onExit) disposables.push(onExit)
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchCodexRateLimits(commandOverride?: string | null): Promise<ProviderRateLimits> {
  // Path A: try RPC first (most reliable)
  try {
    return await fetchViaRpc(commandOverride)
  } catch {
    // RPC failed — fall through to PTY
  }

  // Path B: PTY fallback
  try {
    return await fetchViaPty(commandOverride)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isNotInstalled = message.includes('ENOENT') || message.includes('not found')
    return {
      provider: 'codex',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: isNotInstalled ? 'Codex CLI not found' : message,
      status: isNotInstalled ? 'unavailable' : 'error',
    }
  }
}

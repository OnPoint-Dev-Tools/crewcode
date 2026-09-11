import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { buildAgentCommandEnv, resolveClaudeCommand } from './resolve-agent'
import { getSpawnArgsForWindows } from '../win32-utils'

const DIRECT_TIMEOUT_MS = 12_000
const PTY_TIMEOUT_MS = 25_000
const MAX_OUTPUT_LENGTH = 100_000
export const CLAUDE_CRASH_COOLDOWN_MS = 10 * 60 * 1000

type ClaudeProbeResult = ProviderRateLimits & { processCrash?: string }

let interactiveProbeBlockedUntil = 0

export function noteClaudeProbeCrash(now = Date.now()): void {
  interactiveProbeBlockedUntil = Math.max(interactiveProbeBlockedUntil, now + CLAUDE_CRASH_COOLDOWN_MS)
}

export function claudeInteractiveProbeIsCoolingDown(now = Date.now()): boolean {
  return now < interactiveProbeBlockedUntil
}

export function resetClaudeProbeCrashCooldownForTest(): void {
  interactiveProbeBlockedUntil = 0
}

const SESSION_RE = /current\s*session/i
const WEEKLY_RE = /current\s*week/i
const PERCENT_RE = /(\d{1,3})(?:\.\d+)?\s*%\s*(used|left|remaining|available)/i
const RESET_LINE_RE = /resets?\s+(?:at\s+|in\s+)?(.+)/i

const STOP_SUBSTRINGS = [
  'Current week (all models)',
  'Current week (Opus)',
  'Current week (Sonnet only)',
  'Current week (Sonnet)',
  'Current session',
  'Failed to load usage data',
  'failed to load usage data',
]

function extractPercentAfterLabel(lines: string[], labelRe: RegExp): number | null {
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue
    for (let j = i; j < Math.min(i + 12, lines.length); j++) {
      const m = PERCENT_RE.exec(lines[j])
      if (m) {
        const pct = parseFloat(m[1])
        const word = m[2].toLowerCase()
        return word === 'used' ? pct : 100 - pct
      }
    }
  }
  return null
}

function extractResetAfterLabel(lines: string[], labelRe: RegExp): string | null {
  for (let i = 0; i < lines.length; i++) {
    if (!labelRe.test(lines[i])) continue
    for (let j = i; j < Math.min(i + 14, lines.length); j++) {
      const m = RESET_LINE_RE.exec(lines[j])
      if (m) return m[1].trim()
    }
  }
  return null
}

function stripTerminalSequences(output: string): string {
  return output
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
}

function parsePtyUsage(output: string): { session: RateLimitWindow | null; weekly: RateLimitWindow | null } {
  const lines = output.split(/\r?\n/)
  const sessionPct = extractPercentAfterLabel(lines, SESSION_RE)
  const weeklyPct = extractPercentAfterLabel(lines, WEEKLY_RE)

  const session: RateLimitWindow | null = sessionPct !== null
    ? {
        usedPercent: Math.min(100, Math.max(0, sessionPct)),
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: extractResetAfterLabel(lines, SESSION_RE),
      }
    : null

  const weekly: RateLimitWindow | null = weeklyPct !== null
    ? {
        usedPercent: Math.min(100, Math.max(0, weeklyPct)),
        windowMinutes: 10080,
        resetsAt: null,
        resetDescription: extractResetAfterLabel(lines, WEEKLY_RE),
      }
    : null

  return { session, weekly }
}

function describeFailure(output: string): string {
  if (/rate limited\.?\s+please try again later/i.test(output)) return 'Claude usage is rate limited right now.'
  if (/failed to load usage data/i.test(output)) return 'Claude usage is unavailable right now.'
  return 'Claude usage is unavailable right now.'
}

function buildClaudeResult(output: string, errorFallback: string): ProviderRateLimits {
  const clean = stripTerminalSequences(output)
  const { session, weekly } = parsePtyUsage(clean)
  return {
    provider: 'claude',
    session,
    weekly,
    updatedAt: Date.now(),
    error: session || weekly ? null : errorFallback,
    status: session || weekly ? 'ok' : 'error',
  }
}

async function fetchViaCommand(commandOverride?: string | null): Promise<ClaudeProbeResult> {
  const claudeCommand = resolveClaudeCommand(commandOverride)
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(claudeCommand, ['/usage'])

  return new Promise<ClaudeProbeResult>((resolve) => {
    let output = ''
    let resolved = false
    let child: ReturnType<typeof spawn>

    try {
      child = spawn(spawnCmd, spawnArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Packaged apps can start inside an app bundle; Claude writes project
        // state during startup, so use a normal user-owned directory.
        cwd: homedir(),
        env: buildAgentCommandEnv(claudeCommand, { TERM: 'dumb', NO_COLOR: '1' }),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      resolve({
        provider: 'claude',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: message,
        status: message.includes('ENOENT') || message.includes('not found') ? 'unavailable' : 'error',
      })
      return
    }

    const appendOutput = (chunk: Buffer): void => {
      output += chunk.toString()
      if (output.length > MAX_OUTPUT_LENGTH) output = output.slice(-MAX_OUTPUT_LENGTH)
    }

    const timeout = setTimeout(() => {
      if (resolved) return
      resolved = true
      child.kill()
      resolve(buildClaudeResult(output, 'Claude /usage command timed out'))
    }, DIRECT_TIMEOUT_MS)

    child.stdout?.on('data', appendOutput)
    child.stderr?.on('data', appendOutput)

    child.on('error', (err) => {
      if (resolved) return
      resolved = true
      clearTimeout(timeout)
      const isEnoent = (err as NodeJS.ErrnoException).code === 'ENOENT'
      resolve({
        provider: 'claude',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: isEnoent ? 'Claude CLI not found' : err.message,
        status: isEnoent ? 'unavailable' : 'error',
      })
    })

    child.on('close', (_exitCode, signal) => {
      if (resolved) return
      resolved = true
      clearTimeout(timeout)
      if (signal) {
        resolve({
          provider: 'claude',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: `Claude usage probe crashed (${signal})`,
          status: 'error',
          processCrash: signal,
        })
        return
      }
      resolve(buildClaudeResult(output, describeFailure(stripTerminalSequences(output))))
    })
  })
}

async function fetchViaPty(commandOverride?: string | null): Promise<ClaudeProbeResult> {
  const pty = await import('node-pty')
  const claudeCommand = resolveClaudeCommand(commandOverride)

  const isWin32 = process.platform === 'win32'
  const spawnFile = isWin32 ? 'cmd.exe' : claudeCommand
  const spawnArgs = isWin32 ? ['/c', `"${claudeCommand}"`] : []

  return new Promise<ClaudeProbeResult>((resolve) => {
    let output = ''
    let resolved = false
    let sentUsage = false
    let stopDetected = false

    const term = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: homedir(),
      env: buildAgentCommandEnv(claudeCommand, { TERM: 'xterm-256color' }) as Record<string, string>,
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
        const clean = stripTerminalSequences(output)
        const { session, weekly } = parsePtyUsage(clean)
        resolve({
          provider: 'claude',
          session,
          weekly,
          updatedAt: Date.now(),
          error: session || weekly ? null : 'Claude /usage timed out',
          status: session || weekly ? 'ok' : 'error',
        })
      }
    }, PTY_TIMEOUT_MS)

    let enterInterval: ReturnType<typeof setInterval> | null = null
    function startEnterPresses(): void {
      if (enterInterval) return
      enterInterval = setInterval(() => {
        if (!resolved && !stopDetected) term.write('\r')
      }, 800)
    }

    function finalize(): void {
      if (resolved) return
      resolved = true
      clearTimeout(timeout)
      if (enterInterval) clearInterval(enterInterval)
      dispose()
      term.kill()
      const clean = stripTerminalSequences(output)
      const { session, weekly } = parsePtyUsage(clean)
      if (!session && !weekly) {
        resolve({
          provider: 'claude',
          session: null,
          weekly: null,
          updatedAt: Date.now(),
          error: describeFailure(clean),
          status: 'error',
        })
      } else {
        resolve({
          provider: 'claude',
          session,
          weekly,
          updatedAt: Date.now(),
          error: null,
          status: 'ok',
        })
      }
    }

    setTimeout(() => {
      if (resolved) return
      sentUsage = true
      term.write('/usage\r')
      startEnterPresses()
    }, 2000)

    const onData = term.onData((data) => {
      output += data
      if (output.length > MAX_OUTPUT_LENGTH) output = output.slice(-MAX_OUTPUT_LENGTH)

      const cleanChunk = stripTerminalSequences(data)

      if (/do you trust|trust the files|safety check/i.test(cleanChunk)) {
        term.write('y\r')
        return
      }

      if (sentUsage && /show plan|usage limits/i.test(cleanChunk)) {
        term.write('\r')
      }

      if (sentUsage && !stopDetected) {
        const clean = stripTerminalSequences(output)
        for (const sub of STOP_SUBSTRINGS) {
          if (clean.includes(sub)) {
            stopDetected = true
            setTimeout(finalize, 2000)
            break
          }
        }
      }
    })
    if (onData) disposables.push(onData)

    const onExit = term.onExit(({ signal }) => {
      dispose()
      if (enterInterval) clearInterval(enterInterval)
      if (!resolved) {
        resolved = true
        clearTimeout(timeout)
        const clean = stripTerminalSequences(output)
        const { session, weekly } = parsePtyUsage(clean)
        const crashed = typeof signal === 'number' && signal > 0
        resolve({
          provider: 'claude',
          session,
          weekly,
          updatedAt: Date.now(),
          error: session || weekly ? null : crashed ? `Claude usage probe crashed (signal ${signal})` : 'Claude exited before /usage rendered',
          status: session || weekly ? 'ok' : 'error',
          ...(crashed ? { processCrash: `signal ${signal}` } : {}),
        })
      }
    })
    if (onExit) disposables.push(onExit)
  })
}

export async function fetchClaudeRateLimits(commandOverride?: string | null): Promise<ProviderRateLimits> {
  const direct = await fetchViaCommand(commandOverride)
  if (direct.status === 'ok' || direct.status === 'unavailable') return direct
  if (direct.processCrash) {
    noteClaudeProbeCrash()
    return direct
  }

  // The fallback is a real interactive CLI process. After an observed crash,
  // do not let focus-driven refreshes relaunch it into a core-dump loop.
  if (claudeInteractiveProbeIsCoolingDown()) return direct

  try {
    const pty = await fetchViaPty(commandOverride)
    if (pty.processCrash) noteClaudeProbeCrash()
    return pty.status === 'ok' ? pty : direct
  } catch {
    return direct
  }
}

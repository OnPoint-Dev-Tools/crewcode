import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { buildAgentCommandEnv, resolveOpencodeCommand } from './resolve-agent'
import { getSpawnArgsForWindows } from '../win32-utils'

const STATS_TIMEOUT_MS = 15_000
const MAX_OUTPUT_LENGTH = 200_000

// OpenCode Go documents rough quota equivalents for its subscription windows.
// The CLI exposes local spend stats, but not the hosted service's live counters.
const OPENCODE_GO_FIVE_HOUR_USD = 12
const OPENCODE_GO_WEEKLY_USD = 30
const OPENCODE_FREE_DAILY_REQUESTS = 200

type OpencodeStats = {
  opencodeGoCost: number
  freeMessages: number
  sawOpencodeUsage: boolean
}

function stripTerminalSequences(output: string): string {
  return output
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
}

function parseMoney(raw: string): number {
  const value = Number.parseFloat(raw.replace(/,/g, ''))
  return Number.isFinite(value) ? value : 0
}

function parseInteger(raw: string): number {
  const value = Number.parseInt(raw.replace(/,/g, ''), 10)
  return Number.isFinite(value) ? value : 0
}

function parseOpencodeStats(output: string): OpencodeStats {
  const lines = stripTerminalSequences(output).split(/\r?\n/)
  const stats: OpencodeStats = { opencodeGoCost: 0, freeMessages: 0, sawOpencodeUsage: false }
  let currentProvider: 'opencode-go' | 'opencode-free' | null = null

  for (const raw of lines) {
    const line = raw.replace(/[│┌┐└┘├┤─]/g, ' ').trim()
    if (!line) continue

    const modelMatch = /^(opencode-go|opencode)\/([^\s]+)/i.exec(line)
    if (modelMatch) {
      const provider = modelMatch[1].toLowerCase()
      const model = modelMatch[2].toLowerCase()
      currentProvider = provider === 'opencode-go'
        ? 'opencode-go'
        : model.includes('free') ? 'opencode-free' : null
      if (currentProvider) stats.sawOpencodeUsage = true
      continue
    }

    if (!currentProvider) continue

    const messagesMatch = /^Messages\s+([\d,]+)/i.exec(line)
    if (messagesMatch && currentProvider === 'opencode-free') {
      stats.freeMessages += parseInteger(messagesMatch[1])
      continue
    }

    const costMatch = /^Cost\s+\$([\d,.]+)/i.exec(line)
    if (costMatch && currentProvider === 'opencode-go') {
      stats.opencodeGoCost += parseMoney(costMatch[1])
    }
  }

  return stats
}

function makeWindow(usedPercent: number, windowMinutes: number, resetDescription: string): RateLimitWindow {
  return {
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    windowMinutes,
    resetsAt: null,
    resetDescription,
  }
}

function statusProvider(status: ProviderRateLimits['status'], error: string | null): ProviderRateLimits {
  return {
    provider: 'opencode',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
  }
}

async function runOpencodeStats(commandOverride: string | null | undefined, days: number): Promise<string> {
  const opencodeCommand = resolveOpencodeCommand(commandOverride)
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(opencodeCommand, ['stats', '--days', String(days), '--models'])

  return new Promise<string>((resolve, reject) => {
    let output = ''
    let resolved = false
    let child: ReturnType<typeof spawn>

    try {
      child = spawn(spawnCmd, spawnArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: homedir(),
        env: buildAgentCommandEnv(opencodeCommand, { TERM: 'dumb', NO_COLOR: '1' }),
      })
    } catch (err) {
      reject(err)
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
      reject(new Error('OpenCode stats timed out'))
    }, STATS_TIMEOUT_MS)

    child.stdout?.on('data', appendOutput)
    child.stderr?.on('data', appendOutput)

    child.on('error', (err) => {
      if (resolved) return
      resolved = true
      clearTimeout(timeout)
      reject(err)
    })

    child.on('close', (code) => {
      if (resolved) return
      resolved = true
      clearTimeout(timeout)
      if (code === 0) resolve(output)
      else reject(new Error(stripTerminalSequences(output).trim() || `OpenCode stats exited with code ${code}`))
    })
  })
}

export async function fetchOpencodeRateLimits(commandOverride?: string | null): Promise<ProviderRateLimits> {
  try {
    const [dailyOutput, weeklyOutput] = await Promise.all([
      runOpencodeStats(commandOverride, 1),
      runOpencodeStats(commandOverride, 7),
    ])

    const daily = parseOpencodeStats(dailyOutput)
    const weekly = parseOpencodeStats(weeklyOutput)

    const goFiveHourPercent = (daily.opencodeGoCost / OPENCODE_GO_FIVE_HOUR_USD) * 100
    const goWeeklyPercent = (weekly.opencodeGoCost / OPENCODE_GO_WEEKLY_USD) * 100
    const freeDailyPercent = (daily.freeMessages / OPENCODE_FREE_DAILY_REQUESTS) * 100

    const sessionPercent = Math.max(goFiveHourPercent, freeDailyPercent)
    const sessionDescription = goFiveHourPercent >= freeDailyPercent
      ? 'OpenCode Go estimate from local 24h spend'
      : 'OpenCode free daily quota estimate'

    return {
      provider: 'opencode',
      session: makeWindow(sessionPercent, 300, sessionDescription),
      weekly: makeWindow(goWeeklyPercent, 10080, 'OpenCode Go estimate from local 7d spend'),
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    const isNotInstalled = message.includes('ENOENT') || message.includes('not found')
    return statusProvider(isNotInstalled ? 'unavailable' : 'error', isNotInstalled ? 'OpenCode CLI not found' : message)
  }
}

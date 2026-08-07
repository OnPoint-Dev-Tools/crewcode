import type { BrowserWindow } from 'electron'
import type { RateLimitState, ProviderRateLimits } from '../../shared/rate-limit-types'
import { fetchClaudeRateLimits } from './claude-fetch'
import { fetchCodexRateLimits } from './codex-fetch'
import { fetchOpenRouterRateLimits } from './openrouter-fetch'
import { fetchOpencodeRateLimits } from './opencode-fetch'
import { unavailableProvider } from './stub-fetch'

const DEFAULT_POLL_MS = 5 * 60 * 1000 // 5 minutes
const MIN_REFETCH_MS = 30 * 1000
const STALE_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes

const PROVIDERS = ['claude', 'codex', 'pi', 'opencode', 'hermes', 'crewcoder', 'ollama', 'openrouter'] as const
type CliRateLimitProvider = 'claude' | 'codex' | 'opencode'
type CommandResolver = (provider: CliRateLimitProvider) => string | null | undefined

export class RateLimitService {
  private state: RateLimitState = { providers: {} }
  private pollInterval = DEFAULT_POLL_MS
  private timer: ReturnType<typeof setInterval> | null = null
  private lastFetchAt = 0
  private mainWindow: BrowserWindow | null = null
  private detachListeners: (() => void) | null = null
  private isFetching = false
  private queueFull = false

  constructor(private readonly resolveCommand?: CommandResolver) {}

  attach(mainWindow: BrowserWindow): void {
    this.detachListeners?.()
    this.mainWindow = mainWindow
    const refresh = (): void => {
      void this.refreshIfActive()
    }
    mainWindow.on('focus', refresh)
    mainWindow.on('show', refresh)
    mainWindow.on('restore', refresh)
    this.detachListeners = () => {
      mainWindow.removeListener('focus', refresh)
      mainWindow.removeListener('show', refresh)
      mainWindow.removeListener('restore', refresh)
    }
    mainWindow.on('closed', () => {
      this.detachListeners?.()
      this.detachListeners = null
      if (this.mainWindow === mainWindow) this.mainWindow = null
    })
  }

  start(): void {
    void this.fetchAll()
    this.startTimer()
  }

  stop(): void {
    this.stopTimer()
    this.detachListeners?.()
    this.detachListeners = null
    this.mainWindow = null
  }

  getState(): RateLimitState {
    return this.state
  }

  async refresh(): Promise<RateLimitState> {
    await this.fetchAll({ force: true })
    return this.getState()
  }

  setPollingInterval(ms: number): void {
    this.pollInterval = Math.max(30_000, ms)
    if (this.timer) {
      this.stopTimer()
      this.startTimer()
    }
  }

  private startTimer(): void {
    this.stopTimer()
    this.timer = setInterval(() => {
      if (!this.shouldPoll()) return
      void this.fetchAll()
    }, this.pollInterval)
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private shouldPoll(): boolean {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return false
    if (!this.mainWindow.isVisible() || this.mainWindow.isMinimized()) return false
    return this.mainWindow.isFocused()
  }

  private async refreshIfActive(): Promise<void> {
    if (!this.shouldPoll()) return
    if (Date.now() - this.lastFetchAt < MIN_REFETCH_MS) return
    await this.fetchAll()
  }

  private async fetchAll(options?: { force?: boolean }): Promise<void> {
    if (this.isFetching) {
      if (options?.force) this.queueFull = true
      return
    }
    this.isFetching = true

    try {
      do {
        this.queueFull = false
        await this.runFetchCycle()
      } while (this.queueFull)
    } finally {
      this.isFetching = false
      this.lastFetchAt = Date.now()
    }
  }

  private async runFetchCycle(): Promise<void> {
    const previous = this.state

    // Mark all as fetching while preserving previous data
    const fetchingState: RateLimitState = { providers: {} }
    for (const id of PROVIDERS) {
      const prev = previous.providers[id]
      fetchingState.providers[id] = prev
        ? { ...prev, status: 'fetching' as const }
        : { provider: id, session: null, weekly: null, updatedAt: 0, error: null, status: 'fetching' as const }
    }
    this.updateState(fetchingState)

    const results = await Promise.allSettled([
      fetchClaudeRateLimits(this.resolveCommand?.('claude')),
      fetchCodexRateLimits(this.resolveCommand?.('codex')),
      fetchOpencodeRateLimits(this.resolveCommand?.('opencode')),
      fetchOpenRouterRateLimits(),
    ])

    const next: RateLimitState = { providers: {} }

    const claude = results[0].status === 'fulfilled' ? results[0].value : errorProvider('claude', results[0].reason)
    const codex = results[1].status === 'fulfilled' ? results[1].value : errorProvider('codex', results[1].reason)
    const opencode = results[2].status === 'fulfilled' ? results[2].value : errorProvider('opencode', results[2].reason)
    const openrouter = results[3].status === 'fulfilled' ? results[3].value : errorProvider('openrouter', results[3].reason)

    next.providers['claude'] = this.applyStalePolicy(claude, previous.providers['claude'])
    next.providers['codex'] = this.applyStalePolicy(codex, previous.providers['codex'])
    next.providers['opencode'] = this.applyStalePolicy(opencode, previous.providers['opencode'])
    next.providers['openrouter'] = this.applyStalePolicy(openrouter, previous.providers['openrouter'])

    for (const id of ['pi', 'hermes', 'crewcoder', 'ollama'] as const) {
      next.providers[id] = previous.providers[id] ?? unavailableProvider(id)
    }

    this.updateState(next)
  }

  private applyStalePolicy(
    fresh: ProviderRateLimits,
    previous: ProviderRateLimits | undefined
  ): ProviderRateLimits {
    if (fresh.status === 'ok') return fresh
    if (fresh.status === 'unavailable') return fresh
    const hasData = Boolean(previous?.session || previous?.weekly)
    if (!previous || !hasData) return fresh
    if (Date.now() - previous.updatedAt > STALE_THRESHOLD_MS) return fresh
    return { ...previous, error: fresh.error, status: 'error' }
  }

  private updateState(next: RateLimitState): void {
    this.state = next
    this.pushToRenderer()
  }

  private pushToRenderer(): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    this.mainWindow.webContents.send('rateLimits:update', this.state)
  }
}

function errorProvider(provider: string, reason: unknown): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: reason instanceof Error ? reason.message : 'Unknown error',
    status: 'error',
  }
}

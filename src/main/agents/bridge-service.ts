import { createPiBridge } from './pi-bridge'
import { createOpencodeBridge } from './opencode-bridge'
import { createCodexBridge } from './codex-bridge'
import { createClaudeBridge } from './claude-bridge'
import { createHermesBridge } from './hermes-bridge'
import { createCrewCoderBridge } from './crewcoder-bridge'
import { createGrokBridge } from './grok-bridge'
import { createOllamaBridge } from './ollama-bridge'
import { createOpenrouterBridge } from './openrouter-bridge'
import { getAgentKey } from './agent-keys'
import { clearSessionId, getSessionId, setSessionId } from './sessionStore'
import { clearConversation, loadConversation, saveConversation, type StoredMessage } from './conversation-store'
import { isRemoteRoot } from '../remote/ssh-target'
import { TurnPermissionGrantStore } from './turn-permission-grants'
import { decideModeChange } from './custody-invariants'
import {
  API_KEY_PROVIDERS,
  HTTP_ONLY_PROVIDERS,
  type AgentBridge,
  type AgentUserRequest,
  type AgentUserResponse,
  type BridgeEvent,
  type BridgeStartOpts,
  type HandoffPromptOptions,
  type PromptOptions,
  type RequestUserFn,
} from './bridge-types'

export type AgentPathResolver = (provider: string) => string | null
export type AgentBridgeFactory = (
  path: string,
  opts: BridgeStartOpts,
  emit: (event: BridgeEvent) => void,
  requestUser: RequestUserFn,
) => Promise<AgentBridge>

const REMOTE_AGENT_PROVIDERS = new Set<BridgeStartOpts['provider']>([
  'pi', 'opencode', 'codex', 'claude', 'hermes', 'crewcoder', 'grok', 'ollama', 'openrouter',
])

interface BridgeEntry {
  bridge: AgentBridge
  providerPath: string
  opts: BridgeStartOpts
  pendingPrompts: string[]
  promptByTurn: Record<string, string>
  responseByTurn: Record<string, string>
  // Execution custody: a turn in flight must not have its authority changed
  // underneath it. See docs/execution-custody.md.
  running: boolean
  pendingMode?: BridgeStartOpts['mode']
  injectHistoryOnNextPrompt: boolean
}

const DISPOSABLE_SUMMARY_TRANSCRIPT_CHARS = 48_000
const DISPOSABLE_SUMMARY_TIMEOUT_MS = 120_000

function formatStoredHistory(history: StoredMessage[]): string {
  return history.map(message => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`).join('\n\n')
}

function boundedHistoryText(history: StoredMessage[], maxChars: number): string {
  const full = formatStoredHistory(history)
  if (full.length <= maxChars) return full

  const recent: string[] = []
  let used = 0
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]
    const line = `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`
    const cost = line.length + 2
    if (recent.length > 0 && used + cost > maxChars) break
    recent.unshift(line)
    used += cost
  }
  const omitted = Math.max(0, history.length - recent.length)
  return `Earlier transcript compacted by CrewCode before AI summarization: ${omitted} older message${omitted === 1 ? '' : 's'} omitted.\n\nRecent transcript:\n${recent.join('\n\n')}`
}

function historyAsPrompt(history: StoredMessage[]): string {
  return `<system>\nThis CrewCode thread has prior conversation history. Continue from it; do not treat the next user message as a fresh chat.\n</system>\n\n<conversation_history>\n${formatStoredHistory(history)}\n</conversation_history>\n\n`
}

/**
 * Transport-neutral bridge lifecycle for remote clients. The desktop's mature
 * session-resume/compaction coordinator remains in agents/index.ts for now;
 * this service establishes the reusable start/prompt/event boundary first.
 */
export class AgentBridgeService {
  private readonly bridges = new Map<string, BridgeEntry>()
  private readonly listeners = new Set<(event: BridgeEvent) => void>()
  private readonly pendingRequests = new Map<string, {
    bridgeId: string
    request: AgentUserRequest
    resolve: (response: AgentUserResponse) => void
  }>()
  private readonly turnPermissionGrants = new TurnPermissionGrantStore()

  constructor(
    private readonly resolvePath: AgentPathResolver,
    private readonly createOverride?: AgentBridgeFactory,
  ) {}

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(rawOpts: BridgeStartOpts): Promise<{ ok?: boolean; error?: string }> {
    if (!rawOpts.bridgeId || !rawOpts.cwd) return { error: 'bridgeId and cwd are required' }
    if (!REMOTE_AGENT_PROVIDERS.has(rawOpts.provider)) return { error: 'agent provider is not available over remote access' }
    const existing = this.bridges.get(rawOpts.bridgeId)
    if (existing && !rawOpts.freshSession) {
      // Remote clients use stable bridge ids so they can reassert attachment
      // after a browser reconnect. A duplicate start must not stop an active
      // provider turn. Refuse contradictory immutable configuration instead of
      // changing execution authority underneath the existing bridge.
      const sameExecution = existing.opts.provider === rawOpts.provider
        && existing.opts.cwd === rawOpts.cwd
        && existing.opts.model === rawOpts.model
        && existing.opts.conversationKey === rawOpts.conversationKey
      return sameExecution
        ? { ok: true }
        : { error: 'bridge already exists with different execution configuration; stop it before restarting' }
    }
    await this.stop(rawOpts.bridgeId)
    const remote = isRemoteRoot(rawOpts.cwd)
    const path = HTTP_ONLY_PROVIDERS.has(rawOpts.provider)
      ? rawOpts.provider
      : remote ? rawOpts.provider : this.resolvePath(rawOpts.provider)
    if (!path) return { error: `${rawOpts.provider} not found on this machine` }
    let apiKey = rawOpts.apiKey
    if (API_KEY_PROVIDERS.has(rawOpts.provider)) {
      apiKey = getAgentKey(rawOpts.provider) ?? undefined
      if (!apiKey) return { error: `${rawOpts.provider} API key not set` }
    }
    const resumeSessionId = rawOpts.conversationKey && !rawOpts.freshSession ? getSessionId(rawOpts.conversationKey) ?? undefined : undefined
    const opts = { ...rawOpts, apiKey, resumeSessionId }
    const emit = (event: BridgeEvent): void => {
      const entry = this.bridges.get(rawOpts.bridgeId)
      if (event.type === 'turn_start') {
        this.turnPermissionGrants.clearBridge(rawOpts.bridgeId)
        if (entry) {
          entry.running = true
          // Land the mode change that was refused mid-turn, now that the next
          // turn is starting under it.
          if (entry.pendingMode) { entry.opts.mode = entry.pendingMode; entry.pendingMode = undefined }
        }
      } else if (event.type === 'turn_end') {
        this.turnPermissionGrants.clearTurn(rawOpts.bridgeId, event.turnId)
        if (entry) entry.running = false
      } else if (event.type === 'error' || event.type === 'closed') {
        this.turnPermissionGrants.clearBridge(rawOpts.bridgeId)
        if (entry) entry.running = false
        // A dead bridge's permission cards can never be answered by anyone;
        // leaving them pending is authority stuck in limbo.
        this.cancelPendingRequests(rawOpts.bridgeId)
      }
      if (event.type === 'session_id' && opts.conversationKey) setSessionId(opts.conversationKey, event.sessionId)
      if (entry && opts.conversationKey && event.type === 'turn_start') {
        entry.promptByTurn[event.turnId] = entry.pendingPrompts.shift() ?? ''
        entry.responseByTurn[event.turnId] = ''
      } else if (entry && event.type === 'text_delta') {
        entry.responseByTurn[event.turnId] = (entry.responseByTurn[event.turnId] ?? '') + event.delta
      } else if (entry && opts.conversationKey && event.type === 'turn_end') {
        const prompt = entry.promptByTurn[event.turnId]
        if (prompt) {
          const history = loadConversation(opts.conversationKey)
          history.push({ role: 'user', content: prompt }, { role: 'assistant', content: entry.responseByTurn[event.turnId] ?? '' })
          saveConversation(opts.conversationKey, history)
        }
        delete entry.promptByTurn[event.turnId]
        delete entry.responseByTurn[event.turnId]
      }
      for (const listener of this.listeners) listener(event)
    }
    const requestUser: RequestUserFn = request => this.requestUser(opts.bridgeId, request)
    try {
      const bridge = await this.create(path, opts, emit, requestUser)
      const hasLocalHistory = !!opts.conversationKey && loadConversation(opts.conversationKey).length > 0
      this.bridges.set(opts.bridgeId, {
        bridge,
        providerPath: path,
        opts,
        pendingPrompts: [],
        promptByTurn: {},
        responseByTurn: {},
        running: false,
        injectHistoryOnNextPrompt: !resumeSessionId && hasLocalHistory && !HTTP_ONLY_PROVIDERS.has(opts.provider),
      })
      return { ok: true }
    } catch (error) {
      return { error: (error as Error).message }
    }
  }

  async prompt(bridgeId: string, text: string, options?: PromptOptions): Promise<{ ok: boolean; error?: string }> {
    const entry = this.bridges.get(bridgeId)
        if (!entry) return { ok: false, error: 'bridge not found' }
        const queueingFollowUp = entry.running && options?.streamingBehavior === 'followUp'
        // Apply a deferred mode before the provider serializes the next request.
        // turn_start is only the fallback for provider-internal queued follow-ups.
        if (!queueingFollowUp && entry.pendingMode) {
          entry.opts.mode = entry.pendingMode
          entry.pendingMode = undefined
        }
        if (!queueingFollowUp) entry.running = true
        entry.pendingPrompts.push(text)
        const history = entry.opts.conversationKey ? loadConversation(entry.opts.conversationKey) : []
        const shouldInjectHistory = entry.injectHistoryOnNextPrompt && history.length > 0
        const wireText = shouldInjectHistory ? historyAsPrompt(history) + text : text
        if (shouldInjectHistory) entry.injectHistoryOnNextPrompt = false
        const result = await entry.bridge.prompt(wireText, options)
        if (!result.ok) {
          const index = entry.pendingPrompts.indexOf(text)
          if (index >= 0) entry.pendingPrompts.splice(index, 1)
          if (shouldInjectHistory) entry.injectHistoryOnNextPrompt = true
          if (!queueingFollowUp) entry.running = false
        }
        return result
  }

  compact(bridgeId: string): Promise<{ ok: boolean; error?: string; unsupported?: boolean }> {
    const entry = this.bridges.get(bridgeId)
    if (!entry) return Promise.resolve({ ok: false, error: 'bridge not found' })
    return entry.bridge.compact?.() ?? Promise.resolve({ ok: false, unsupported: true, error: 'provider does not support compaction' })
  }

  async handoff(bridgeId: string, sourceConversationKey: string, options: HandoffPromptOptions): Promise<{ ok: boolean; error?: string }> {
    const entry = this.bridges.get(bridgeId)
    if (!entry) return { ok: false, error: 'bridge not found' }
    if (entry.running) return { ok: false, error: 'cannot hand off context while the destination thread is running' }
    if (!entry.opts.conversationKey || !sourceConversationKey) return { ok: false, error: 'handoff conversation scope is unavailable' }
    if (entry.opts.conversationKey === sourceConversationKey) return { ok: false, error: 'choose a different chat for context handoff' }

    const sourceHistory = loadConversation(sourceConversationKey)
    if (sourceHistory.length === 0) return { ok: false, error: 'no source conversation history available to hand off' }

    entry.running = true
    try {
      const summary = await this.summarizeHandoff(entry, sourceHistory, options)
      if (!summary) return { ok: false, error: 'handoff summary failed' }

      const targetHistory = loadConversation(entry.opts.conversationKey)
      saveConversation(entry.opts.conversationKey, [
        ...targetHistory,
        { role: 'user', content: `CrewCode context handoff from ${options.fromProvider ?? 'another provider'}. Continue with the imported context alongside this chat's existing history.` },
        { role: 'assistant', content: summary },
      ])
      clearSessionId(entry.opts.conversationKey)
      for (const listener of this.listeners) listener({
        type: 'handoff_summary',
        bridgeId,
        summary,
        fromProvider: options.fromProvider,
        toProvider: options.toProvider ?? entry.opts.provider,
        reason: 'handoff',
      })

      await entry.bridge.stop().catch(() => {})
      this.bridges.delete(bridgeId)
      for (const listener of this.listeners) listener({ type: 'idle_stopped', bridgeId })
      return { ok: true }
    } finally {
      entry.running = false
    }
  }

  removeFollowUp(bridgeId: string, followUpId: string): Promise<{ ok: boolean; error?: string }> {
    const entry = this.bridges.get(bridgeId)
    if (!entry) return Promise.resolve({ ok: false, error: 'bridge not found' })
    return entry.bridge.removeFollowUp?.(followUpId) ?? Promise.resolve({ ok: false, error: 'provider does not support removing follow-ups' })
  }

  respond(response: AgentUserResponse): { ok?: boolean; error?: string } {
    const pending = this.pendingRequests.get(response.requestId)
    if (!pending) return { error: 'request not found or already resolved' }
    let resolved = response
    let grantedTurnId: string | null = null
    if (response.action === 'accept_for_turn') {
      if (!this.turnPermissionGrants.grant(pending.bridgeId, pending.request)) {
        return { error: 'allow all is unavailable for this permission request' }
      }
      grantedTurnId = pending.request.turnId ?? null
      resolved = { ...response, action: 'accept' }
    }
    this.pendingRequests.delete(response.requestId)
    pending.resolve(resolved)

    // Parallel tool calls can already have permission cards waiting before the
    // grant is chosen. Resolve those too; future same-turn requests auto-allow
    // in requestUser before they ever reach a client.
    if (grantedTurnId) {
      for (const [requestId, other] of this.pendingRequests) {
        if (other.bridgeId !== pending.bridgeId
          || other.request.turnId !== grantedTurnId
          || !other.request.allowAllForTurn) continue
        this.pendingRequests.delete(requestId)
        other.resolve({ requestId, action: 'accept' })
        for (const listener of this.listeners) listener({
          type: 'user_request_resolved',
          bridgeId: other.bridgeId,
          requestId,
        })
      }
    }
    return { ok: true }
  }

  /**
   * Authority must not change underneath a turn that is already executing. A
   * mid-turn change is refused and deferred to the next turn_start rather than
   * applied or used to kill in-progress work.
   */
  setMode(bridgeId: string, mode: BridgeStartOpts['mode']): { ok: boolean; deferred?: boolean; reason?: string } {
    const entry = this.bridges.get(bridgeId)
    if (!entry || !mode) return { ok: false }
    const decision = decideModeChange(entry.opts.mode, mode, entry.running)
    if (!decision.apply) {
      entry.pendingMode = mode
      return { ok: true, deferred: true, reason: decision.reason }
    }
    entry.opts.mode = mode
    entry.pendingMode = undefined
    return { ok: true }
  }

  async abort(bridgeId: string): Promise<{ ok: boolean }> {
    this.turnPermissionGrants.clearBridge(bridgeId)
    this.cancelPendingRequests(bridgeId)
    const entry = this.bridges.get(bridgeId)
    if (entry) entry.running = false
    await entry?.bridge.abort().catch(() => {})
    return { ok: true }
  }

  async stop(bridgeId: string): Promise<{ ok: boolean }> {
    this.turnPermissionGrants.clearBridge(bridgeId)
    this.cancelPendingRequests(bridgeId)
    const entry = this.bridges.get(bridgeId)
    if (entry) await entry.bridge.stop().catch(() => {})
    this.bridges.delete(bridgeId)
    return { ok: true }
  }

  async stopWhere(predicate: (entry: { bridgeId: string; cwd: string; running: boolean }) => boolean): Promise<string[]> {
    const stopped: string[] = []
    for (const [bridgeId, entry] of [...this.bridges]) {
      if (!predicate({ bridgeId, cwd: entry.opts.cwd, running: entry.running })) continue
      await this.stop(bridgeId); stopped.push(bridgeId)
    }
    return stopped
  }

  async stopAll(): Promise<void> {
    for (const bridgeId of [...this.bridges.keys()]) this.cancelPendingRequests(bridgeId)
    await Promise.all([...this.bridges.values()].map(entry => entry.bridge.stop().catch(() => {})))
    this.bridges.clear()
    this.pendingRequests.clear()
    this.turnPermissionGrants.clear()
  }

  /**
   * Settle every permission request still waiting on a bridge that is going
   * away. Cancel is the only honest answer: the process behind the request can
   * no longer act on an approval, and an unresolved promise would hang forever.
   */
  private cancelPendingRequests(bridgeId: string): void {
    for (const [requestId, pending] of [...this.pendingRequests]) {
      if (pending.bridgeId !== bridgeId) continue
      this.pendingRequests.delete(requestId)
      pending.resolve({ requestId, action: 'cancel' })
      for (const listener of this.listeners) listener({ type: 'user_request_resolved', bridgeId, requestId })
    }
  }

  private requestUser(bridgeId: string, request: Omit<AgentUserRequest, 'requestId' | 'bridgeId'>): Promise<AgentUserResponse> {
    const entry = this.bridges.get(bridgeId)
    const prepared = this.turnPermissionGrants.prepareRequest(
      bridgeId,
      entry?.opts.mode ?? 'build',
      entry?.opts.toolPolicy,
      request,
    )
    if (prepared.autoResponse) return Promise.resolve(prepared.autoResponse)

    const requestId = `${bridgeId}-ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const payload: AgentUserRequest = { ...prepared.request, requestId, bridgeId }
    return new Promise(resolve => {
      this.pendingRequests.set(requestId, { bridgeId, request: payload, resolve })
      for (const listener of this.listeners) listener({ type: 'user_request', request: payload })
    })
  }

  private async create(path: string, opts: BridgeStartOpts, emit: (event: BridgeEvent) => void, requestUser: RequestUserFn): Promise<AgentBridge> {
    if (this.createOverride) return this.createOverride(path, opts, emit, requestUser)
    if (opts.provider === 'pi') return createPiBridge(path, opts, emit, requestUser)
    if (opts.provider === 'codex') return createCodexBridge(path, opts, emit, requestUser)
    if (opts.provider === 'claude') return createClaudeBridge(path, opts, emit, requestUser)
    if (opts.provider === 'hermes') return createHermesBridge(path, opts, emit, requestUser)
    if (opts.provider === 'crewcoder') return createCrewCoderBridge(path, opts, emit, requestUser)
    if (opts.provider === 'grok') return createGrokBridge(path, opts, emit, requestUser)
    if (opts.provider === 'ollama') return createOllamaBridge(path, opts, emit)
    if (opts.provider === 'openrouter') return createOpenrouterBridge(path, opts, emit)
    return createOpencodeBridge(path, opts, emit, requestUser)
  }

  private async summarizeHandoff(entry: BridgeEntry, history: StoredMessage[], options: HandoffPromptOptions): Promise<string | null> {
    const tempBridgeId = `${entry.opts.bridgeId}-handoff-${Date.now().toString(36)}`
    const tempConversationKey = `disposable-handoff:${tempBridgeId}`
    let summary = ''
    let settled = false
    let resolveDone!: (value: boolean) => void
    const done = new Promise<boolean>(resolve => { resolveDone = resolve })
    const settle = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolveDone(ok)
    }
    const tempOpts: BridgeStartOpts = {
      ...entry.opts,
      bridgeId: tempBridgeId,
      resumeSessionId: undefined,
      conversationKey: tempConversationKey,
      suppressProviderHistoryReplay: true,
      ephemeral: true,
    }
    const emit = (event: BridgeEvent): void => {
      if (event.type === 'text_delta') summary += event.delta
      else if (event.type === 'turn_end') settle(true)
      else if (event.type === 'error') settle(false)
      else if (event.type === 'closed') settle(summary.trim().length > 0)
    }
    const requestUser: RequestUserFn = async () => ({ requestId: `${tempBridgeId}-cancel`, bridgeId: tempBridgeId, action: 'cancel' })
    let bridge: AgentBridge | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null
    try {
      bridge = await this.create(entry.providerPath, tempOpts, emit, requestUser)
      const transcript = boundedHistoryText(history, DISPOSABLE_SUMMARY_TRANSCRIPT_CHARS)
      const prompt = `You are preparing a provider handoff summary for CrewCode. Summarize the following bounded transcript so a fresh agent session can continue without the raw transcript. Preserve goals, decisions, constraints, files/paths mentioned, completed work, open questions, and next steps. If the transcript says older messages were omitted, explicitly account for that limitation. Do not use tools. Respond only with the summary.\n\n<workspace_context>\n${options.workspace?.name ? `- Workspace: ${options.workspace.name}\n` : ''}${options.workspace?.path ? `- Path: ${options.workspace.path}\n` : ''}${options.workspace?.branch ? `- Branch: ${options.workspace.branch}\n` : ''}</workspace_context>\n\n<conversation_transcript>\n${transcript}\n</conversation_transcript>`
      timeout = setTimeout(() => settle(false), DISPOSABLE_SUMMARY_TIMEOUT_MS)
      const accepted = await bridge.prompt(prompt)
      if (!accepted.ok || !await done || !summary.trim()) return null
      return summary.trim()
    } catch {
      return null
    } finally {
      if (timeout) clearTimeout(timeout)
      await bridge?.stop().catch(() => {})
      clearConversation(tempConversationKey)
    }
  }
}

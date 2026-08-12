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
import { getSessionId, setSessionId } from './sessionStore'
import { loadConversation, saveConversation } from './conversation-store'
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
  type PromptOptions,
  type RequestUserFn,
} from './bridge-types'

export type AgentPathResolver = (provider: string) => string | null

const REMOTE_AGENT_PROVIDERS = new Set<BridgeStartOpts['provider']>([
  'pi', 'opencode', 'codex', 'claude', 'hermes', 'crewcoder', 'grok', 'ollama', 'openrouter',
])

interface BridgeEntry {
  bridge: AgentBridge
  opts: BridgeStartOpts
  pendingPrompts: string[]
  promptByTurn: Record<string, string>
  responseByTurn: Record<string, string>
  // Execution custody: a turn in flight must not have its authority changed
  // underneath it. See docs/execution-custody.md.
  running: boolean
  pendingMode?: BridgeStartOpts['mode']
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

  constructor(private readonly resolvePath: AgentPathResolver) {}

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(rawOpts: BridgeStartOpts): Promise<{ ok?: boolean; error?: string }> {
    if (!rawOpts.bridgeId || !rawOpts.cwd) return { error: 'bridgeId and cwd are required' }
    if (!REMOTE_AGENT_PROVIDERS.has(rawOpts.provider)) return { error: 'agent provider is not available over remote access' }
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
      this.bridges.set(opts.bridgeId, { bridge, opts, pendingPrompts: [], promptByTurn: {}, responseByTurn: {}, running: false })
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
        const result = await entry.bridge.prompt(text, options)
        if (!result.ok) {
          const index = entry.pendingPrompts.indexOf(text)
          if (index >= 0) entry.pendingPrompts.splice(index, 1)
          if (!queueingFollowUp) entry.running = false
        }
        return result
  }

  compact(bridgeId: string): Promise<{ ok: boolean; error?: string; unsupported?: boolean }> {
    const entry = this.bridges.get(bridgeId)
    if (!entry) return Promise.resolve({ ok: false, error: 'bridge not found' })
    return entry.bridge.compact?.() ?? Promise.resolve({ ok: false, unsupported: true, error: 'provider does not support compaction' })
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
}

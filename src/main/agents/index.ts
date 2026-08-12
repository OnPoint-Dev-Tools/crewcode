import electron from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createPiBridge } from './pi-bridge'
import { createOpencodeBridge } from './opencode-bridge'
import { createCodexBridge } from './codex-bridge'
import { createClaudeBridge } from './claude-bridge'
import { createHermesBridge } from './hermes-bridge'
import { createCrewCoderBridge } from './crewcoder-bridge'
import { createGrokBridge } from './grok-bridge'
import { createOllamaBridge } from './ollama-bridge'
import { createOpenrouterBridge } from './openrouter-bridge'
import { createOpenCodeGoCompletionBridge } from './opencode-go-completion'
import { completionText } from './completion-text'
import { getAgentKey } from './agent-keys'
import { getSessionId, setSessionId, clearSessionId, getUsageSnapshot, setUsageSnapshot, clearUsageSnapshot } from './sessionStore'
import { clearConversation, loadConversation, saveConversation, type StoredMessage } from './conversation-store'
import { isRemoteRoot } from '../remote/ssh-target'
import { loadPluginRegistry, recordPluginDebug } from '../plugins'
import { requiredPermissionsForPluginAgentRuntime } from '../plugin-contract'
import { parseProviderPayload } from './plugin-provider-payload'
import type { AgentBridge, AgentUserRequest, AgentUserResponse, BridgeEvent, BridgeStartOpts, EmitFn, HandoffPromptOptions, PromptOptions, RequestUserFn, TurnUsage } from './bridge-types'
import { HTTP_ONLY_PROVIDERS, API_KEY_PROVIDERS } from './bridge-types'
import { autoCompactionSignalForProvider, detectAutoCompaction, normalizeContextUsage, compactionStrategy } from './compaction-meter'
import { TurnPermissionGrantStore } from './turn-permission-grants'
import { authorityOf, custodyJournal, scopeKeyFor, scopeViolation } from './custody'
import {
  authorityDriftViolation,
  decideModeChange,
  refusalMessage,
  violation as custodyViolation,
  type CustodyViolation,
  type PrivilegedAction,
} from './custody-invariants'
import type { ModeLevel } from '../../shared/mode-types'
import type { AgentCompletionRequest, AgentCompletionResult, CompletionProviderId } from '../../shared/agent-completion-types'

const { ipcMain, BrowserWindow, webContents } = electron

const PLUGIN_PROVIDER_TIMEOUT_MS = 60_000
const PLUGIN_PROVIDER_MIN_TIMEOUT_MS = 5_000
const PLUGIN_PROVIDER_MAX_TIMEOUT_MS = 300_000
const PLUGIN_PROVIDER_MAX_OUTPUT_BYTES = 256 * 1024
const PLUGIN_PROVIDER_MIN_OUTPUT_BYTES = 8 * 1024
const PLUGIN_PROVIDER_OUTPUT_LIMIT_BYTES = 1024 * 1024

interface BridgeEntry {
  bridge:        AgentBridge
  webContentsId: number
  // Composite "tabId:agentId" key under which the resume id is stored. We
  // accept it from the renderer at start time and use it as the persistence
  // key when the bridge emits session_id later.
  sessionKey:    string | null
  // Surfaced by the system monitor's daemon list — provider label + spawn time.
  provider:      BridgeStartOpts['provider']
  providerPath:  string
  opts:          BridgeStartOpts
  startedAt:     number
  // Wall-clock of the last emitted event. The idle sweep stops bridges that have
  // been quiet longer than IDLE_STOP_MS to free their process memory.
  lastActivityAt: number
  // True from the moment a prompt is sent through turn_end, so the sweep never
  // kills a bridge mid-turn (even during a long, silent tool call).
  running:       boolean
  // Stable local transcript key for this CrewCode thread. Used as a fallback
  // when a provider's native session id cannot be resumed after restart.
  conversationKey: string | null
  injectHistoryOnNextPrompt: boolean
  pendingPromptTexts: string[]
  promptTextByTurn: Record<string, string>
  assistantTextByTurn: Record<string, string>
  lastUsage?: TurnUsage
  pendingManualCompaction: boolean
  // Set after a mid-turn context drop opens the inferred auto-compaction meter;
  // turn_end closes that same meter.
  pendingAutoCompaction: boolean
  // True while a summary-reset compaction is in flight: the agent is producing a
  // structured summary that turn_end collapses into a fresh, small session.
  pendingSummaryReset: boolean
  // Stable custody scope ("tabId:agentId", or "bridge:<id>" when this bridge has
  // no thread key). Halts are keyed by this, not by the timestamped bridgeId, so
  // they survive the restart that raised them.
  custodyScopeKey: string
  // Set by bridge:stop / bridge:abort so a 'closed' event that the user asked
  // for is recorded as a clean end instead of tripping the custody tripwire.
  userInitiatedStop: boolean
  // A mode change requested mid-turn: refused now, applied at the next turn_start.
  pendingMode?: ModeLevel
}

// A live agent-bridge process as seen by the system monitor's daemon panel.
export interface BridgeDaemon {
  bridgeId:   string
  provider:   string
  sessionKey: string | null
  startedAt:  number
  pid:        number | null
}

/** Snapshot of every live agent bridge — read by the system monitor. */
export function listBridgeDaemons(): BridgeDaemon[] {
  return [...bridges.entries()].map(([bridgeId, e]) => ({
    bridgeId,
    provider:   e.provider,
    sessionKey: e.sessionKey,
    startedAt:  e.startedAt,
    pid:        e.bridge.pid,
  }))
}

/** Stop one live bridge by id — used by the system monitor's stop control. */
export async function stopBridgeDaemon(bridgeId: string): Promise<{ ok: boolean }> {
  const entry = bridges.get(bridgeId)
  if (!entry) return { ok: false }
  // Stopping from the daemon panel is user-initiated, so the resulting exit is
  // known state and must not trip the custody tripwire on the next launch.
  entry.userInitiatedStop = true
  custodyJournal().patch(bridgeId, { status: 'ended', endedAt: Date.now(), turnId: undefined, activePrompt: undefined })
  cancelPendingUserRequests(bridgeId, 'stopped from system monitor')
  await entry.bridge.stop().catch(() => {})
  bridges.delete(bridgeId)
  turnPermissionGrants.clearBridge(bridgeId)
  return { ok: true }
}

const bridges = new Map<string, BridgeEntry>()
const pendingUserRequests = new Map<string, {
  bridgeId: string
  request: AgentUserRequest
  resolve: (response: AgentUserResponse) => void
}>()
const turnPermissionGrants = new TurnPermissionGrantStore()
const NATIVE_RESUME_PROVIDERS = new Set<string>(['pi', 'opencode', 'codex', 'claude', 'hermes', 'crewcoder', 'grok'])
const replayInjectedForThread = new Set<string>()
const COMPLETION_PROVIDERS = new Set<CompletionProviderId>(['opencode-go', 'pi', 'opencode', 'codex', 'claude', 'hermes', 'ollama', 'openrouter'])
const COMPLETION_PREFIX_LIMIT = 12_000
const COMPLETION_SUFFIX_LIMIT = 4_000
const COMPLETION_OUTPUT_LIMIT = 24_000
const COMPLETION_TIMEOUT_MS = 20_000

interface CompletionEntry {
  bridge: AgentBridge
  cancel: () => void
}

const completionRequests = new Map<string, CompletionEntry>()

function threadConversationKey(sessionKey: string): string {
  return `thread:${sessionKey}`
}

function isNativeResumeProvider(provider: string): boolean {
  return NATIVE_RESUME_PROVIDERS.has(provider)
}

// ─── Execution custody ──────────────────────────────────────────────────────
// Granting authority is decided at the gates in the security model. This block
// is the other half: withdrawing it coherently once execution has begun. See
// docs/execution-custody.md.

function sendToClient(entry: Pick<BridgeEntry, 'webContentsId'>, event: BridgeEvent): void {
  webContents.fromId(entry.webContentsId)?.send('bridge:event', event)
}

/**
 * Settle every permission request still waiting on a bridge that is going away.
 * An unanswered card for a dead process is authority in limbo: the renderer
 * keeps offering "Allow?" for something that can no longer act, and the promise
 * behind it never resolves. Cancel is the only honest answer, and the card is
 * dismissed explicitly rather than left to look live.
 */
function cancelPendingUserRequests(bridgeId: string, reason: string): number {
  const entry = bridges.get(bridgeId)
  let cancelled = 0
  for (const [requestId, pending] of [...pendingUserRequests]) {
    if (pending.bridgeId !== bridgeId) continue
    pendingUserRequests.delete(requestId)
    pending.resolve({ requestId, action: 'cancel' })
    cancelled++
    if (entry) sendToClient(entry, { type: 'user_request_resolved', bridgeId, requestId })
  }
  if (cancelled) {
    const record = custodyJournal().get(bridgeId)
    const provider = entry?.provider ?? record?.authority.provider ?? 'unknown'
    const cwd = entry?.opts.cwd ?? record?.authority.cwd ?? 'unknown'
    const issue = custodyViolation(
      'orphaned-authorization',
      `${cancelled} permission request${cancelled === 1 ? '' : 's'} cancelled because the owning bridge was ${reason}`,
      { bridgeId, provider, cwd, turnId: record?.turnId, sessionKey: entry?.sessionKey ?? record?.sessionKey },
    )
    custodyJournal().recordViolation(bridgeId, issue)
    sessionDebug('custody: cancelled orphaned permission requests', { bridgeId, cancelled, reason })
  }
  return cancelled
}

/**
 * Persist what an interrupted turn asked for and whatever came back before
 * custody was lost. Without this the prompt is dropped on the floor — the local
 * transcript only saves on turn_end — and the thread resumes looking like the
 * turn never happened. Losing the evidence is the failure, not the interruption.
 */
function preserveInterruptedTurn(entry: BridgeEntry, turnId: string | undefined, detail: string): { prompt?: string; partial?: string } {
  const record = custodyJournal().get(entry.bridge.bridgeId)
  const prompt = (turnId ? entry.promptTextByTurn[turnId] : undefined) ?? record?.activePrompt
  const partial = turnId ? entry.assistantTextByTurn[turnId] ?? '' : ''
  if (turnId) {
    delete entry.promptTextByTurn[turnId]
    delete entry.assistantTextByTurn[turnId]
  }
  if (!prompt) return { partial: partial || undefined }
  const recordLocalHistory = !!entry.conversationKey
    && !HTTP_ONLY_PROVIDERS.has(entry.provider)
    && !entry.provider.startsWith('plugin:')
  if (recordLocalHistory) {
    const history = loadConversation(entry.conversationKey!)
    history.push({ role: 'user', content: prompt })
    history.push({
      role: 'assistant',
      content: `${partial}\n\n[CrewCode: this turn was interrupted — ${detail}. The response above is incomplete, and whatever it had already done to the workspace was not observed.]`.trim(),
    })
    saveConversation(entry.conversationKey!, history)
  }
  return { prompt, partial: partial || undefined }
}

/**
 * Trip the tripwire: record the exact failed invariant, contain owned execution,
 * preserve the evidence, report it, and refuse privileged actions on this thread
 * until a human explicitly reauthorizes.
 */
function haltBridge(bridgeId: string, halt: CustodyViolation): void {
  const entry = bridges.get(bridgeId)
  const evidence = entry ? preserveInterruptedTurn(entry, halt.scope.turnId, halt.detail) : {}
  custodyJournal().halt(bridgeId, halt, evidence)
  cancelPendingUserRequests(bridgeId, halt.invariant)
  turnPermissionGrants.clearBridge(bridgeId)

  sessionDebug('custody: halted', {
    bridgeId, invariant: halt.invariant, detail: halt.detail,
    provider: halt.scope.provider, cwd: halt.scope.cwd, turnId: halt.scope.turnId,
  })

  if (!entry) return
  // Contain: the process no longer holds a grant we can vouch for.
  entry.running = false
  entry.bridge.abort().catch(() => {})
  entry.bridge.stop().catch(() => {})
  bridges.delete(bridgeId)
  sendToClient(entry, {
    type: 'custody_halt',
    bridgeId,
    halt: {
      scopeKey: entry.custodyScopeKey,
      violation: halt,
      interruptedPrompt: evidence.prompt,
      interruptedPartial: evidence.partial,
    },
  })
}

/** The halt in force for a thread, or null. Survives bridge restarts by design. */
function activeHaltFor(scopeKey: string): CustodyViolation | null {
  return custodyJournal().activeHalt(scopeKey)
}

/** Apply a mode mutation that was refused while the previous turn was live. */
function applyDeferredMode(entry: BridgeEntry, bridgeId: string): void {
  if (!entry.pendingMode) return
  const mode = entry.pendingMode
  entry.opts.mode = mode
  entry.pendingMode = undefined
  custodyJournal().patch(bridgeId, { authority: authorityOf(entry.opts) })
  sendToClient(entry, { type: 'custody_deferred', bridgeId, message: `Mode ${mode} now in effect.` })
}

/**
 * Gate for privileged actions. Returns a refusal when the thread is halted, and
 * re-checks the invariants that can go stale between actions (workspace scope,
 * authority drift) so a violation is caught at the action, not one action later.
 */
function custodyRefusal(entry: BridgeEntry, bridgeId: string, action: PrivilegedAction): { error: string } | null {
  const halted = activeHaltFor(entry.custodyScopeKey)
  if (halted) return { error: refusalMessage(action, halted) }

  const record = custodyJournal().get(bridgeId)
  const scope = { bridgeId, provider: entry.provider, cwd: entry.opts.cwd, turnId: record?.turnId, sessionKey: entry.sessionKey }

  const gone = scopeViolation({ cwd: entry.opts.cwd, provider: entry.provider, bridgeId }, entry.sessionKey, record?.turnId)
  if (gone) { haltBridge(bridgeId, gone); return { error: refusalMessage(action, gone) } }

  if (record) {
    const drift = authorityDriftViolation(record.authority, authorityOf(entry.opts), scope)
    if (drift) { haltBridge(bridgeId, drift); return { error: refusalMessage(action, drift) } }
  }
  return null
}

function replayMarker(conversationKey: string, provider: string): string {
  return `${provider}:${conversationKey}`
}

function sessionDebug(message: string, meta: Record<string, unknown>): void {
  // Always-on while session persistence stabilizes; remove or gate after dogfood.
  console.log(`[agent-session] ${message}`, meta)
}

const PROVIDER_COMPACT_PROMPT = '/compact'
const LOCAL_COMPACT_PROMPT = `Please compact this conversation for continuation. Preserve the user's goals, decisions, constraints, files touched, pending tasks, and any facts needed to continue. Respond only with the compacted summary.`
// Sent to providers with no native compaction RPC (pi, hermes, CrewCoder). The agent still
// holds the full live context here, so it produces a high-fidelity summary that
// seeds a fresh session after the reset. Structured so the next session can pick
// up cleanly. No preamble — the body is replayed verbatim as the prior context.
const SUMMARY_RESET_PROMPT = `Summarize this entire conversation so it can continue in a brand-new session that has none of the prior context. Include:

1. GOALS — What was the overall objective of this session?
2. KEY DECISIONS — What decisions were made, and why?
3. PROGRESS — What was accomplished? What milestones were reached?
4. OPEN QUESTIONS — What is unresolved or still being debated?
5. NEXT STEPS — What should happen next, in priority order?

Keep it concise but complete. Use bullet points and short paragraphs. Do not include any preamble like "Here is the summary" — just output the structured content.`

function compactPromptFor(provider: string): string {
  return HTTP_ONLY_PROVIDERS.has(provider) || provider.startsWith('plugin:') ? LOCAL_COMPACT_PROMPT : PROVIDER_COMPACT_PROMPT
}

function usagePercent(usage: TurnUsage | undefined): number | undefined {
  if (usage?.compaction?.percent !== undefined) return usage.compaction.percent
  if (!usage?.contextTokens || !usage.contextWindow) return undefined
  return Math.min(100, (usage.contextTokens / usage.contextWindow) * 100)
}

function saveCompactedSummary(conversationKey: string | null, summary: string): void {
  if (!conversationKey || !summary.trim()) return
  saveConversation(conversationKey, [
    { role: 'user', content: 'Continue from this compacted conversation summary.' },
    { role: 'assistant', content: summary.trim() },
  ])
}

function compactLocalConversation(conversationKey: string | null): void {
  if (!conversationKey) return
  const history = loadConversation(conversationKey)
  const summary = [...history].reverse().find(message => message.role === 'assistant' && message.content.trim().length > 0)
  if (!summary) return
  saveCompactedSummary(conversationKey, summary.content)
}

const HANDOFF_FULL_HISTORY_CHARS = 24_000
const HANDOFF_RECENT_HISTORY_CHARS = 14_000
const DISPOSABLE_SUMMARY_TRANSCRIPT_CHARS = 48_000

function formatStoredHistory(history: StoredMessage[]): string {
  return history
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n')
}

function historyAsPrompt(history: StoredMessage[]): string {
  const lines = formatStoredHistory(history)
  return `<system>\nThis CrewCode thread has prior conversation history. Continue from it; do not treat the next user message as a fresh chat.\n</system>\n\n<conversation_history>\n${lines}\n</conversation_history>\n\n`
}

function boundedHistoryText(history: StoredMessage[], maxChars: number): string {
  const full = formatStoredHistory(history)
  if (full.length <= maxChars) return full

  const recent: string[] = []
  let used = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const line = `${history[i].role === 'user' ? 'User' : 'Assistant'}: ${history[i].content}`
    const cost = line.length + 2
    if (recent.length > 0 && used + cost > maxChars) break
    recent.unshift(line)
    used += cost
  }
  const omitted = Math.max(0, history.length - recent.length)
  const earlier = omitted > 0
    ? `Earlier transcript compacted by CrewCode before AI summarization: ${omitted} older message${omitted === 1 ? '' : 's'} omitted. Preserve the established goals, decisions, constraints, and files implied by the recent transcript.`
    : 'No earlier messages omitted.'
  return `${earlier}\n\nRecent transcript:\n${recent.join('\n\n')}`
}

function compactHistoryDigest(history: StoredMessage[]): string {
  return boundedHistoryText(history, HANDOFF_RECENT_HISTORY_CHARS)
}

function handoffPrompt(history: StoredMessage[], entry: BridgeEntry, handoff: HandoffPromptOptions, generatedSummary?: string | null): string {
  const fullHistory = formatStoredHistory(history)
  const historyBlock = generatedSummary?.trim()
    ? `AI-generated handoff summary:\n${generatedSummary.trim()}`
    : fullHistory.length <= HANDOFF_FULL_HISTORY_CHARS
      ? fullHistory
      : compactHistoryDigest(history)
  const workspace = handoff.workspace
  const workspaceLines = [
    workspace?.name ? `- Workspace: ${workspace.name}` : null,
    workspace?.path ? `- Path: ${workspace.path}` : entry.opts.cwd ? `- Path: ${entry.opts.cwd}` : null,
    workspace?.branch ? `- Branch: ${workspace.branch}` : null,
    handoff.mode ? `- Mode: ${handoff.mode}` : entry.opts.mode ? `- Mode: ${entry.opts.mode}` : null,
    handoff.model ? `- Target model: ${handoff.model}` : entry.opts.model ? `- Target model: ${entry.opts.model}` : null,
  ].filter(Boolean).join('\n')
  return `<system>\nProvider handoff in progress. You are taking over an existing CrewCode session from ${handoff.fromProvider ?? 'another provider'} to ${handoff.toProvider ?? entry.provider}. Continue the conversation with the existing context; do not restart or ask the user to repeat themselves. Project guidance/system instructions should still be followed from the active workspace.\n</system>\n\n<workspace_context>\n${workspaceLines || '- Current workspace metadata unavailable'}\n</workspace_context>\n\n<conversation_handoff>\n${historyBlock}\n</conversation_handoff>\n\n`
}

interface AgentPathResolver {
  (id: string): string | null
}

function createPluginAgentBridge(opts: BridgeStartOpts, emit: EmitFn): AgentBridge {
  const registry = loadPluginRegistry()
  const registrationId = opts.provider.replace(/^plugin:/, '')
  const provider = registry.contributions.agentProviders.find(candidate => candidate.registrationId === registrationId)
  if (!provider) throw new Error('plugin agent provider missing or disabled')
  const plugin = registry.plugins.find(candidate => candidate.id === provider.pluginId)
  const permissions = plugin?.manifest.permissions ?? []
  for (const permission of requiredPermissionsForPluginAgentRuntime(provider.runtime)) {
    if (!permissions.includes(permission)) throw new Error(`${provider.runtime} plugin agent providers require ${permission}`)
  }

  const sessionId = opts.resumeSessionId || `${registrationId}:${Date.now().toString(36)}`
  const historyKey = opts.conversationKey ?? sessionId
  const history: StoredMessage[] = loadConversation(historyKey)

  queueMicrotask(() => {
    emit({ type: 'ready', bridgeId: opts.bridgeId })
    emit({ type: 'session_id', bridgeId: opts.bridgeId, sessionId, resumed: !!opts.resumeSessionId })
  })

  const clamp = (value: number | undefined, fallback: number, min: number, max: number) => Math.max(min, Math.min(max, value ?? fallback))
  const providerTimeoutMs = clamp(provider.timeoutMs, PLUGIN_PROVIDER_TIMEOUT_MS, PLUGIN_PROVIDER_MIN_TIMEOUT_MS, PLUGIN_PROVIDER_MAX_TIMEOUT_MS)
  const providerMaxOutputBytes = clamp(provider.maxOutputBytes, PLUGIN_PROVIDER_MAX_OUTPUT_BYTES, PLUGIN_PROVIDER_MIN_OUTPUT_BYTES, PLUGIN_PROVIDER_OUTPUT_LIMIT_BYTES)

  let aborted = false
  let currentProc: ChildProcessWithoutNullStreams | null = null
  let currentAbort: AbortController | null = null

  const startTurn = () => {
    const turnId = `turn-${Date.now().toString(36)}`
    aborted = false
    emit({ type: 'turn_start', bridgeId: opts.bridgeId, turnId })
    return turnId
  }

  const finishTurn = (turnId: string, input: string, output: string) => {
    history.push({ role: 'user', content: input })
    history.push({ role: 'assistant', content: output })
    saveConversation(historyKey, history)
    emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId, usage: { inputTokens: input.length, outputTokens: output.length, totalTokens: input.length + output.length, model: opts.model || provider.models?.[0] || provider.runtime } })
    recordPluginDebug({ pluginId: provider.pluginId, registrationId: provider.registrationId, method: `provider:${provider.runtime}`, ok: true, category: 'provider-success', workspaceRoot: opts.cwd })
  }

  const appendOutput = (turnId: string, state: { output: string; capped: boolean }, delta: string): boolean => {
    if (state.capped) return false
    if (Buffer.byteLength(state.output + delta, 'utf8') > providerMaxOutputBytes) {
      state.capped = true
      const message = `plugin provider output exceeded ${providerMaxOutputBytes} bytes`
      emit({ type: 'error', bridgeId: opts.bridgeId, message })
      recordPluginDebug({ pluginId: provider.pluginId, registrationId: provider.registrationId, method: `provider:${provider.runtime}`, ok: false, category: 'provider-http', error: message, workspaceRoot: opts.cwd })
      return false
    }
    state.output += delta
    emit({ type: 'text_delta', bridgeId: opts.bridgeId, turnId, delta })
    return true
  }

  const parseStreamFrame = (payload: string) => parseProviderPayload(payload, { responsePath: provider.responsePath, fallbackToRaw: false })
  const parseResponseBody = (payload: string) => parseProviderPayload(payload, { responsePath: provider.responsePath, fallbackToRaw: true })

  const openAiEndpoint = () => {
    const endpoint = provider.endpoint ?? ''
    return endpoint.endsWith('/chat/completions') ? endpoint : `${endpoint.replace(/\/$/, '')}/chat/completions`
  }

  return {
    bridgeId: opts.bridgeId,
    get pid() { return currentProc?.pid ?? null },
    async prompt(text: string) {
      const turnId = startTurn()
      if (provider.runtime === 'mock') {
        emit({ type: 'thinking_delta', bridgeId: opts.bridgeId, turnId, delta: `${provider.title} received ${text.length} characters.\n` })
        await new Promise(resolve => setTimeout(resolve, 120))
        if (aborted) return { ok: false, error: 'aborted' }
        const body = [`Mock response from **${provider.title}**.`, '', `Plugin: \`${provider.pluginId}\``, `Provider registration: \`${provider.registrationId}\``, '', 'This dogfood provider proves plugin agents can enter the bridge lifecycle without shell access.'].join('\n')
        emit({ type: 'text_delta', bridgeId: opts.bridgeId, turnId, delta: body })
        finishTurn(turnId, text, body)
        return { ok: true }
      }

      if (provider.runtime === 'exec') {
        if (!provider.command) return { ok: false, error: 'exec provider missing command' }
        const rawArgs = provider.args ?? []
        const hasPromptPlaceholder = rawArgs.some(arg => arg.includes('{{prompt}}'))
        const args = rawArgs.map(arg => arg.replaceAll('{{prompt}}', text).replaceAll('{{cwd}}', opts.cwd))
        return await new Promise(resolve => {
          let output = ''
          let settled = false
          let capped = false
          const settle = (value: { ok: boolean; error?: string }) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolve(value)
          }
          const appendOutput = (chunk: unknown) => {
            if (capped) return
            const delta = String(chunk)
            const nextBytes = Buffer.byteLength(output + delta, 'utf8')
            if (nextBytes > providerMaxOutputBytes) {
              capped = true
              const message = `plugin provider output exceeded ${providerMaxOutputBytes} bytes`
              emit({ type: 'error', bridgeId: opts.bridgeId, message })
              currentProc?.kill('SIGTERM')
              recordPluginDebug({ pluginId: provider.pluginId, registrationId: provider.registrationId, method: 'provider:exec', ok: false, category: 'provider-spawn', error: message, workspaceRoot: opts.cwd })
              settle({ ok: false, error: message })
              return
            }
            output += delta
            emit({ type: 'text_delta', bridgeId: opts.bridgeId, turnId, delta })
          }
          const timeout = setTimeout(() => {
            const message = `plugin exec provider timed out after ${providerTimeoutMs}ms`
            emit({ type: 'error', bridgeId: opts.bridgeId, message })
            currentProc?.kill('SIGTERM')
            recordPluginDebug({ pluginId: provider.pluginId, registrationId: provider.registrationId, method: 'provider:exec', ok: false, category: 'provider-spawn', error: message, workspaceRoot: opts.cwd })
            settle({ ok: false, error: message })
          }, providerTimeoutMs)
          currentProc = spawn(provider.command!, args, { cwd: opts.cwd, shell: false, env: { ...process.env, CREWCODE_AGENT_PROVIDER: provider.registrationId, CREWCODE_AGENT_SESSION_ID: sessionId } })
          currentProc.stdout.on('data', appendOutput)
          // v0 streams stderr into the response for CLI compatibility; non-zero
          // exit still marks the turn failed below.
          currentProc.stderr.on('data', appendOutput)
          currentProc.on('error', err => { emit({ type: 'error', bridgeId: opts.bridgeId, message: err.message }); recordPluginDebug({ pluginId: provider.pluginId, registrationId: provider.registrationId, method: 'provider:exec', ok: false, category: 'provider-spawn', error: err.message, workspaceRoot: opts.cwd }); currentProc = null; settle({ ok: false, error: err.message }) })
          currentProc.on('close', code => { currentProc = null; if (settled) return; if (code === 0 || output.trim()) { finishTurn(turnId, text, output); settle({ ok: code === 0, error: code === 0 ? undefined : `process exited ${code}` }) } else { const message = `process exited ${code}`; emit({ type: 'error', bridgeId: opts.bridgeId, message }); recordPluginDebug({ pluginId: provider.pluginId, registrationId: provider.registrationId, method: 'provider:exec', ok: false, category: 'provider-spawn', error: message, workspaceRoot: opts.cwd }); settle({ ok: false, error: message }) } })
          if (!hasPromptPlaceholder) currentProc.stdin.end(text)
          else currentProc.stdin.end()
        })
      }

      if (provider.runtime === 'stdio-jsonrpc') {
        if (!provider.command) return { ok: false, error: 'stdio-jsonrpc provider missing command' }
        const args = (provider.args ?? []).map(arg => arg.replaceAll('{{cwd}}', opts.cwd))
        return await new Promise(resolve => {
          const state = { output: '', capped: false }
          let settled = false
          let buffer = ''
          const settle = (value: { ok: boolean; error?: string }) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            resolve(value)
          }
          const timeout = setTimeout(() => {
            const message = `plugin stdio-jsonrpc provider timed out after ${providerTimeoutMs}ms`
            emit({ type: 'error', bridgeId: opts.bridgeId, message })
            currentProc?.kill('SIGTERM')
            recordPluginDebug({ pluginId: provider.pluginId, registrationId: provider.registrationId, method: 'provider:stdio-jsonrpc', ok: false, category: 'provider-spawn', error: message, workspaceRoot: opts.cwd })
            settle({ ok: false, error: message })
          }, providerTimeoutMs)
          currentProc = spawn(provider.command!, args, { cwd: opts.cwd, shell: false, env: { ...process.env, CREWCODE_AGENT_PROVIDER: provider.registrationId, CREWCODE_AGENT_SESSION_ID: sessionId } })
          currentProc.stdout.on('data', chunk => {
            buffer += String(chunk)
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              if (!line.trim()) continue
              try {
                const msg = JSON.parse(line) as any
                const delta = msg.params?.delta ?? msg.params?.text ?? msg.result?.delta ?? msg.result?.text ?? msg.result?.message?.content
                if (typeof delta === 'string' && !appendOutput(turnId, state, delta)) return settle({ ok: false, error: 'output cap exceeded' })
                if (msg.result?.done || msg.params?.done) { finishTurn(turnId, text, state.output); settle({ ok: true }) }
              } catch {
                if (!appendOutput(turnId, state, `${line}\n`)) return settle({ ok: false, error: 'output cap exceeded' })
              }
            }
          })
          currentProc.stderr.on('data', chunk => appendOutput(turnId, state, String(chunk)))
          currentProc.on('error', err => { emit({ type: 'error', bridgeId: opts.bridgeId, message: err.message }); recordPluginDebug({ pluginId: provider.pluginId, registrationId: provider.registrationId, method: 'provider:stdio-jsonrpc', ok: false, category: 'provider-spawn', error: err.message, workspaceRoot: opts.cwd }); currentProc = null; settle({ ok: false, error: err.message }) })
          currentProc.on('close', code => { currentProc = null; if (settled) return; if (state.output.trim() || code === 0) { finishTurn(turnId, text, state.output); settle({ ok: code === 0, error: code === 0 ? undefined : `process exited ${code}` }) } else { settle({ ok: false, error: `process exited ${code}` }) } })
          currentProc.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'prompt', params: { prompt: text, cwd: opts.cwd, model: opts.model || provider.models?.[0] || null, provider: provider.registrationId, sessionId, history: [...history, { role: 'user', content: text }] } }) + '\n')
        })
      }

      if (!provider.endpoint) return { ok: false, error: `${provider.runtime} provider missing endpoint` }
      if (provider.runtime === 'websocket') {
        const WebSocketCtor = (globalThis as any).WebSocket
        if (!WebSocketCtor) return { ok: false, error: 'WebSocket runtime unavailable in this Electron build' }
        return await new Promise(resolve => {
          const state = { output: '', capped: false }
          let settled = false
          const settle = (value: { ok: boolean; error?: string }) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            try { ws.close() } catch { /* ignore close races */ }
            resolve(value)
          }
          const timeout = setTimeout(() => settle({ ok: false, error: `plugin websocket provider timed out after ${providerTimeoutMs}ms` }), providerTimeoutMs)
          const ws = new WebSocketCtor(provider.endpoint)
          ws.addEventListener('open', () => ws.send(JSON.stringify({ prompt: text, cwd: opts.cwd, model: opts.model || provider.models?.[0] || null, provider: provider.registrationId, sessionId, history: [...history, { role: 'user', content: text }] })))
          ws.addEventListener('message', (event: any) => {
            const raw = String(event.data ?? '')
            const delta = parseStreamFrame(raw)
            if (delta !== null && !appendOutput(turnId, state, delta)) return settle({ ok: false, error: 'output cap exceeded' })
            try { const msg = JSON.parse(raw) as any; if (msg.done || msg.type === 'done') { finishTurn(turnId, text, state.output); settle({ ok: true }) } } catch { /* plain text */ }
          })
          ws.addEventListener('error', () => settle({ ok: false, error: 'plugin websocket provider error' }))
          ws.addEventListener('close', () => { if (!settled) { finishTurn(turnId, text, state.output); settle({ ok: true }) } })
        })
      }

      currentAbort = new AbortController()
      const timeout = setTimeout(() => currentAbort?.abort(), providerTimeoutMs)
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`
        const requestFormat = provider.requestFormat ?? (provider.runtime === 'openai-compatible' ? 'openai-chat' : 'crewcode')
        const isOpenAi = requestFormat === 'openai-chat'
        const response = await fetch(isOpenAi ? openAiEndpoint() : provider.endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(isOpenAi
            ? { model: opts.model || provider.models?.[0] || 'default', messages: [...history, { role: 'user', content: text }], stream: provider.runtime === 'sse-http' }
            : { prompt: text, cwd: opts.cwd, model: opts.model || provider.models?.[0] || null, provider: provider.registrationId, sessionId, history: [...history, { role: 'user', content: text }] }),
          signal: currentAbort.signal,
        })
        if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`)
        const state = { output: '', capped: false }
        if (provider.runtime === 'sse-http' && response.body) {
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const events = buffer.split('\n\n')
            buffer = events.pop() ?? ''
            for (const event of events) {
              for (const line of event.split('\n')) {
                if (!line.startsWith('data:')) continue
                const data = line.slice(5).trim()
                if (!data || data === '[DONE]') continue
                const delta = parseStreamFrame(data)
                if (delta === null) continue
                if (!appendOutput(turnId, state, delta)) throw new Error('output cap exceeded')
              }
            }
          }
        } else {
          const output = parseResponseBody(await response.text())
          if (output !== null && !appendOutput(turnId, state, output)) throw new Error('output cap exceeded')
        }
        finishTurn(turnId, text, state.output)
        return { ok: true }
      } catch (err) {
        const message = (err as Error).name === 'AbortError' ? `plugin ${provider.runtime} provider timed out after ${providerTimeoutMs}ms` : (err as Error).message
        emit({ type: 'error', bridgeId: opts.bridgeId, message })
        recordPluginDebug({ pluginId: provider.pluginId, registrationId: provider.registrationId, method: `provider:${provider.runtime}`, ok: false, category: 'provider-http', error: message, workspaceRoot: opts.cwd })
        return { ok: false, error: message }
      } finally {
        clearTimeout(timeout)
        currentAbort = null
      }
    },
    async compact() {
      return this.prompt(compactPromptFor(opts.provider))
    },
    async abort() { aborted = true; currentAbort?.abort(); currentProc?.kill('SIGTERM') },
    async stop() { aborted = true; currentAbort?.abort(); currentProc?.kill('SIGTERM'); emit({ type: 'closed', bridgeId: opts.bridgeId, code: 0 }) },
  }
}

export function registerAgentBridgeIpc(resolveAgentPath: AgentPathResolver): void {
  const createBridgeForProvider = async (
    path: string,
    opts: BridgeStartOpts,
    emit: EmitFn,
    requestUser: RequestUserFn,
  ): Promise<AgentBridge> => {
    if (opts.provider.startsWith('plugin:')) return createPluginAgentBridge(opts, emit)
    if (opts.provider === 'pi') return await createPiBridge(path, opts, emit, requestUser)
    if (opts.provider === 'codex') return await createCodexBridge(path, opts, emit, requestUser)
    if (opts.provider === 'claude') return await createClaudeBridge(path, opts, emit, requestUser)
    if (opts.provider === 'hermes') return await createHermesBridge(path, opts, emit, requestUser)
    if (opts.provider === 'crewcoder') return await createCrewCoderBridge(path, opts, emit, requestUser)
    if (opts.provider === 'grok') return await createGrokBridge(path, opts, emit, requestUser)
    if (opts.provider === 'ollama') return createOllamaBridge(path, opts, emit)
    if (opts.provider === 'openrouter') return createOpenrouterBridge(path, opts, emit)
    return await createOpencodeBridge(path, opts, emit, requestUser)
  }

  ipcMain.handle('agent:completion', async (_e, rawRequest: AgentCompletionRequest): Promise<AgentCompletionResult> => {
    if (!COMPLETION_PROVIDERS.has(rawRequest.provider)) return { ok: false, error: 'provider is not available for editor completions' }
    if (!rawRequest.requestId || !rawRequest.cwd || !rawRequest.rel) return { ok: false, error: 'invalid completion request' }
    if (completionRequests.has(rawRequest.requestId)) return { ok: false, error: 'completion request already exists' }

    const provider = rawRequest.provider as CompletionProviderId
    const isOpenCodeGo = provider === 'opencode-go'
    const remote = isRemoteRoot(rawRequest.cwd)
    const httpOnly = HTTP_ONLY_PROVIDERS.has(provider) || isOpenCodeGo
    const path = httpOnly ? provider : remote ? provider : resolveAgentPath(provider)
    if (!path) return { ok: false, error: `${provider} not found on this machine` }
    const apiKey = API_KEY_PROVIDERS.has(provider) || isOpenCodeGo ? getAgentKey(provider) ?? undefined : undefined
    if ((API_KEY_PROVIDERS.has(provider) || isOpenCodeGo) && !apiKey) return { ok: false, error: `${provider} API key not set` }

    const request: AgentCompletionRequest = {
      ...rawRequest,
      prefix: rawRequest.prefix.slice(-COMPLETION_PREFIX_LIMIT),
      suffix: rawRequest.suffix.slice(0, COMPLETION_SUFFIX_LIMIT),
    }
    const bridgeId = `editor-completion:${request.requestId}`
    const opts: BridgeStartOpts = {
      bridgeId,
      // OpenCode Go takes the dedicated branch below; every other value is a
      // normal bridge provider after the explicit completion-provider allowlist.
      provider: provider as BridgeStartOpts['provider'],
      cwd: request.cwd,
      model: request.model || undefined,
      mode: 'ask',
      toolPolicy: 'read-only',
      // Ghost text is a short, high-confidence continuation — reasoning only
      // adds latency and (on models that inline it into content) bleeds into
      // the completion. Disable it at the provider instead of only sanitizing.
      thinking: 'off',
      apiKey,
      freshSession: true,
      suppressProviderHistoryReplay: true,
      ephemeral: true,
    }

    let bridge: AgentBridge | null = null
    let output = ''
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = null
    let resolveResult!: (result: AgentCompletionResult) => void
    const result = new Promise<AgentCompletionResult>(resolve => { resolveResult = resolve })
    const settle = (value: AgentCompletionResult) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      completionRequests.delete(request.requestId)
      resolveResult(value)
      void bridge?.stop().catch(() => {})
    }
    const emit: EmitFn = event => {
      if (event.type === 'text_delta') {
        output += event.delta
        if (output.length > COMPLETION_OUTPUT_LIMIT) settle({ ok: false, error: 'completion exceeded output limit' })
      } else if (event.type === 'turn_end') {
        const completion = completionText(output)
        settle(completion ? { ok: true, completion } : { ok: false, error: 'provider returned an empty completion' })
      } else if (event.type === 'error') {
        settle({ ok: false, error: event.message })
      } else if (event.type === 'closed' && !settled) {
        const completion = completionText(output)
        settle(completion ? { ok: true, completion } : { ok: false, error: 'provider exited before completing' })
      }
    }
    const requestUser: RequestUserFn = async () => ({ requestId: `${bridgeId}:blocked`, bridgeId, action: 'decline' })

    try {
      bridge = isOpenCodeGo
        ? createOpenCodeGoCompletionBridge({ bridgeId, apiKey: apiKey!, model: request.model }, emit)
        : await createBridgeForProvider(path, opts, emit, requestUser)
      completionRequests.set(request.requestId, {
        bridge,
        cancel: () => settle({ ok: false, error: 'completion cancelled' }),
      })
      timeout = setTimeout(() => settle({ ok: false, error: 'completion timed out' }), COMPLETION_TIMEOUT_MS)
      const prompt = `You are CrewCode's inline code completion engine. Return ONLY the exact code to insert at <cursor>; do not explain, use Markdown fences, repeat surrounding code, call tools, or modify files. Prefer a short, high-confidence continuation. If no useful completion exists, return an empty response.\n\n<file path="${request.rel}" language="${request.language}">\n<before_cursor>\n${request.prefix}\n</before_cursor>\n<cursor/>\n<after_cursor>\n${request.suffix}\n</after_cursor>\n</file>`
      const started = await bridge.prompt(prompt)
      if (!started.ok) settle({ ok: false, error: started.error ?? 'provider rejected completion request' })
    } catch (err) {
      settle({ ok: false, error: (err as Error).message })
    }
    return result
  })

  ipcMain.on('agent:completionCancel', (_e, requestId: string) => {
    completionRequests.get(requestId)?.cancel()
  })

  ipcMain.handle('bridge:start', async (e, rawOpts: BridgeStartOpts & { sessionKey?: string; conversationScopeKey?: string }) => {
    const existing = bridges.get(rawOpts.bridgeId)
    if (existing) {
      await existing.bridge.stop().catch(() => {})
      bridges.delete(rawOpts.bridgeId)
      turnPermissionGrants.clearBridge(rawOpts.bridgeId)
      // Replacing a live bridge leaves its permission cards stranded otherwise.
      cancelPendingUserRequests(rawOpts.bridgeId, 'bridge restarted')
      custodyJournal().patch(rawOpts.bridgeId, { status: 'ended', endedAt: Date.now(), activePrompt: undefined })
    }

    // Remote SSH workspaces run the agent ON the host. Local: resolve the binary
    // on this machine. Remote: pass the bare name and let the host's login-shell
    // PATH resolve it (codex/pi/hermes/CrewCoder stream over the exec channel; opencode is
    // reached via an SSH port forward set up inside its bridge).
    const isPluginProvider = rawOpts.provider.startsWith('plugin:')
    const httpOnly = HTTP_ONLY_PROVIDERS.has(rawOpts.provider)
    const remote = isRemoteRoot(rawOpts.cwd)
    // HTTP-only providers (ollama, openrouter) have no binary to resolve — the
    // provider id stands in for the "path" the rest of the chain expects.
    const path = isPluginProvider || httpOnly ? rawOpts.provider : remote ? rawOpts.provider : resolveAgentPath(rawOpts.provider)
    if (!path) return { error: `${rawOpts.provider} not found on this machine` }

    // Hosted providers need a stored API key — inject it from main and fail
    // early (with a settings hint) rather than letting the bridge 401.
    let apiKey = rawOpts.apiKey
    if (API_KEY_PROVIDERS.has(rawOpts.provider)) {
      apiKey = getAgentKey(rawOpts.provider) ?? undefined
      if (!apiKey) return { error: `${rawOpts.provider} API key not set — add it in Settings → Agents` }
    }

    // Inject the saved resume id for this (tab, agent) — the renderer doesn't
    // know the upstream id, it only knows its own composite key. A separate
    // stable transcript key survives stale provider ids and restart fallbacks.
    const sessionKey = rawOpts.sessionKey ?? null
    const conversationScopeKey = rawOpts.conversationScopeKey ?? sessionKey
    // Halts are scoped to the thread, not the bridge: bridgeIds embed a
    // timestamp and are minted fresh on every start, so a bridge-scoped halt
    // would evaporate on exactly the restart that raised it.
    const custodyScopeKey = scopeKeyFor(sessionKey, rawOpts.bridgeId)

    // A halt still in force for this thread (typically raised by a restart
    // during a turn) refuses the start outright. Spawning the process and then
    // refusing its prompts would leave an orphaned provider running with a
    // grant nobody can vouch for. The halt travels back in the result rather
    // than as an event: the renderer's bridgeId→tab routing table is only
    // populated on its next render, so an event sent now could be dropped —
    // and a dropped halt is precisely the silent failure this exists to stop.
    const startHalt = activeHaltFor(custodyScopeKey)
    if (startHalt) {
      const haltedRecord = custodyJournal().haltedRecord(custodyScopeKey)
      return {
        error: refusalMessage('prompt', startHalt),
        custodyHalt: {
          scopeKey: custodyScopeKey,
          violation: startHalt,
          interruptedPrompt: haltedRecord?.interruptedPrompt,
          interruptedPartial: haltedRecord?.interruptedPartial,
        },
      }
    }
    const resumeId = sessionKey && !rawOpts.freshSession ? getSessionId(sessionKey) : undefined
    // The upstream resume id is provider-specific, but CrewCode's local replay
    // transcript is session-scoped so provider swaps can continue the thread.
    const conversationKey = conversationScopeKey ? threadConversationKey(conversationScopeKey) : undefined
    const localHistoryCount = conversationKey ? loadConversation(conversationKey).length : 0
    const hasLocalHistory = localHistoryCount > 0
    const nativeResume = isNativeResumeProvider(rawOpts.provider)
    const replayKey = conversationKey ? replayMarker(conversationKey, rawOpts.provider) : null
    const replayAlreadyUsed = replayKey ? replayInjectedForThread.has(replayKey) : false
    const suppressProviderHistoryReplay = (rawOpts.provider === 'hermes' || rawOpts.provider === 'crewcoder' || rawOpts.provider === 'grok') && hasLocalHistory
    const opts: BridgeStartOpts = { ...rawOpts, resumeSessionId: resumeId, conversationKey, apiKey, suppressProviderHistoryReplay }
    // Literal transcript replay is only for native providers when native resume
    // is unavailable/stale, and only once per app run to avoid token blowups.
    let injectHistoryOnNextPrompt = nativeResume && hasLocalHistory && !resumeId && !replayAlreadyUsed

    sessionDebug('bridge:start', {
      provider: rawOpts.provider,
      bridgeId: rawOpts.bridgeId,
      sessionKey,
      conversationScopeKey,
      resumeId: resumeId ?? null,
      localHistoryCount,
      nativeResume,
      strategy: rawOpts.freshSession ? 'fresh-handoff-summary' : httpOnly ? 'stateless-local-messages' : isPluginProvider ? 'plugin-local-history' : resumeId ? 'native-resume' : hasLocalHistory ? 'native-replay-once' : 'fresh',
      willReplayHistory: injectHistoryOnNextPrompt,
      suppressProviderHistoryReplay,
      replayAlreadyUsed,
    })

    const win = BrowserWindow.fromWebContents(e.sender)
    const requestUser: RequestUserFn = (request) => {
      // Check custody before even an auto-response is prepared. Otherwise a
      // Full Access grant could approve a request after its scope disappeared.
      const liveEntry = bridges.get(opts.bridgeId)
      if (liveEntry) {
        const refused = custodyRefusal(liveEntry, opts.bridgeId, 'authorize')
        if (refused) return Promise.resolve({ requestId: `${opts.bridgeId}:custody-refused`, action: 'decline' })
      }
      const prepared = turnPermissionGrants.prepareRequest(opts.bridgeId, opts.mode, opts.toolPolicy, request)
      if (prepared.autoResponse) return Promise.resolve(prepared.autoResponse)

      const requestId = `${opts.bridgeId}-ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const payload: AgentUserRequest = { ...prepared.request, requestId, bridgeId: opts.bridgeId }
      return new Promise<AgentUserResponse>((resolve) => {
        pendingUserRequests.set(requestId, { bridgeId: opts.bridgeId, request: payload, resolve })
        win?.webContents.send('bridge:event', { type: 'user_request', request: payload } satisfies BridgeEvent)
      })
    }
    const emit = (event: BridgeEvent) => {
      let eventToSend = event
      if (event.type === 'turn_start') turnPermissionGrants.clearBridge(opts.bridgeId)
      else if (event.type === 'turn_end') turnPermissionGrants.clearTurn(opts.bridgeId, event.turnId)
      else if (event.type === 'error' || event.type === 'closed') turnPermissionGrants.clearBridge(opts.bridgeId)
      // Persist the upstream session id as soon as the bridge reports one so a
      // crash mid-conversation still leaves a resumable id behind.
      if (event.type === 'session_id' && sessionKey) {
        setSessionId(sessionKey, event.sessionId)
        const nativeResumeFailed = nativeResume && !!resumeId && !event.resumed
        if (nativeResumeFailed && hasLocalHistory) {
          injectHistoryOnNextPrompt = !replayAlreadyUsed
          if (replayAlreadyUsed) {
            sessionDebug('native resume failed; replay already used, not injecting history again', {
              provider: rawOpts.provider,
              bridgeId: event.bridgeId,
              sessionKey,
              requestedResumeId: resumeId,
              emittedSessionId: event.sessionId,
              localHistoryCount,
            })
          }
        }
        sessionDebug('session_id', {
          provider: rawOpts.provider,
          bridgeId: event.bridgeId,
          sessionKey,
          requestedResumeId: resumeId ?? null,
          emittedSessionId: event.sessionId,
          resumed: event.resumed,
          nativeResumeFailed,
          willReplayHistory: injectHistoryOnNextPrompt,
          localHistoryCount,
        })
        const entry = bridges.get(event.bridgeId)
        if (entry) entry.injectHistoryOnNextPrompt = injectHistoryOnNextPrompt
      }
      // Keep the idle clock and running flag current for the sweep.
      const eventBridgeId = event.type === 'user_request' ? event.request.bridgeId : event.bridgeId
      const entry = bridges.get(eventBridgeId)
      if (entry && event.type === 'compaction_event' && event.status === 'completed' && event.resetContext) {
        // Native compaction invalidates the old absolute occupancy immediately.
        // Do not display or persist a fabricated zero: leave context unknown until
        // the provider's next authoritative usage report repopulates it.
        entry.lastUsage = undefined
        if (entry.sessionKey) clearUsageSnapshot(entry.sessionKey)
      }
      if (entry && (event.type === 'turn_end' || event.type === 'usage_update') && event.usage) {
        const previousUsage = entry.lastUsage
        const detection = detectAutoCompaction(previousUsage, event.usage, event.type)
        // Only providers with a verified absolute-context usage contract use
        // inference. Claude emits authoritative compact_boundary events; Pi,
        // Hermes, HTTP providers, and plugins must not be guessed from CLI-ness.
        const inferProviderCompaction = autoCompactionSignalForProvider(entry.provider) === 'usage'
        if (detection && inferProviderCompaction && !entry.pendingManualCompaction && !entry.pendingSummaryReset) {
          entry.pendingAutoCompaction = detection === 'started'
          win?.webContents.send('bridge:event', {
            type: 'compaction_event',
            bridgeId: event.bridgeId,
            turnId: event.turnId,
            status: detection,
            automatic: true,
            message: detection === 'started'
              ? `${entry.provider} auto-compaction detected; rebuilding context…`
              : `${entry.provider} auto-compacted context. Continue the conversation normally.`,
            beforeTokens: previousUsage?.contextTokens,
            afterTokens: event.usage.contextTokens,
            provider: entry.provider,
          } satisfies BridgeEvent)
        }
        const usage = normalizeContextUsage(previousUsage, event.usage, { provider: entry.provider })
        if (usage && usage !== event.usage) {
          eventToSend = event.type === 'turn_end'
            ? { ...event, usage }
            : { ...event, usage }
        }
        entry.lastUsage = usage
        // Persist the meter baseline so resume keeps the running context instead
        // of collapsing to 0 on the first new turn (see sessionStore).
        if (entry.sessionKey && usage?.contextTokens) {
          setUsageSnapshot(entry.sessionKey, {
            contextTokens: usage.contextTokens,
            contextWindow: usage.contextWindow,
            model: usage.model,
          })
        }
      }
      if (entry) {
        entry.lastActivityAt = Date.now()
        const recordLocalHistory = !!entry.conversationKey
          && !HTTP_ONLY_PROVIDERS.has(entry.provider)
          && !entry.provider.startsWith('plugin:')
        if (recordLocalHistory && event.type === 'turn_start') {
          const promptText = entry.pendingPromptTexts.shift()
          if (promptText) entry.promptTextByTurn[event.turnId] = promptText
          entry.assistantTextByTurn[event.turnId] = ''
        } else if (recordLocalHistory && event.type === 'text_delta') {
          entry.assistantTextByTurn[event.turnId] = (entry.assistantTextByTurn[event.turnId] ?? '') + event.delta
        } else if (recordLocalHistory && event.type === 'turn_end') {
          const promptText = entry.promptTextByTurn[event.turnId]
          const assistantText = entry.assistantTextByTurn[event.turnId] ?? ''
          if (promptText) {
            const history = loadConversation(entry.conversationKey!)
            history.push({ role: 'user', content: promptText })
            history.push({ role: 'assistant', content: assistantText })
            saveConversation(entry.conversationKey!, history)
            sessionDebug('local transcript saved', {
              provider: entry.provider,
              bridgeId: event.bridgeId,
              sessionKey: entry.sessionKey,
              turnId: event.turnId,
              localHistoryCount: history.length,
            })
          }
          delete entry.promptTextByTurn[event.turnId]
          delete entry.assistantTextByTurn[event.turnId]
        }
        if (event.type === 'turn_start') {
          entry.running = true
          entry.userInitiatedStop = false
          // This path handles provider-internal queued follow-ups. Direct
          // prompts apply the deferred mode before calling the provider, but a
          // provider may start its next queued turn without another IPC call.
          applyDeferredMode(entry, event.bridgeId)
          custodyJournal().patch(event.bridgeId, {
            status: 'running', turnId: event.turnId, turnStartedAt: Date.now(),
            authority: authorityOf(entry.opts), pid: entry.bridge.pid,
          })
        } else if (event.type === 'turn_end') {
          entry.running = false
          // Only a real turn_end closes a running record. Nothing else does.
          custodyJournal().patch(event.bridgeId, { status: 'idle', turnId: undefined, turnStartedAt: undefined, activePrompt: undefined })
        } else if (event.type === 'closed' || event.type === 'error') {
          entry.running = false
        }
        if ((event.type === 'error' || event.type === 'closed') && entry.pendingAutoCompaction) {
          entry.pendingAutoCompaction = false
          win?.webContents.send('bridge:event', {
            type: 'compaction_event',
            bridgeId: event.bridgeId,
            status: 'failed',
            automatic: true,
            message: `${entry.provider} stopped before auto-compaction completed.`,
            provider: entry.provider,
          } satisfies BridgeEvent)
        }
        if (event.type === 'turn_end' && entry.pendingAutoCompaction) {
          entry.pendingAutoCompaction = false
          win?.webContents.send('bridge:event', {
            type: 'compaction_event',
            bridgeId: event.bridgeId,
            turnId: event.turnId,
            status: 'completed',
            automatic: true,
            message: `${entry.provider} auto-compacted context. Continue the conversation normally.`,
            percent: 100,
            provider: entry.provider,
          } satisfies BridgeEvent)
        }
        if (event.type === 'turn_end' && entry.pendingManualCompaction) {
          entry.pendingManualCompaction = false
          if (HTTP_ONLY_PROVIDERS.has(entry.provider) || entry.provider.startsWith('plugin:')) compactLocalConversation(entry.conversationKey)
          win?.webContents.send('bridge:event', {
            type: 'compaction_event',
            bridgeId: event.bridgeId,
            turnId: event.turnId,
            status: 'completed',
            automatic: false,
            message: 'Session compacted. Continue the conversation normally.',
            percent: 100,
            provider: entry.provider,
          } satisfies BridgeEvent)
        }
        // Summary-reset: the summary turn just ended and is now recorded in local
        // history. Collapse to it, abandon the upstream session, and tear the
        // bridge down silently so the next prompt seeds a fresh, small session.
        if (event.type === 'turn_end' && entry.pendingSummaryReset) {
          entry.pendingSummaryReset = false
          compactLocalConversation(entry.conversationKey)
          if (entry.sessionKey) clearSessionId(entry.sessionKey)
          if (entry.conversationKey) replayInjectedForThread.delete(replayMarker(entry.conversationKey, entry.provider))
          entry.lastUsage = undefined
          const teardownEntry = entry
          const teardownId = event.bridgeId
          // Defer renderer sends + teardown past this turn's own turn_end emit
          // (below) so ordering is turn_end → completed → idle_stopped, and we
          // never stop the bridge re-entrantly from inside its own event.
          queueMicrotask(() => {
            teardownEntry.bridge.stop().catch(() => {})
            bridges.delete(teardownId)
            const wc = webContents.fromId(teardownEntry.webContentsId)
            wc?.send('bridge:event', {
              type: 'compaction_event',
              bridgeId: teardownId,
              status: 'completed',
              automatic: false,
              message: 'Session compacted to a summary. Continue the conversation normally.',
              provider: teardownEntry.provider,
            } satisfies BridgeEvent)
            wc?.send('bridge:event', { type: 'idle_stopped', bridgeId: teardownId } satisfies BridgeEvent)
          })
        }
      }
      // Custody tripwire on process exit. A provider that dies while a turn is
      // in flight leaves that turn's effects unobserved — the one thing this
      // must never do is treat the silence that follows as a completed turn.
      // Deferred past this event so the renderer sees 'closed' then the halt.
      if (entry && (event.type === 'closed' || event.type === 'error')) {
        const record = custodyJournal().get(event.bridgeId)
        const lostMidTurn = record?.status === 'running' && !entry.userInitiatedStop
        const detail = event.type === 'closed'
          ? `${entry.provider} exited (code ${event.code ?? 'unknown'}) while a turn was still running`
          : `${entry.provider} failed while a turn was still running: ${event.message}`
        const scope = { bridgeId: event.bridgeId, provider: entry.provider, cwd: entry.opts.cwd, turnId: record?.turnId, sessionKey: entry.sessionKey }
        const bridgeId = event.bridgeId
        queueMicrotask(() => {
          if (lostMidTurn) haltBridge(bridgeId, custodyViolation('execution-custody-lost', detail, scope))
          else {
            custodyJournal().patch(bridgeId, { status: 'ended', endedAt: Date.now(), turnId: undefined, activePrompt: undefined })
            cancelPendingUserRequests(bridgeId, event.type)
          }
        })
      }
      win?.webContents.send('bridge:event', eventToSend)
    }

    try {
      const bridge = await createBridgeForProvider(path, opts, emit, requestUser)

      bridges.set(opts.bridgeId, {
        bridge,
        webContentsId: e.sender.id,
        sessionKey,
        provider:       opts.provider,
        providerPath:   path,
        opts,
        startedAt:      Date.now(),
        lastActivityAt: Date.now(),
        running:        false,
        conversationKey: conversationKey ?? null,
        injectHistoryOnNextPrompt,
        pendingPromptTexts: [],
        promptTextByTurn: {},
        assistantTextByTurn: {},
        // Seed the meter baseline from disk so a resumed session's first turn is
        // floored to the real prior context instead of restarting from 0.
        lastUsage: sessionKey ? getUsageSnapshot(sessionKey) : undefined,
        pendingManualCompaction: false,
        pendingAutoCompaction: false,
        pendingSummaryReset: false,
        custodyScopeKey,
        userInitiatedStop: false,
      })

      // Open the custody record for this execution. It is the authority of
      // record from here on: any later divergence between it and entry.opts is
      // drift, and a record still marked 'running' at next launch is recovered
      // as halted rather than assumed to have finished.
      custodyJournal().open({
        bridgeId: opts.bridgeId,
        sessionKey,
        authority: authorityOf(opts),
        pid: bridge.pid,
        status: 'idle',
        startedAt: Date.now(),
        updatedAt: Date.now(),
      })

      return { ok: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  // Clear the persisted resume id so the next bridge:start opens a fresh
  // upstream session. Doesn't touch the live bridge — callers stop it first.
  ipcMain.handle('bridge:resetSession', (_e, payload: string | { sessionKey: string; conversationScopeKey?: string }) => {
    const sessionKey = typeof payload === 'string' ? payload : payload.sessionKey
    const conversationScopeKey = typeof payload === 'string' ? payload : payload.conversationScopeKey ?? payload.sessionKey
    // Drop both the provider-native id and CrewCode's shared transcript key.
    // Normal picker changes must not call this; it is for explicit new-session UX.
    const sessionId = getSessionId(sessionKey)
    if (sessionId) clearConversation(sessionId)
    clearConversation(threadConversationKey(conversationScopeKey))
    clearSessionId(sessionKey)
    return { ok: true }
  })

  ipcMain.handle('bridge:respondUserRequest', (_e, response: AgentUserResponse) => {
    const pending = pendingUserRequests.get(response.requestId)
    if (!pending) return { error: 'request not found or already resolved' }
    // Approving a tool call is a privileged action: a halted thread must not be
    // able to launder a new grant through a permission card that predates it.
    const respondingEntry = bridges.get(pending.bridgeId)
    if (respondingEntry && response.action !== 'decline' && response.action !== 'cancel') {
      const refusedResponse = custodyRefusal(respondingEntry, pending.bridgeId, 'respond')
      if (refusedResponse) return refusedResponse
    }
    let resolved = response
    let grantedTurnId: string | null = null
    if (response.action === 'accept_for_turn') {
      if (!turnPermissionGrants.grant(pending.bridgeId, pending.request)) {
        return { error: 'allow all is unavailable for this permission request' }
      }
      grantedTurnId = pending.request.turnId ?? null
      resolved = { ...response, action: 'accept' }
    }
    pendingUserRequests.delete(response.requestId)
    pending.resolve(resolved)
    const target = webContents.fromId(bridges.get(pending.bridgeId)?.webContentsId ?? -1)
    target?.send('bridge:event', {
      type: 'user_request_resolved',
      bridgeId: pending.bridgeId,
      requestId: response.requestId,
    } satisfies BridgeEvent)

    if (grantedTurnId) {
      for (const [requestId, other] of pendingUserRequests) {
        if (other.bridgeId !== pending.bridgeId
          || other.request.turnId !== grantedTurnId
          || !other.request.allowAllForTurn) continue
        pendingUserRequests.delete(requestId)
        other.resolve({ requestId, action: 'accept' })
        target?.send('bridge:event', {
          type: 'user_request_resolved',
          bridgeId: other.bridgeId,
          requestId,
        } satisfies BridgeEvent)
      }
    }
    return { ok: true }
  })

  const summarizeHandoffWithDisposable = async (entry: BridgeEntry, history: StoredMessage[], handoff: HandoffPromptOptions, reason: 'handoff' | 'compact' = 'handoff'): Promise<string | null> => {
    const tempBridgeId = `${entry.opts.bridgeId}-${reason}-${Date.now().toString(36)}`
    const tempConversationKey = `disposable-handoff:${tempBridgeId}`
    let summary = ''
    let lastError: string | null = null
    let settled = false
    let resolveDone!: (value: { ok: boolean; error?: string }) => void
    const done = new Promise<{ ok: boolean; error?: string }>(resolve => { resolveDone = resolve })
    const settle = (value: { ok: boolean; error?: string }) => {
      if (settled) return
      settled = true
      resolveDone(value)
    }
    const tempOpts: BridgeStartOpts = {
      ...entry.opts,
      bridgeId: tempBridgeId,
      resumeSessionId: undefined,
      conversationKey: tempConversationKey,
      suppressProviderHistoryReplay: true,
    }
    const emit: EmitFn = (event) => {
      if (event.type === 'text_delta') summary += event.delta
      if (event.type === 'error') {
        lastError = event.message
        sessionDebug('disposable handoff summary error event', { provider: entry.provider, message: event.message })
        settle({ ok: false, error: event.message })
      }
      if (event.type === 'turn_end') settle({ ok: true })
      if (event.type === 'closed') settle({ ok: summary.trim().length > 0, error: summary.trim() ? undefined : `provider exited before producing a ${reason} summary` })
    }
    const requestUser: RequestUserFn = async () => ({ requestId: `${tempBridgeId}-cancel`, bridgeId: tempBridgeId, action: 'cancel' })
    let bridge: AgentBridge | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null
    try {
      bridge = await createBridgeForProvider(entry.providerPath, tempOpts, emit, requestUser)
      const transcript = boundedHistoryText(history, DISPOSABLE_SUMMARY_TRANSCRIPT_CHARS)
      const action = reason === 'compact'
        ? 'You are compacting a CrewCode conversation.'
        : 'You are preparing a provider handoff summary for CrewCode.'
      const prompt = `${action} Summarize the following bounded transcript so a fresh agent session can continue without the raw transcript. Preserve goals, decisions, constraints, files/paths mentioned, completed work, open questions, and next steps. If the transcript says older messages were omitted, explicitly account for that limitation. Do not use tools. Respond only with the summary.\n\n<workspace_context>\n${handoff.workspace?.name ? `- Workspace: ${handoff.workspace.name}\n` : ''}${handoff.workspace?.path ? `- Path: ${handoff.workspace.path}\n` : ''}${handoff.workspace?.branch ? `- Branch: ${handoff.workspace.branch}\n` : ''}</workspace_context>\n\n<conversation_transcript>\n${transcript}\n</conversation_transcript>`
      timeout = setTimeout(() => settle({ ok: false, error: `${reason} summary timed out` }), 120_000)
      const result = await bridge.prompt(prompt)
      if (!result.ok) return null
      const completed = await done
      if (!completed.ok || !summary.trim()) {
        sessionDebug('disposable handoff summary produced no usable text', { provider: entry.provider, error: completed.error ?? lastError })
        return null
      }
      return summary.trim()
    } catch (err) {
      sessionDebug('disposable handoff summary failed', { provider: entry.provider, error: (err as Error).message })
      return null
    } finally {
      if (timeout) clearTimeout(timeout)
      await bridge?.stop().catch(() => {})
      clearConversation(tempConversationKey)
    }
  }

  ipcMain.handle('bridge:prompt', async (_e, { bridgeId, text, options }: { bridgeId: string; text: string; options?: PromptOptions }) => {
    const entry = bridges.get(bridgeId)
    if (!entry) return { error: 'bridge not found' }
    // Prompting is the moment authority is actually exercised, so it is the
    // moment the invariants are re-checked. A halted thread refuses here.
    const refused = custodyRefusal(entry, bridgeId, 'prompt')
    if (refused) return refused
    const queueingFollowUp = entry.running && options?.streamingBehavior === 'followUp'
    // A direct next-turn prompt must see the deferred mode before the provider
    // builds its request. turn_start is too late for providers that serialize
    // mode into the request before emitting that event.
    if (!queueingFollowUp) applyDeferredMode(entry, bridgeId)
    // Mark custody before handoff summarization or provider setup begins. A
    // process can disappear before turn_start; that gap is still in-flight work,
    // not an idle bridge whose outcome may be inferred cleanly.
    entry.userInitiatedStop = false
    entry.running = true
    entry.lastActivityAt = Date.now()
    entry.pendingPromptTexts.push(text)
    if (!queueingFollowUp) {
      custodyJournal().patch(bridgeId, {
        status: 'running', turnId: undefined, turnStartedAt: Date.now(),
        activePrompt: text, authority: authorityOf(entry.opts), pid: entry.bridge.pid,
      })
    }

    const localHistory = entry.conversationKey ? loadConversation(entry.conversationKey) : []
    const marker = entry.conversationKey ? replayMarker(entry.conversationKey, entry.provider) : null
    const shouldHandoff = !!options?.handoff && localHistory.length > 0
    const shouldInjectHistory = !shouldHandoff
      && entry.injectHistoryOnNextPrompt
      && !!marker
      && !replayInjectedForThread.has(marker)
      && localHistory.length > 0
    const sendStatus = (message: string, phase: Extract<BridgeEvent, { type: 'status' }>['phase']) => {
      webContents.fromId(entry.webContentsId)?.send('bridge:event', { type: 'status', bridgeId, message, phase } satisfies BridgeEvent)
    }

    if (shouldHandoff) sendStatus(`Summarizing conversation for ${entry.provider} handoff…`, 'handoff')
    else if (shouldInjectHistory) sendStatus(`Replaying ${localHistory.length} saved messages into ${entry.provider}…`, 'replaying_history')
    else if (entry.opts.resumeSessionId) sendStatus(`Resuming ${entry.provider} session…`, 'resuming')

    const handoffSummary = shouldHandoff
      ? await summarizeHandoffWithDisposable(entry, localHistory, options!.handoff!)
      : null
    if (handoffSummary?.trim() && options?.handoff) {
      webContents.fromId(entry.webContentsId)?.send('bridge:event', {
        type: 'handoff_summary',
        bridgeId,
        summary: handoffSummary.trim(),
        fromProvider: options.handoff.fromProvider,
        toProvider: options.handoff.toProvider ?? entry.provider,
      } satisfies BridgeEvent)
    }
    const contextPreamble = shouldHandoff
      ? handoffPrompt(localHistory, entry, options!.handoff!, handoffSummary)
      : shouldInjectHistory
        ? historyAsPrompt(localHistory)
        : ''
    const wireText = contextPreamble ? contextPreamble + text : text
    if (shouldHandoff && marker) {
      replayInjectedForThread.add(marker)
      entry.injectHistoryOnNextPrompt = false
    } else if (shouldInjectHistory) {
      replayInjectedForThread.add(marker!)
      entry.injectHistoryOnNextPrompt = false
    }

    sessionDebug('prompt', {
      provider: entry.provider,
      bridgeId,
      sessionKey: entry.sessionKey,
      localHistoryCount: localHistory.length,
      replayInjected: shouldInjectHistory,
      handoffInjected: shouldHandoff,
      handoffSummaryGenerated: !!handoffSummary,
      replaySuppressed: entry.injectHistoryOnNextPrompt && !shouldInjectHistory && !shouldHandoff,
      strategy: HTTP_ONLY_PROVIDERS.has(entry.provider) ? 'stateless-local-messages' : entry.provider.startsWith('plugin:') ? 'plugin-local-history' : shouldInjectHistory ? 'native-replay-once' : 'native-session',
    })

    const startupLabel = shouldHandoff
      ? `Starting ${entry.provider} with handoff summary…`
      : shouldInjectHistory
        ? `Starting ${entry.provider} with saved conversation history…`
        : entry.opts.resumeSessionId
          ? `Starting ${entry.provider} from resumed session…`
          : `Starting ${entry.provider} runtime…`

    sendStatus(startupLabel, entry.opts.resumeSessionId ? 'resuming' : 'starting')
    let result: { ok: boolean; error?: string }
    try {
      result = await entry.bridge.prompt(wireText, options)
    } catch (error) {
      const message = (error as Error).message || String(error)
      const record = custodyJournal().get(bridgeId)
      haltBridge(bridgeId, custodyViolation(
        'execution-custody-lost',
        `${entry.provider} prompt channel failed while execution was in flight: ${message}`,
        { bridgeId, provider: entry.provider, cwd: entry.opts.cwd, turnId: record?.turnId, sessionKey: entry.sessionKey },
      ))
      return { ok: false, error: message }
    }
    if (!result.ok) {
      const idx = entry.pendingPromptTexts.indexOf(text)
      if (idx !== -1) entry.pendingPromptTexts.splice(idx, 1)
      // A provider rejection observed before turn_start is known state. Do not
      // leave a synthetic running record that would become a false restart halt.
      const record = custodyJournal().get(bridgeId)
      if (!queueingFollowUp && bridges.get(bridgeId) === entry && record?.status === 'running' && !record.turnId) {
        entry.running = false
        custodyJournal().patch(bridgeId, { status: 'idle', turnStartedAt: undefined, activePrompt: undefined })
      }
    }
    return result
  })

  ipcMain.handle('bridge:compact', async (_e, { bridgeId }: { bridgeId: string }) => {
    const entry = bridges.get(bridgeId)
    if (!entry) return { ok: false, error: 'bridge not found' }
    const refusedCompact = custodyRefusal(entry, bridgeId, 'compact')
    if (refusedCompact) return { ok: false, ...refusedCompact }
    const strategy = compactionStrategy({
      provider: entry.provider,
      hasNativeCompact: !!entry.bridge.compact,
      httpOnly: HTTP_ONLY_PROVIDERS.has(entry.provider),
      nativeResume: isNativeResumeProvider(entry.provider),
      hasConversationKey: !!entry.conversationKey,
    })
    if (strategy === 'unsupported') {
      return { ok: false, unsupported: true, error: `${entry.provider} does not support /compact yet` }
    }
    const emitCompaction = (status: 'started' | 'completed' | 'failed', message: string) => {
      webContents.fromId(entry.webContentsId)?.send('bridge:event', {
        type: 'compaction_event',
        bridgeId,
        status,
        automatic: false,
        message,
        percent: status === 'completed' ? 100 : usagePercent(entry.lastUsage),
        provider: entry.provider,
      } satisfies BridgeEvent)
    }
    emitCompaction('started', `${entry.provider} compaction requested`)

    const history = entry.conversationKey ? loadConversation(entry.conversationKey) : []
    if (!entry.conversationKey || history.length === 0) {
      emitCompaction('failed', 'No conversation history available to compact.')
      return { ok: false, error: 'no conversation history available to compact' }
    }

    const compactionTurnId = `${bridgeId}:compaction:${Date.now().toString(36)}`
    entry.userInitiatedStop = false
    entry.running = true
    entry.lastActivityAt = Date.now()
    custodyJournal().patch(bridgeId, {
      status: 'running', turnId: compactionTurnId, turnStartedAt: Date.now(),
      activePrompt: 'Compact the current conversation', authority: authorityOf(entry.opts),
    })

    try {
      const summary = await summarizeHandoffWithDisposable(entry, history, {
        fromProvider: entry.provider,
        toProvider: entry.provider,
        model: entry.opts.model,
        mode: entry.opts.mode,
        workspace: { path: entry.opts.cwd },
      }, 'compact')
      if (!summary?.trim()) {
        emitCompaction('failed', 'Compaction summary failed.')
        return { ok: false, error: 'compaction summary failed' }
      }

      saveCompactedSummary(entry.conversationKey, summary)
      if (entry.sessionKey) clearSessionId(entry.sessionKey)
      replayInjectedForThread.delete(replayMarker(entry.conversationKey, entry.provider))
      entry.lastUsage = undefined
      webContents.fromId(entry.webContentsId)?.send('bridge:event', {
        type: 'handoff_summary',
        bridgeId,
        summary,
        fromProvider: entry.provider,
        toProvider: entry.provider,
        reason: 'compact',
      } satisfies BridgeEvent)
      emitCompaction('completed', 'Session compacted to a visible summary. Continue the conversation normally.')

      const teardownEntry = entry
      queueMicrotask(() => {
        teardownEntry.bridge.stop().catch(() => {})
        bridges.delete(bridgeId)
        webContents.fromId(teardownEntry.webContentsId)?.send('bridge:event', { type: 'idle_stopped', bridgeId } satisfies BridgeEvent)
      })
      return { ok: true }
    } finally {
      entry.running = false
      entry.lastActivityAt = Date.now()
      const record = custodyJournal().get(bridgeId)
      if (record?.status === 'running' && record.turnId === compactionTurnId) {
        custodyJournal().patch(bridgeId, { status: 'idle', turnId: undefined, turnStartedAt: undefined, activePrompt: undefined })
      }
    }
  })

  ipcMain.handle('bridge:removeFollowUp', async (_e, { bridgeId, followUpId }: { bridgeId: string; followUpId: string }) => {
    const entry = bridges.get(bridgeId)
    if (!entry) return { ok: false, error: 'bridge not found' }
    const refusedFollowUp = custodyRefusal(entry, bridgeId, 'removeFollowUp')
    if (refusedFollowUp) return { ok: false, ...refusedFollowUp }
    if (!entry.bridge.removeFollowUp) return { ok: false, error: `${entry.provider} queues follow-ups upstream; they cannot be removed` }
    return entry.bridge.removeFollowUp(followUpId)
  })

  ipcMain.on('bridge:setMode', (_e, { bridgeId, mode }: { bridgeId: string; mode: BridgeStartOpts['mode'] }) => {
    const entry = bridges.get(bridgeId)
    if (!entry || !mode) return
    if (activeHaltFor(entry.custodyScopeKey)) {
      sendToClient(entry, { type: 'custody_deferred', bridgeId, message: 'Mode change refused: this thread is halted until you reauthorize it.' })
      return
    }
    // Authority must not change underneath a turn that is already executing.
    // The change is refused now and applied at the next turn_start rather than
    // killing in-progress work — the deferral IS the enforcement.
    const decision = decideModeChange(entry.opts.mode, mode, entry.running)
    if (!decision.apply) {
      entry.pendingMode = mode
      sendToClient(entry, { type: 'custody_deferred', bridgeId, message: decision.reason })
      return
    }
    entry.opts.mode = mode
    entry.pendingMode = undefined
    // Record the sanctioned change so the drift check does not later read the
    // user's own authorized choice as an unexplained mutation.
    custodyJournal().patch(bridgeId, { authority: authorityOf(entry.opts) })
  })

  ipcMain.on('bridge:abort', async (_e, bridgeId: string) => {
    turnPermissionGrants.clearBridge(bridgeId)
    const entry = bridges.get(bridgeId)
    if (!entry) return
    // User-initiated: the turn ending here is known state, not lost custody.
    entry.userInitiatedStop = true
    custodyJournal().patch(bridgeId, { status: 'idle', turnId: undefined, turnStartedAt: undefined, activePrompt: undefined })
    cancelPendingUserRequests(bridgeId, 'aborted by user')
    await entry.bridge.abort().catch(() => {})
  })

  ipcMain.on('bridge:stop', async (_e, bridgeId: string) => {
    turnPermissionGrants.clearBridge(bridgeId)
    const entry = bridges.get(bridgeId)
    if (!entry) return
    entry.userInitiatedStop = true
    custodyJournal().patch(bridgeId, { status: 'ended', endedAt: Date.now(), turnId: undefined, activePrompt: undefined })
    cancelPendingUserRequests(bridgeId, 'stopped by user')
    // Stop is the user's "make it stop no matter what" escape hatch, so we
    // try a polite abort first before tearing the bridge process down.
    await entry.bridge.abort().catch(() => {})
    await entry.bridge.stop().catch(() => {})
    bridges.delete(bridgeId)
  })

  // Explicit human reauthorization — the only way out of a halt. The halted
  // record is stamped, never deleted, so the evidence trail survives resuming.
  ipcMain.handle('bridge:reauthorize', (_e, { bridgeId, scopeKey }: { bridgeId?: string; scopeKey?: string }) => {
    const entry = bridgeId ? bridges.get(bridgeId) : undefined
    const key = scopeKey ?? entry?.custodyScopeKey
    if (!key) return { ok: false, error: 'no custody scope to reauthorize' }
    const cleared = custodyJournal().reauthorize(key)
    if (!cleared) return { ok: false, error: 'no halt in force for this thread' }
    sessionDebug('custody: reauthorized', { scopeKey: key, cleared })
    const target = entry ? webContents.fromId(entry.webContentsId) : BrowserWindow.getAllWindows()[0]?.webContents
    target?.send('bridge:event', { type: 'custody_cleared', bridgeId: bridgeId ?? '', scopeKey: key } satisfies BridgeEvent)
    return { ok: true, cleared }
  })

  // Read-only custody state for a thread. Deliberately never gated by a halt:
  // a halt must not hide the evidence it exists to preserve.
  ipcMain.handle('bridge:custodyState', (_e, { sessionKey, bridgeId }: { sessionKey?: string | null; bridgeId?: string }) => {
    const key = scopeKeyFor(sessionKey ?? null, bridgeId ?? '')
    const journal = custodyJournal()
    return { ok: true, scopeKey: key, halt: journal.activeHalt(key), record: journal.haltedRecord(key), history: journal.forScope(key) }
  })

  // Bridge runtimes are intentionally long-lived. Navigation, hidden chat tabs,
  // and idle time must not stop them; only app shutdown or explicit Stop does.
}

// ─── Idle sweep (disabled) ─────────────────────────────────────────────────
// Kept as a manual diagnostic hook, but not started during normal app use:
// users expect bridge sessions to stay continuous while navigating elsewhere.

const IDLE_SWEEP_MS = 60_000          // how often to check
const IDLE_STOP_MS  = 10 * 60_000     // idle this long → stop
let idleTimer: ReturnType<typeof setInterval> | null = null

function sweepIdleBridges(): void {
  const now = Date.now()
  for (const [bridgeId, entry] of [...bridges]) {
    if (entry.running) continue
    if (now - entry.lastActivityAt < IDLE_STOP_MS) continue
    // Tell the renderer to drop this bridge's keys silently (keeps the resume
    // id) before tearing the process down.
    webContents.fromId(entry.webContentsId)?.send('bridge:event', { type: 'idle_stopped', bridgeId })
    entry.bridge.stop().catch(() => {})
    bridges.delete(bridgeId)
    turnPermissionGrants.clearBridge(bridgeId)
  }
}

export function startIdleBridgeSweep(): void {
  if (idleTimer) return
  idleTimer = setInterval(sweepIdleBridges, IDLE_SWEEP_MS)
  // Don't let the sweep timer keep the process alive on quit.
  idleTimer.unref?.()
}

export function stopIdleBridgeSweep(): void {
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null }
}

export function stopAllBridges(): void {
  stopIdleBridgeSweep()
  for (const [, e] of bridges) e.bridge.stop().catch(() => {})
  bridges.clear()
  turnPermissionGrants.clear()
}

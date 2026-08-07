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
import { getSessionId, setSessionId, clearSessionId, getUsageSnapshot, setUsageSnapshot } from './sessionStore'
import { clearConversation, loadConversation, saveConversation, type StoredMessage } from './conversation-store'
import { isRemoteRoot } from '../remote/ssh-target'
import { loadPluginRegistry, recordPluginDebug } from '../plugins'
import { requiredPermissionsForPluginAgentRuntime } from '../plugin-contract'
import { parseProviderPayload } from './plugin-provider-payload'
import type { AgentBridge, AgentUserRequest, AgentUserResponse, BridgeEvent, BridgeStartOpts, EmitFn, HandoffPromptOptions, PromptOptions, RequestUserFn, TurnUsage } from './bridge-types'
import { HTTP_ONLY_PROVIDERS, API_KEY_PROVIDERS } from './bridge-types'
import { autoCompactionSignalForProvider, detectAutoCompaction, normalizeContextUsage, compactionStrategy } from './compaction-meter'
import { TurnPermissionGrantStore } from './turn-permission-grants'
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
        if (event.type === 'turn_start') entry.running = true
        else if (event.type === 'turn_end' || event.type === 'closed' || event.type === 'error') entry.running = false
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
    // Mark running before the turn_start event arrives so a sweep mid-flight
    // never targets a bridge whose prompt is already in transit.
    entry.running = true
    entry.lastActivityAt = Date.now()

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
    entry.pendingPromptTexts.push(text)
    const result = await entry.bridge.prompt(wireText, options)
    if (!result.ok) {
      const idx = entry.pendingPromptTexts.indexOf(text)
      if (idx !== -1) entry.pendingPromptTexts.splice(idx, 1)
    }
    return result
  })

  ipcMain.handle('bridge:compact', async (_e, { bridgeId }: { bridgeId: string }) => {
    const entry = bridges.get(bridgeId)
    if (!entry) return { ok: false, error: 'bridge not found' }
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
    entry.running = true
    entry.lastActivityAt = Date.now()
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
    }
  })

  ipcMain.handle('bridge:removeFollowUp', async (_e, { bridgeId, followUpId }: { bridgeId: string; followUpId: string }) => {
    const entry = bridges.get(bridgeId)
    if (!entry) return { ok: false, error: 'bridge not found' }
    if (!entry.bridge.removeFollowUp) return { ok: false, error: `${entry.provider} queues follow-ups upstream; they cannot be removed` }
    return entry.bridge.removeFollowUp(followUpId)
  })

  ipcMain.on('bridge:setMode', (_e, { bridgeId, mode }: { bridgeId: string; mode: BridgeStartOpts['mode'] }) => {
    const entry = bridges.get(bridgeId)
    if (entry) entry.opts.mode = mode
  })

  ipcMain.on('bridge:abort', async (_e, bridgeId: string) => {
    turnPermissionGrants.clearBridge(bridgeId)
    const entry = bridges.get(bridgeId)
    if (entry) await entry.bridge.abort().catch(() => {})
  })

  ipcMain.on('bridge:stop', async (_e, bridgeId: string) => {
    turnPermissionGrants.clearBridge(bridgeId)
    const entry = bridges.get(bridgeId)
    if (!entry) return
    // Stop is the user's "make it stop no matter what" escape hatch, so we
    // try a polite abort first before tearing the bridge process down.
    await entry.bridge.abort().catch(() => {})
    await entry.bridge.stop().catch(() => {})
    bridges.delete(bridgeId)
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

import type { AgentBridge, BridgeStartOpts, EmitFn, ModeLevel } from './bridge-types'
import { buildUsage } from './model-context'
import { loadConversation, saveConversation, type StoredMessage } from './conversation-store'

// Ollama HTTP bridge — https://docs.ollama.com/api
//
// Unlike the other bridges, Ollama is a long-running local server (default
// http://127.0.0.1:11434) that's already up, so there's no child process to
// spawn. We just stream chat completions over HTTP:
//   POST /api/chat  { model, messages, stream:true }  → NDJSON
//     each line: { message:{ role, content, thinking? }, done:false }
//     final line: { done:true, prompt_eval_count, eval_count, ... }
//
// The chat API is stateless — every turn resends the full message array. The
// running history is persisted by conversation-store keyed on the (stable)
// synthetic session id, so an idle-stop or app restart resumes with full model
// context (the renderer's resume id round-trips the session id back to us). The
// system prompt is re-derived from the current mode each turn, never stored.

interface OllamaMessage {
  role:    'system' | 'user' | 'assistant'
  content: string
}

interface OllamaChatChunk {
  message?: { role?: string; content?: string; thinking?: string }
  done?:    boolean
  prompt_eval_count?: number
  eval_count?:        number
}

/** Default local server, overridable via OLLAMA_HOST (matches the CLI). */
function resolveBaseUrl(env?: Record<string, string>): string {
  const raw = env?.OLLAMA_HOST || process.env.OLLAMA_HOST || '127.0.0.1:11434'
  // OLLAMA_HOST is commonly a bare host:port; normalize to a full URL.
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, '')
  return `http://${raw.replace(/\/+$/, '')}`
}

// Mirrors the mode preamble used by the opencode bridge so Ask/Plan/Full Access behave
// consistently across providers. Ollama models have no native tool access here,
// so these only steer prose, but they keep the UX aligned.
function getModePreamble(mode?: ModeLevel): string | null {
  switch (mode) {
    case 'ask':  return 'You are in Ask mode. Answer questions concisely. Do not propose file edits or commands.'
    case 'plan': return 'You are in Plan mode. Produce a clear, structured implementation plan in Markdown with headings, bullets, and file paths in backticks. Do not write code.'
    case 'full': return 'You are in Full Access mode. Every tool is pre-approved. Move fast, minimize narration, and never ask for permission.'
    default:     return null
  }
}

export function createOllamaBridge(
  _ollamaPath: string,
  opts: BridgeStartOpts,
  emit: EmitFn,
): AgentBridge {
  const baseUrl = resolveBaseUrl(opts.env)

  // Reuse the prior session id if the renderer handed one back (idle-stop /
  // restart resume); otherwise mint a fresh one. History is loaded from
  // CrewCode's stable thread key so provider-id churn can't wipe context.
  const sessionId = opts.resumeSessionId || `ollama-${Date.now().toString(36)}`
  const resumed   = !!opts.resumeSessionId
  const historyKey = opts.conversationKey ?? sessionId
  const migratedHistory = opts.conversationKey && opts.resumeSessionId && loadConversation(historyKey).length === 0
    ? loadConversation(opts.resumeSessionId)
    : []
  const history: StoredMessage[] = migratedHistory.length > 0 ? migratedHistory : loadConversation(historyKey)

  let abortCtrl: AbortController | null = null
  let stopped = false

  queueMicrotask(() => {
    emit({ type: 'ready', bridgeId: opts.bridgeId })
    emit({ type: 'session_id', bridgeId: opts.bridgeId, sessionId, resumed })
  })

  return {
    bridgeId: opts.bridgeId,
    pid: null,
    async prompt(text: string) {
      if (stopped) return { ok: false, error: 'bridge stopped' }
      const model = (opts.model && opts.model.trim()) || ''
      if (!model) return { ok: false, error: 'no Ollama model selected — pick one from the model picker' }

      const turnId = `${opts.bridgeId}-t-${Date.now().toString(36)}`
      history.push({ role: 'user', content: text })
      emit({ type: 'turn_start', bridgeId: opts.bridgeId, turnId })

      // Re-derive the system prompt from the current mode each turn (never
      // stored) and prepend it to the persisted user/assistant history.
      const preamble = getModePreamble(opts.mode)
      const messages: OllamaMessage[] = [
        ...(preamble ? [{ role: 'system' as const, content: preamble }] : []),
        ...history,
      ]

      abortCtrl = new AbortController()
      let assistantText    = ''
      let usagePromptTokens: number | undefined
      let usageEvalTokens:   number | undefined

      try {
        const r = await fetch(`${baseUrl}/api/chat`, {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify({
            model,
            messages,
            stream: true,
            ...(opts.thinking ? { think: opts.thinking === 'off' ? false : opts.thinking } : {}),
          }),
          signal:  abortCtrl.signal,
        })
        if (!r.ok || !r.body) {
          const errBody = await r.text().catch(() => '')
          const detail  = errBody.slice(0, 300) || `HTTP ${r.status}`
          history.pop()  // drop the user msg so a retry doesn't duplicate it
          emit({ type: 'error', bridgeId: opts.bridgeId, message: `ollama /api/chat ${r.status}: ${detail}` })
          emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId })
          return { ok: false, error: detail }
        }

        const reader  = r.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          // Ollama streams newline-delimited JSON objects.
          let nl
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim()
            buf = buf.slice(nl + 1)
            if (!line) continue
            let chunk: OllamaChatChunk
            try { chunk = JSON.parse(line) as OllamaChatChunk } catch { continue }
            const thinking = chunk.message?.thinking
            if (typeof thinking === 'string' && thinking.length > 0) {
              // Shown live but not persisted — not needed to reconstruct context.
              emit({ type: 'thinking_delta', bridgeId: opts.bridgeId, turnId, delta: thinking })
            }
            const content = chunk.message?.content
            if (typeof content === 'string' && content.length > 0) {
              assistantText += content
              emit({ type: 'text_delta', bridgeId: opts.bridgeId, turnId, delta: content })
            }
            if (chunk.done) {
              if (typeof chunk.prompt_eval_count === 'number') usagePromptTokens = chunk.prompt_eval_count
              if (typeof chunk.eval_count        === 'number') usageEvalTokens   = chunk.eval_count
            }
          }
        }

        // Persist the assistant turn so a respawn carries full context.
        history.push({ role: 'assistant', content: assistantText })
        saveConversation(historyKey, history)
        const usage = buildUsage({ inputTokens: usagePromptTokens, outputTokens: usageEvalTokens, model })
        emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId, usage })
        return { ok: true }
      } catch (err) {
        // An abort is a user action, not an error — close the turn quietly,
        // persisting any partial answer so resume keeps it.
        if (abortCtrl?.signal.aborted) {
          if (assistantText) history.push({ role: 'assistant', content: assistantText })
          saveConversation(historyKey, history)
          emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId })
          return { ok: false, error: 'aborted' }
        }
        history.pop()  // network failure — drop the user msg so a retry is clean
        const message = (err as Error).message
        emit({ type: 'error', bridgeId: opts.bridgeId, message: `ollama: ${message}` })
        emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId })
        return { ok: false, error: message }
      } finally {
        abortCtrl = null
      }
    },
    async abort() {
      abortCtrl?.abort()
    },
    async stop() {
      stopped = true
      abortCtrl?.abort()
      emit({ type: 'closed', bridgeId: opts.bridgeId, code: 0 })
    },
  }
}

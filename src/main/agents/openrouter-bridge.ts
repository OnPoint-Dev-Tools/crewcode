import type { AgentBridge, BridgeStartOpts, EmitFn, ModeLevel } from './bridge-types'
import { buildUsage } from './model-context'
import { openRouterContextWindowFor } from './openrouter-model-context'
import { loadConversation, saveConversation, type StoredMessage } from './conversation-store'

// OpenRouter HTTP bridge — https://openrouter.ai/docs
//
// OpenRouter exposes an OpenAI-compatible chat API, so there's no process to
// spawn: we stream Server-Sent Events from
//   POST https://openrouter.ai/api/v1/chat/completions
//        Authorization: Bearer <key>   { model, messages, stream:true }
//   each event: data: { choices:[{ delta:{ content?, reasoning? } }] }
//   sentinel:   data: [DONE]
//
// Like the Ollama bridge it's stateless — every turn resends the full message
// array. The running history is persisted by conversation-store under the
// (stable) synthetic session id, so an idle-stop or app restart resumes with
// full model context. The system prompt is re-derived from mode each turn.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'

interface ChatMessage {
  role:    'system' | 'user' | 'assistant'
  content: string
}

interface SseDelta {
  choices?: Array<{ delta?: { content?: string; reasoning?: string } }>
  usage?:   { prompt_tokens?: number; completion_tokens?: number }
}

function getModePreamble(mode?: ModeLevel): string | null {
  switch (mode) {
    case 'ask':  return 'You are in Ask mode. Answer questions concisely. Do not propose file edits or commands.'
    case 'plan': return 'You are in Plan mode. Produce a clear, structured implementation plan in Markdown with headings, bullets, and file paths in backticks. Do not write code.'
    case 'full': return 'You are in Full Access mode. Every tool is pre-approved. Move fast, minimize narration, and never ask for permission.'
    default:     return null
  }
}

export function createOpenrouterBridge(
  _path: string,
  opts: BridgeStartOpts,
  emit: EmitFn,
): AgentBridge {
  const apiKey = opts.apiKey ?? ''

  // Reuse the prior session id on resume; load the persisted user/assistant
  // history from CrewCode's stable thread key so provider-id churn can't wipe context.
  const sessionId = opts.resumeSessionId || `openrouter-${Date.now().toString(36)}`
  const resumed   = !!opts.resumeSessionId
  const historyKey = opts.conversationKey ?? sessionId
  const migratedHistory = !opts.ephemeral && opts.conversationKey && opts.resumeSessionId && loadConversation(historyKey).length === 0
    ? loadConversation(opts.resumeSessionId)
    : []
  const history: StoredMessage[] = opts.ephemeral ? [] : migratedHistory.length > 0 ? migratedHistory : loadConversation(historyKey)

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
      if (!apiKey)        return { ok: false, error: 'OpenRouter API key not set — add it in Settings → Agents' }
      const model = (opts.model && opts.model.trim()) || ''
      if (!model)         return { ok: false, error: 'no OpenRouter model selected — pick one from the model picker' }

      const turnId = `${opts.bridgeId}-t-${Date.now().toString(36)}`
      history.push({ role: 'user', content: text })
      emit({ type: 'turn_start', bridgeId: opts.bridgeId, turnId })

      // Re-derive the system prompt from current mode (never stored) and prepend
      // it to the persisted history.
      const preamble = getModePreamble(opts.mode)
      const messages: ChatMessage[] = [
        ...(preamble ? [{ role: 'system' as const, content: preamble }] : []),
        ...history,
      ]

      abortCtrl = new AbortController()
      let assistantText = ''
      let usagePromptTokens: number | undefined
      let usageCompletionTokens: number | undefined

      try {
        const r = await fetch(OPENROUTER_URL, {
          method:  'POST',
          headers: {
            'content-type':  'application/json',
            'authorization': `Bearer ${apiKey}`,
            // OpenRouter uses these for its app-attribution leaderboard; harmless.
            'x-title':       'CrewCode',
          },
          body:   JSON.stringify({
            model,
            messages,
            stream: true,
            usage: { include: true },
            ...(opts.thinking ? { reasoning: { effort: opts.thinking === 'off' ? 'none' : opts.thinking } } : {}),
          }),
          signal: abortCtrl.signal,
        })
        if (!r.ok || !r.body) {
          const errBody = await r.text().catch(() => '')
          const detail  = errBody.slice(0, 400) || `HTTP ${r.status}`
          history.pop()  // drop the user msg so a retry doesn't duplicate it
          emit({ type: 'error', bridgeId: opts.bridgeId, message: `openrouter ${r.status}: ${detail}` })
          emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId })
          return { ok: false, error: detail }
        }

        const reader  = r.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        // SSE frames are separated by a blank line; each carries `data:` lines.
        let streamDone = false
        while (!streamDone) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let idx
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const dataLines = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim())
            if (dataLines.length === 0) continue
            const data = dataLines.join('\n')
            if (data === '[DONE]') { streamDone = true; break }
            let evt: SseDelta
            try { evt = JSON.parse(data) as SseDelta } catch { continue }
            const delta = evt.choices?.[0]?.delta
            if (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0) {
              emit({ type: 'thinking_delta', bridgeId: opts.bridgeId, turnId, delta: delta.reasoning })
            }
            if (typeof delta?.content === 'string' && delta.content.length > 0) {
              assistantText += delta.content
              emit({ type: 'text_delta', bridgeId: opts.bridgeId, turnId, delta: delta.content })
            }
            if (evt.usage) {
              if (typeof evt.usage.prompt_tokens     === 'number') usagePromptTokens     = evt.usage.prompt_tokens
              if (typeof evt.usage.completion_tokens === 'number') usageCompletionTokens = evt.usage.completion_tokens
            }
          }
        }

        if (!opts.ephemeral) {
          history.push({ role: 'assistant', content: assistantText })
          saveConversation(historyKey, history)
        }
        const contextWindow = await openRouterContextWindowFor(model)
        const usage = buildUsage({ inputTokens: usagePromptTokens, outputTokens: usageCompletionTokens, contextWindow, model })
        emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId, usage })
        return { ok: true }
      } catch (err) {
        if (abortCtrl?.signal.aborted) {
          if (!opts.ephemeral) {
            if (assistantText) history.push({ role: 'assistant', content: assistantText })
            saveConversation(historyKey, history)
          }
          emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId })
          return { ok: false, error: 'aborted' }
        }
        history.pop()  // network failure — drop the user msg so a retry is clean
        const message = (err as Error).message
        emit({ type: 'error', bridgeId: opts.bridgeId, message: `openrouter: ${message}` })
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

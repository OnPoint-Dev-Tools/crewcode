import type { AgentBridge, EmitFn } from './bridge-types'
import { stripReasoningBlocks } from './completion-text'

// Go is OpenCode's dedicated hosted API. It is distinct from the standard
// Zen endpoint and is authenticated by an sk_opencode_go bearer key.
const OPENCODE_GO_COMPLETIONS_URL = 'https://opencode.ai/zen/go/v1/chat/completions'
const OPENCODE_GO_MESSAGES_URL = 'https://opencode.ai/zen/go/v1/messages'
const DEFAULT_MODEL = 'minimax-m3'
const MAX_OUTPUT_TOKENS = 256

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textFromContent(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null
  const text = value
    .map(part => {
      const record = asRecord(part)
      return typeof record?.text === 'string' ? record.text : typeof record?.content === 'string' ? record.content : ''
    })
    .join('')
  return text || null
}

function extractCompletionText(payload: unknown): string | null {
  const root = asRecord(payload)
  if (!root) return null
  const choices = Array.isArray(root.choices) ? root.choices : []
  const firstChoice = asRecord(choices[0])
  const message = asRecord(firstChoice?.message)
  const text = textFromContent(message?.content)
    ?? textFromContent(firstChoice?.text)
    ?? textFromContent(asRecord(firstChoice?.delta)?.content)
    ?? textFromContent(root.output_text)
    // Anthropic-compatible Go models (such as MiniMax M3) return top-level
    // typed content blocks, where only text blocks are eligible ghost text.
    ?? textFromContent(root.content)
  return text ? stripReasoningBlocks(text) : null
}

function describePayloadShape(payload: unknown): string {
  const root = asRecord(payload)
  if (!root) return `response type ${Array.isArray(payload) ? 'array' : typeof payload}`
  const choices = Array.isArray(root.choices) ? root.choices : []
  const choice = asRecord(choices[0])
  const message = asRecord(choice?.message)
  const keys = (value: Record<string, unknown> | null) => value ? Object.keys(value).slice(0, 8).join(',') || 'none' : 'none'
  return `root keys [${keys(root)}]; choice keys [${keys(choice)}]; message keys [${keys(message)}]`
}

export function createOpenCodeGoCompletionBridge(
  opts: { bridgeId: string; apiKey: string; model?: string },
  emit: EmitFn,
): AgentBridge {
  let abortController: AbortController | null = null
  let stopped = false

  queueMicrotask(() => emit({ type: 'ready', bridgeId: opts.bridgeId }))

  return {
    bridgeId: opts.bridgeId,
    pid: null,
    async prompt(prompt: string) {
      if (stopped) return { ok: false, error: 'completion bridge stopped' }
      const turnId = `${opts.bridgeId}:turn`
      abortController = new AbortController()
      emit({ type: 'turn_start', bridgeId: opts.bridgeId, turnId })
      try {
        // The UI shows only completed ghost text, so a normal JSON response is
        // more compatible than parsing every provider's SSE framing variation.
        // A completion request must never silently fan out into additional paid calls.
        const model = opts.model || DEFAULT_MODEL
        const usesMessagesApi = model.startsWith('minimax-')
        const response = await fetch(usesMessagesApi ? OPENCODE_GO_MESSAGES_URL : OPENCODE_GO_COMPLETIONS_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.apiKey}`,
            ...(usesMessagesApi ? {
              'x-api-key': opts.apiKey,
              'anthropic-version': '2023-06-01',
            } : {}),
          },
          body: JSON.stringify(usesMessagesApi ? {
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            messages: [{ role: 'user', content: prompt }],
          } : {
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
            max_tokens: MAX_OUTPUT_TOKENS,
            temperature: 0.2,
          }),
          signal: abortController.signal,
        })
        if (!response.ok) {
          const detail = (await response.text().catch(() => '')).slice(0, 400) || `HTTP ${response.status}`
          emit({ type: 'error', bridgeId: opts.bridgeId, message: `OpenCode Go ${response.status}: ${detail}` })
          return { ok: false, error: detail }
        }

        const payload = await response.json() as unknown
        const content = extractCompletionText(payload)
        if (!content?.trim()) {
          const message = `OpenCode Go returned no final completion content (${describePayloadShape(payload)})`
          emit({ type: 'error', bridgeId: opts.bridgeId, message })
          return { ok: false, error: message }
        }
        emit({ type: 'text_delta', bridgeId: opts.bridgeId, turnId, delta: content })
        emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId })
        return { ok: true }
      } catch (error) {
        const message = abortController.signal.aborted ? 'aborted' : (error as Error).message
        if (!abortController.signal.aborted) emit({ type: 'error', bridgeId: opts.bridgeId, message: `OpenCode Go: ${message}` })
        emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId })
        return { ok: false, error: message }
      } finally {
        abortController = null
      }
    },
    async abort() { abortController?.abort() },
    async stop() {
      stopped = true
      abortController?.abort()
      emit({ type: 'closed', bridgeId: opts.bridgeId, code: 0 })
    },
  }
}

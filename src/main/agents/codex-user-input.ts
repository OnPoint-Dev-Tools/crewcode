import type { AgentUserRequest, AgentUserResponse } from './bridge-types'

/**
 * Codex app-server `item/tool/requestUserInput` (ToolRequestUserInputParams,
 * verified against codex-cli 0.157.1 `app-server generate-json-schema`).
 * Each question carries a stable `id`; the response maps id -> answers[].
 */
export const CODEX_REQUEST_USER_INPUT_METHODS: ReadonlySet<string> = new Set([
  'item/tool/requestUserInput',
  // Pre-v2 name CrewCode originally listened for; kept so older app-servers
  // still reach the card instead of the unknown-request fallback.
  'tool/requestUserInput',
])

export interface CodexUserInputOption {
  label: string
  description?: string
}

export interface CodexUserInputQuestion {
  id: string
  header: string
  question: string
  /** Codex's "Other" affordance: free-text answers are accepted. */
  isOther: boolean
  isSecret: boolean
  options: CodexUserInputOption[]
}

type CodexQuestionRequest = Omit<AgentUserRequest, 'requestId' | 'bridgeId'>

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseOptions(value: unknown): CodexUserInputOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const row = record(item)
    const label = text(row?.label)
    if (!label) return []
    const description = text(row?.description)
    return [{ label, ...(description ? { description } : {}) }]
  })
}

/** Parse the v2 `questions` array; falls back to the legacy single-prompt shape. */
export function parseCodexUserInputQuestions(params: Record<string, unknown>): CodexUserInputQuestion[] {
  if (Array.isArray(params.questions)) {
    return params.questions.flatMap((item, index) => {
      const row = record(item)
      const question = text(row?.question)
      if (!row || !question) return []
      return [{
        id: text(row.id) || `q${index + 1}`,
        header: text(row.header),
        question,
        isOther: row.isOther === true,
        isSecret: row.isSecret === true,
        options: parseOptions(row.options),
      }]
    })
  }
  const legacy = text(params.prompt) || text(params.message) || text(params.title)
  if (!legacy) return []
  return [{ id: 'input', header: text(params.title), question: legacy, isOther: true, isSecret: false, options: [] }]
}

function optionId(index: number): string {
  return `opt-${index}`
}

/** One overlay card per question: option buttons, plus free text when Codex allows it. */
export function codexQuestionRequest(question: CodexUserInputQuestion, index: number, total: number, turnId?: string): CodexQuestionRequest {
  const freeText = question.isOther || question.options.length === 0
  const message = [
    question.header ? `Codex asks: ${question.header}` : undefined,
    total > 1 ? `Question ${index + 1} of ${total}.` : undefined,
  ].filter(Boolean).join(' ')
  return {
    kind: freeText ? 'prompt' : 'select',
    turnId,
    title: question.question,
    message: message || undefined,
    options: question.options.length > 0
      ? question.options.map((option, i) => ({ id: optionId(i), label: option.label, description: option.description }))
      : undefined,
    placeholder: freeText ? 'reply to Codex…' : undefined,
    secret: question.isSecret || undefined,
    source: 'codex',
  }
}

/**
 * Map a card response to Codex answers. `null` means the human did not answer
 * (cancel/decline or an empty submission) — never send that as an answer.
 */
export function codexQuestionAnswer(question: CodexUserInputQuestion, response: AgentUserResponse): string[] | null {
  if (response.action !== 'submit' && response.action !== 'accept') return null
  if (response.optionId) {
    const match = /^opt-(\d+)$/.exec(response.optionId)
    const option = match ? question.options[Number(match[1])] : undefined
    if (option) return [option.label]
  }
  const typed = response.value?.trim() ?? ''
  if (!typed) return null
  // A typed answer is only valid where Codex offered free text.
  if (!question.isOther && question.options.length > 0) return null
  return [typed]
}

export type CodexAnswers = Record<string, { answers: string[] }>

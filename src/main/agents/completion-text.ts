// Ghost text is inserted into the user's buffer verbatim, so a completion must
// never carry model reasoning. Bridges route structured reasoning to
// `thinking_delta`, but many models serialize hidden thinking into the content
// stream as <think>/<thinking> blocks — those arrive as normal text deltas.

const REASONING_OPEN = /<(?:think|thinking|reasoning)\b[^>]*>/i
const REASONING_CLOSE = /<\/(?:think|thinking|reasoning)>/i
const REASONING_BLOCK = /<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*?<\/(?:think|thinking|reasoning)>\s*/gi
const FENCE = /^```(?:[\w+-]+)?\s*\n([\s\S]*?)\n?```$/

/**
 * Removes complete inline reasoning blocks. Returns null when the text opens a
 * reasoning block it never closes — that whole response is thinking, so there
 * is no completion to show.
 */
export function stripReasoningBlocks(text: string): string | null {
  if (REASONING_OPEN.test(text) && !REASONING_CLOSE.test(text)) return null
  const stripped = text.replace(REASONING_BLOCK, '').trim()
  return stripped || null
}

/**
 * Normalizes a provider's raw completion output into insertable ghost text:
 * reasoning stripped, one wrapping Markdown fence removed, CRLF normalized.
 * Returns '' when nothing insertable remains.
 */
export function completionText(text: string): string {
  const stripped = stripReasoningBlocks(text)
  if (!stripped) return ''
  const fenced = stripped.match(FENCE)
  return (fenced?.[1] ?? stripped).replace(/\r\n/g, '\n').trimEnd()
}

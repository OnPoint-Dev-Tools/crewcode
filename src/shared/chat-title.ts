const TITLE_STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'can', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'please', 'the', 'this', 'to', 'with'])

/** Same four-word chat title desktop uses from the first user prompt. */
export function titleFromFirstMessage(text: string): string {
  const words = text
    .replace(/`{1,3}[^`]*`{1,3}/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .map(w => w.trim().replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .filter(w => !TITLE_STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 4)

  return words.join(' ')
}

export interface DictationInsertion {
  value: string
  caret: number
}

export function insertDictationText(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  transcript: string,
): DictationInsertion {
  const text = transcript.trim()
  if (!text) return { value, caret: selectionStart }

  const start = Math.max(0, Math.min(selectionStart, value.length))
  const end = Math.max(start, Math.min(selectionEnd, value.length))
  const before = value.slice(0, start)
  const after = value.slice(end)
  const leading = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const trailing = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
  const inserted = `${leading}${text}${trailing}`

  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + leading.length + text.length,
  }
}

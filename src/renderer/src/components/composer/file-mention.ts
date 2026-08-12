export interface FileMentionState {
  start: number
  query: string
}

/** Find the @file token immediately before the caret. */
export function findFileMentionAt(value: string, caret: number): FileMentionState | null {
  let index = caret - 1
  while (index >= 0) {
    const char = value[index]
    if (char === '@') {
      const before = value[index - 1]
      if (index === 0 || /\s/.test(before) || before === '(' || before === ',') {
        return { start: index, query: value.slice(index + 1, caret) }
      }
      return null
    }
    if (/\s/.test(char)) return null
    index -= 1
  }
  return null
}

export function insertFileMention(
  value: string,
  mention: FileMentionState,
  caret: number,
  relativePath: string,
): { value: string; caret: number } {
  const token = `@${relativePath} `
  const before = value.slice(0, mention.start)
  const next = before + token + value.slice(caret)
  return { value: next, caret: before.length + token.length }
}

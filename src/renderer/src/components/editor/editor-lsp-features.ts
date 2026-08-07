export type LspPosition = { line: number; character: number }
export type LspRange = { start: LspPosition; end: LspPosition }

export type EditorProblem = {
  uri: string
  range: LspRange
  severity: 1 | 2 | 3 | 4
  message: string
  source?: string
  code?: string | number
}

export type LspTextEdit = { range: LspRange; newText: string }
export type EditorCodeAction = {
  title: string
  kind?: string
  disabled?: { reason: string }
  edit?: { changes?: Record<string, LspTextEdit[]> }
  command?: unknown
}

const MAX_DIAGNOSTICS_PER_DOCUMENT = 500

export function normalizeProblems(uri: string, diagnostics: unknown): EditorProblem[] {
  if (!Array.isArray(diagnostics)) return []
  const output: EditorProblem[] = []
  for (const value of diagnostics.slice(0, MAX_DIAGNOSTICS_PER_DOCUMENT)) {
    if (!value || typeof value !== 'object') continue
    const item = value as Record<string, unknown>
    const range = item.range as LspRange | undefined
    if (!range || !validPosition(range.start) || !validPosition(range.end) || typeof item.message !== 'string') continue
    const severity = item.severity === 2 || item.severity === 3 || item.severity === 4 ? item.severity : 1
    output.push({
      uri,
      range,
      severity,
      message: item.message.slice(0, 4_000),
      source: typeof item.source === 'string' ? item.source.slice(0, 100) : undefined,
      code: typeof item.code === 'string' || typeof item.code === 'number' ? item.code : undefined,
    })
  }
  return output
}

export function positionToOffset(text: string, position: LspPosition): number | null {
  if (!validPosition(position)) return null
  let offset = 0
  let line = 0
  while (line < position.line) {
    const newline = text.indexOf('\n', offset)
    if (newline < 0) return null
    offset = newline + 1
    line++
  }
  const lineEnd = text.indexOf('\n', offset)
  const end = lineEnd < 0 ? text.length : lineEnd
  return position.character <= end - offset ? offset + position.character : null
}

export function applyLspTextEdits(text: string, edits: readonly LspTextEdit[]): string | null {
  const mapped = edits.map(edit => {
    const from = positionToOffset(text, edit.range.start)
    const to = positionToOffset(text, edit.range.end)
    return from == null || to == null || from > to ? null : { from, to, insert: edit.newText }
  })
  if (mapped.some(edit => !edit)) return null
  const sorted = (mapped as Array<{ from: number; to: number; insert: string }>).sort((a, b) => b.from - a.from || b.to - a.to)
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index - 1].from < sorted[index].to) return null
  }
  let result = text
  for (const edit of sorted) result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to)
  return result
}

function validPosition(value: unknown): value is LspPosition {
  if (!value || typeof value !== 'object') return false
  const position = value as LspPosition
  return Number.isInteger(position.line) && position.line >= 0 && Number.isInteger(position.character) && position.character >= 0
}

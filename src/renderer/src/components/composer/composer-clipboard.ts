export interface ComposerSelectionEdit {
  value: string
  caret: number
}

function orderedSelection(value: string, start: number, end: number): [number, number] {
  const boundedStart = Math.max(0, Math.min(value.length, start))
  const boundedEnd = Math.max(0, Math.min(value.length, end))
  return boundedStart <= boundedEnd ? [boundedStart, boundedEnd] : [boundedEnd, boundedStart]
}

export function composerSelectedText(value: string, start: number, end: number): string {
  const [from, to] = orderedSelection(value, start, end)
  return value.slice(from, to)
}

export function replaceComposerSelection(value: string, start: number, end: number, insertion: string): ComposerSelectionEdit {
  const [from, to] = orderedSelection(value, start, end)
  return {
    value: `${value.slice(0, from)}${insertion}${value.slice(to)}`,
    caret: from + insertion.length,
  }
}

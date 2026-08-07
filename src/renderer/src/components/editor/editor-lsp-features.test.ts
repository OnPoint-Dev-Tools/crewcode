import { describe, expect, it } from 'vitest'
import { applyLspTextEdits, normalizeProblems, positionToOffset } from './editor-lsp-features'

describe('editor LSP features', () => {
  it('normalizes and bounds diagnostics', () => {
    const diagnostics = Array.from({ length: 510 }, (_, index) => ({
      range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
      severity: 2,
      message: `problem ${index}`,
    }))
    const problems = normalizeProblems('file:///workspace/a.ts', diagnostics)
    expect(problems).toHaveLength(500)
    expect(problems[0].severity).toBe(2)
  })

  it('rejects malformed diagnostic positions', () => {
    expect(normalizeProblems('file:///a.ts', [{
      range: { start: { line: -1, character: 0 }, end: { line: 0, character: 1 } },
      message: 'bad',
    }])).toEqual([])
  })

  it('maps LSP line and character positions', () => {
    expect(positionToOffset('one\ntwo\n', { line: 1, character: 2 })).toBe(6)
    expect(positionToOffset('one', { line: 2, character: 0 })).toBeNull()
  })

  it('applies multiple edits against the original document', () => {
    expect(applyLspTextEdits('const old = one\n', [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: 'fresh' },
      { range: { start: { line: 0, character: 12 }, end: { line: 0, character: 15 } }, newText: 'two' },
    ])).toBe('const fresh = two\n')
  })

  it('rejects overlapping and out-of-bounds edits', () => {
    expect(applyLspTextEdits('abc', [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: 'x' },
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, newText: 'y' },
    ])).toBeNull()
    expect(applyLspTextEdits('abc', [
      { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: 'x' },
    ])).toBeNull()
  })
})

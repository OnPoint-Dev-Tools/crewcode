import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { diskSyncDecision } from './editor-disk-sync'

const editor = readFileSync(fileURLToPath(new URL('./CodeEditor.tsx', import.meta.url)), 'utf8')

describe('editor disk synchronization', () => {
  it('reloads a clean buffer when an agent changed the file', () => {
    expect(diskSyncDecision({ text: 'before', originalText: 'before' }, 'after')).toBe('reload')
  })

  it('preserves a dirty buffer and reports a real disk conflict', () => {
    expect(diskSyncDecision({ text: 'local draft', originalText: 'before' }, 'agent edit')).toBe('conflict')
  })

  it('does not report a conflict when the disk still matches the dirty buffer baseline', () => {
    expect(diskSyncDecision({ text: 'local draft', originalText: 'before' }, 'before')).toBe('in-sync')
  })

  it('reconciles open files on mount and polls only the active file with single-flight reads', () => {
    expect(editor).toContain("for (const rel of watchKey.split('\\n')) void reconcileDiskFile(rel)")
    expect(editor).toContain('if (inFlight) return')
    expect(editor).toContain('window.setInterval(() => { void check() }, 1_500)')
  })
})

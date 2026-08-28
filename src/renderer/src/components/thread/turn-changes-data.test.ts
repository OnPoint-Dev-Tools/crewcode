import { describe, expect, it } from 'vitest'

import { collectTurnChangeEntries } from './turn-changes-data'
import type { Message, ToolCallMessage, TurnFileChange } from '../../types'

function tool(toolCallId: string, change: TurnFileChange): ToolCallMessage {
  return {
    kind: 'toolcall',
    time: '9:00 PM',
    turnId: 'turn-1',
    toolCallId,
    toolName: 'edit',
    args: { path: change.path },
    status: 'completed',
    fileChange: change,
    fileChanges: [change],
  }
}

describe('collectTurnChangeEntries', () => {
  it('keeps every file and merges repeated snapshot edits from first before to final after', () => {
    const messages: Message[] = [
      { kind: 'user', text: 'change both files', time: '8:59 PM' },
      tool('edit-1', {
        path: 'src/a.ts',
        beforeText: 'old\n',
        afterText: 'middle\n',
        patch: 'first patch',
      }),
      tool('edit-2', {
        path: 'src/a.ts',
        beforeText: 'middle\n',
        afterText: 'final\n',
        patch: 'second patch',
      }),
      tool('edit-3', {
        path: 'src/b.ts',
        beforeText: '',
        afterText: 'new\n',
        patch: 'third patch',
      }),
      { kind: 'agent', time: '9:01 PM', turnId: 'turn-1', blocks: [], text: 'done', streaming: false },
    ]

    const turns = collectTurnChangeEntries(messages)
    expect(turns).toHaveLength(1)
    expect(turns[0].userMsg).toBe('change both files')
    expect(turns[0].changes.map(change => change.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(turns[0].changes[0]).toMatchObject({ beforeText: 'old\n', afterText: 'final\n' })
    expect(turns[0].changes[0].patch).toMatch(/^-old$/m)
    expect(turns[0].changes[0].patch).toMatch(/^\+final$/m)
  })

  it('retains all provider-only patches for a repeatedly edited path', () => {
    const first = tool('provider-1', {
      path: 'src/a.ts',
      beforeText: '',
      afterText: '',
      patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b',
    })
    const second = tool('provider-2', {
      path: 'src/a.ts',
      beforeText: '',
      afterText: '',
      patch: 'diff --git a/src/a.ts b/src/a.ts\n@@ -3 +3 @@\n-c\n+d',
    })

    const turns = collectTurnChangeEntries([first, second])
    expect(turns[0].changes).toHaveLength(1)
    const patch = turns[0].changes[0].patch
    expect(patch).toContain('@@ -1 +1 @@')
    expect(patch).toContain('@@ -3 +3 @@')
    expect(patch.match(/^diff --git /gm)).toHaveLength(1)
    expect(patch).toMatch(/^--- a\/src\/a\.ts$/m)
    expect(patch).toMatch(/^\+\+\+ b\/src\/a\.ts$/m)
  })
})

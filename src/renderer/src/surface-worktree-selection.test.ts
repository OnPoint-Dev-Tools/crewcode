import { describe, expect, it } from 'vitest'

import { resolveSelectedWorktree, worktreeSelectionKey } from './surface-worktree-selection'
import type { Worktree } from './types'

const worktrees: Worktree[] = [
  { id: 'feature', path: '/repo-feature', branch: 'feature', head: 'abc', locked: false, dirty: 0 },
]

describe('surface worktree selection', () => {
  it('isolates each chat session even when sessions share a tab', () => {
    expect(worktreeSelectionKey('chat-tab', 'chat', 'thread-one')).toBe('chat:thread-one')
    expect(worktreeSelectionKey('chat-tab', 'chat', 'thread-two')).toBe('chat:thread-two')
  })

  it('isolates chat sessions mounted in separate Workbench panes', () => {
    expect(worktreeSelectionKey('canvas-pane-one', 'chat', 'canvas-pane-one')).toBe('chat:canvas-pane-one')
    expect(worktreeSelectionKey('canvas-pane-two', 'chat', 'canvas-pane-two')).toBe('chat:canvas-pane-two')
  })

  it('isolates Git Workspace tabs by tab instance', () => {
    expect(worktreeSelectionKey('workspace-git', 'git')).toBe('tab:workspace-git')
    expect(worktreeSelectionKey('another-git', 'git')).toBe('tab:another-git')
  })

  it('defaults new or stale selections to the primary checkout', () => {
    expect(resolveSelectedWorktree(undefined, worktrees)).toBeNull()
    expect(resolveSelectedWorktree('removed', worktrees)).toBeNull()
    expect(resolveSelectedWorktree('feature', worktrees)).toEqual(worktrees[0])
  })
})

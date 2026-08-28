import { describe, expect, it } from 'vitest'
import { deriveMissionStats } from './mission-stats'

describe('deriveMissionStats', () => {
  it('uses Mission Control status and project/worktree semantics', () => {
    const stats = deriveMissionStats([
      { status: 'running', projectId: 'one', worktree: 'main', tokens: 10 },
      { status: 'blocked', projectId: 'one', worktree: 'main', tokens: 20 },
      { status: 'done', projectId: 'one', worktree: 'feature', tokens: 30 },
      { status: 'idle', projectId: 'two', worktree: 'main', tokens: 40 },
    ])
    expect(stats).toEqual({ agents: 4, blocked: 1, running: 1, idle: 1, done: 1, worktrees: 3, tokens: 100 })
  })
})

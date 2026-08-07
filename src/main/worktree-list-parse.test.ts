import { describe, it, expect } from 'vitest'
import { parsePorcelainWorktrees } from './worktree-list-parse'

const MAIN = '/home/u/repo'

describe('parsePorcelainWorktrees', () => {
  it('skips the primary checkout and returns the extra worktrees', () => {
    const out = [
      `worktree ${MAIN}`,
      'HEAD abc1234567890',
      'branch refs/heads/main',
      '',
      `worktree ${MAIN}/.worktrees/repo-wt-crew-pi-1`,
      'HEAD def4567890123',
      'branch refs/heads/crew/abc/pi-1',
      '',
    ].join('\n')

    const wt = parsePorcelainWorktrees(out, MAIN)
    expect(wt).toHaveLength(1)
    expect(wt[0].branch).toBe('crew/abc/pi-1')       // refs/heads/ stripped
    expect(wt[0].head).toBe('def4567')               // shortened to 7
    expect(wt[0].id).toBe('repo-wt-crew-pi-1')       // basename of the path
    expect(wt[0].locked).toBe(false)
  })

  it('marks locked worktrees and excludes bare repos', () => {
    const out = [
      `worktree ${MAIN}`,
      'bare',
      '',
      `worktree ${MAIN}/.worktrees/locked-one`,
      'HEAD aaaaaaa1111111',
      'branch refs/heads/feature',
      'locked',
      '',
    ].join('\n')

    const wt = parsePorcelainWorktrees(out, MAIN)
    expect(wt).toHaveLength(1)                        // bare block dropped
    expect(wt[0].locked).toBe(true)
  })

  it('handles a detached HEAD worktree (no branch line)', () => {
    const out = [
      `worktree ${MAIN}`,
      'HEAD abc1234567890',
      'branch refs/heads/main',
      '',
      `worktree ${MAIN}/.worktrees/detached`,
      'HEAD ffffffff000000',
      'detached',
      '',
    ].join('\n')

    const wt = parsePorcelainWorktrees(out, MAIN)
    expect(wt).toHaveLength(1)
    expect(wt[0].branch).toBe('')
  })

  it('returns [] for empty output', () => {
    expect(parsePorcelainWorktrees('', MAIN)).toEqual([])
  })
})

import { describe, it, expect } from 'vitest'
import {
  parseStatus, parseLog, isSigningFailure, isMergeConflictOutput,
} from './git-porcelain-parse'

describe('parseStatus', () => {
  it('reads branch, ahead/behind, and splits staged/unstaged/untracked', () => {
    const raw = [
      '## main...origin/main [ahead 2, behind 1]',
      'M  staged.ts',          // staged modify
      ' M unstaged.ts',        // unstaged modify
      'MM both.ts',            // staged + unstaged
      '?? new.ts',             // untracked
    ].join('\n')

    const s = parseStatus(raw)
    expect(s.branch).toBe('main')
    expect(s.ahead).toBe(2)
    expect(s.behind).toBe(1)
    expect(s.hasUpstream).toBe(true)
    expect(s.staged.map(f => f.path)).toEqual(['staged.ts', 'both.ts'])
    expect(s.unstaged.map(f => f.path)).toEqual(['unstaged.ts', 'both.ts'])
    expect(s.untracked.map(f => f.path)).toEqual(['new.ts'])
  })

  it('reports when a local branch has no upstream', () => {
    expect(parseStatus('## main').hasUpstream).toBe(false)
  })

  it('keeps the destination path of a tab-delimited rename', () => {
    // porcelain renders a rename as "R  old\tnew"; parseStatus keeps the dest.
    const s = parseStatus('## main\nR  old.ts\tnew.ts')
    expect(s.staged[0].path).toBe('new.ts')
  })

  it('flags conflicts via the U status code', () => {
    const s = parseStatus('## main\nUU conflicted.ts')
    expect(s.staged.some(f => f.status === 'U')).toBe(true)
    expect(s.unstaged.some(f => f.status === 'U')).toBe(true)
  })

  it('defaults branch to HEAD on detached output', () => {
    expect(parseStatus('').branch).toBe('HEAD')
  })
})

describe('parseLog', () => {
  it('parses \\x1f-delimited commits and shortens the hash', () => {
    const raw = [
      'abcdef1234567890\x1fAda\x1f2 hours ago\x1ffeat: add lanes',
      'fedcba0987654321\x1fGrace\x1f1 day ago\x1ffix: merge guard',
    ].join('\n')
    const log = parseLog(raw)
    expect(log).toHaveLength(2)
    expect(log[0].shortHash).toBe('abcdef1')
    expect(log[0].author).toBe('Ada')
    expect(log[0].message).toBe('feat: add lanes')
  })

  it('returns [] for empty input', () => {
    expect(parseLog('')).toEqual([])
  })
})

describe('isSigningFailure', () => {
  it('detects ssh/gpg signing failures the GUI can\'t satisfy', () => {
    expect(isSigningFailure('error: ssh_askpass: exec failed')).toBe(true)
    expect(isSigningFailure('gpg failed to sign the data')).toBe(true)
    expect(isSigningFailure('fatal: failed to write commit object')).toBe(true)
  })

  it('does not flag unrelated errors', () => {
    expect(isSigningFailure('nothing to commit, working tree clean')).toBe(false)
  })
})

describe('isMergeConflictOutput', () => {
  it('recognizes conflict output as in-progress, not failure', () => {
    expect(isMergeConflictOutput('CONFLICT (content): Merge conflict in app.txt')).toBe(true)
    expect(isMergeConflictOutput('Already up to date.')).toBe(false)
  })
})

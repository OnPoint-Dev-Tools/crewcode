import { describe, it, expect } from 'vitest'
import {
  branchSuffix,
  delegatedBranchName,
  isDelegatedBranch,
  slugForBranch,
  DELEGATED_BRANCH_PREFIX,
} from './delegated-worktree-naming'

describe('slugForBranch', () => {
  it('lowercases and hyphenates', () => {
    expect(slugForBranch('Regression Sweep')).toBe('regression-sweep')
  })

  // git ref rules forbid these outright; `worktree add` would fail with a message
  // the agent can't act on.
  it('strips characters git refuses in a ref name', () => {
    expect(slugForBranch('fix: auth~bug^2 [urgent]?')).toBe('fix-auth-bug-2-urgent')
    expect(slugForBranch('a\\b*c')).toBe('a-b-c')
    expect(slugForBranch('..dots..')).toBe('dots')
    expect(slugForBranch('@{weird}')).toBe('weird')
  })

  it('never emits leading or trailing hyphens', () => {
    expect(slugForBranch('  spaced  ')).toBe('spaced')
    expect(slugForBranch('---')).toBe('thread')
  })

  it('falls back rather than producing an empty ref', () => {
    expect(slugForBranch('')).toBe('thread')
    expect(slugForBranch('日本語')).toBe('thread')
  })

  it('truncates without leaving a trailing hyphen', () => {
    const result = slugForBranch('a'.repeat(20) + ' ' + 'b'.repeat(20), 21)
    expect(result.length).toBeLessThanOrEqual(21)
    expect(result.endsWith('-')).toBe(false)
  })
})

describe('delegatedBranchName', () => {
  it('namespaces every delegated branch', () => {
    const branch = delegatedBranchName('regression sweep', 'abc123')
    expect(branch).toBe(`${DELEGATED_BRANCH_PREFIX}/regression-sweep-abc123`)
    expect(isDelegatedBranch(branch)).toBe(true)
  })

  it('does not claim unrelated branches', () => {
    expect(isDelegatedBranch('main')).toBe(false)
    expect(isDelegatedBranch('crewcode/delegated-ish')).toBe(false)
  })
})

describe('branchSuffix', () => {
  // Two threads sharing a branch makes the second `worktree add` fail, or worse
  // checks the first one's branch out twice.
  it('does not repeat across rapid successive calls', () => {
    const suffixes = new Set(Array.from({ length: 200 }, () => branchSuffix()))
    expect(suffixes.size).toBe(200)
  })

  it('produces a ref-safe fragment', () => {
    expect(branchSuffix()).toMatch(/^[a-z0-9]+$/)
  })
})

import { describe, expect, it } from 'vitest'
import { splitPullRequestPatch } from './pull-request-diff'

describe('pull request patch splitting', () => {
  it('returns one Pierre-compatible patch per changed file', () => {
    const raw = [
      'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new',
      'diff --git a/src/b.ts b/src/b.ts', '--- a/src/b.ts', '+++ b/src/b.ts', '@@ -0,0 +1 @@', '+next', '',
    ].join('\n')
    expect(splitPullRequestPatch(raw)).toEqual([
      { path: 'src/a.ts', patch: expect.stringContaining('diff --git a/src/a.ts b/src/a.ts') },
      { path: 'src/b.ts', patch: expect.stringContaining('diff --git a/src/b.ts b/src/b.ts') },
    ])
  })
})

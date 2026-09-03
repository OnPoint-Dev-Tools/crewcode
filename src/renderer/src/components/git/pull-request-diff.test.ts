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

  it('removes the next commit mail envelope from a selected file patch', () => {
    const raw = [
      'diff --git a/.gitignore b/.gitignore', 'index 111..222 100644', '--- a/.gitignore', '+++ b/.gitignore',
      '@@ -1 +1,2 @@', ' node_modules/', '+.crewcode/', '',
      'From 2f33c30d6705f122c0a86d297fb38348150f848e Mon Sep 17 00:00:00 2001',
      'From: CrewCoder <agent@example.com>', 'Subject: [PATCH 2/2] next file', '', '---', ' src/app.ts | 1 +', '',
      'diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts', '@@ -1 +1 @@', '-old', '+new',
    ].join('\n')
    const files = splitPullRequestPatch(raw)
    expect(files[0]).toEqual({ path: '.gitignore', patch: expect.stringContaining('+.crewcode/') })
    expect(files[0].patch).not.toContain('Subject: [PATCH 2/2]')
    expect(files[0].patch.match(/^diff --git /gm)).toHaveLength(1)
  })

  it('folds repeated file entries under one canonical diff header', () => {
    const raw = [
      'diff --git a/.gitignore b/.gitignore', '--- a/.gitignore', '+++ b/.gitignore', '@@ -1 +1 @@', '-old', '+middle',
      'diff --git a/.gitignore b/.gitignore', '--- a/.gitignore', '+++ b/.gitignore', '@@ -1 +1 @@', '-middle', '+new',
    ].join('\n')
    const files = splitPullRequestPatch(raw)
    expect(files).toHaveLength(1)
    expect(files[0].patch.match(/^diff --git /gm)).toHaveLength(1)
    expect(files[0].patch).toContain('+middle')
    expect(files[0].patch).toContain('+new')
  })
})

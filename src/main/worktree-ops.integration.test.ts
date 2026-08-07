import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { addWorktree, removeWorktree } from './worktree-ops'

/**
 * Real-git integration: drives the actual create/remove code and the merge
 * command the IPC layer runs, in a throwaway repo. Locks in the worktree →
 * branch → merge-back contract crew sessions depend on. Commit signing is
 * disabled locally so these pass regardless of the developer's global git config
 * (an ssh/gpg signing key that can't prompt for a passphrase here).
 */

let repo: string

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function commit(cwd: string, msg: string): void {
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '--no-gpg-sign', '-m', msg)
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'crewcode-wt-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@crewcode.cortex-ai.icu')
  git(repo, 'config', 'user.name', 'CrewCode Test')
  git(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'app.txt'), 'line1\n')
  commit(repo, 'init')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('addWorktree — isolated lane provisioning', () => {
  it('forks a fresh branch off the given start point', () => {
    const r = addWorktree(repo, 'crew/abc/pi-1', { startPoint: 'main' })
    expect('ok' in r && r.ok).toBe(true)
    if (!('ok' in r)) return
    expect(existsSync(r.path)).toBe(true)
    // The worktree's HEAD is the new lane branch, forked from main's commit.
    expect(git(r.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('crew/abc/pi-1')
    expect(git(r.path, 'rev-parse', 'HEAD')).toBe(git(repo, 'rev-parse', 'main'))
  })

  it('adds .worktrees/ to .gitignore so lane dirs stay untracked', () => {
    addWorktree(repo, 'crew/abc/pi-1', { startPoint: 'main' })
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toMatch(/^\.worktrees\/$/m)
    // The repo root must not see the worktree dir as an untracked change.
    expect(git(repo, 'status', '--porcelain')).not.toMatch(/\.worktrees/)
  })

  it('refuses to create a worktree in a repo with no commits', () => {
    const empty = mkdtempSync(join(tmpdir(), 'crewcode-empty-'))
    git(empty, 'init', '-q', '-b', 'main')
    try {
      const r = addWorktree(empty, 'feature', {})
      expect('error' in r && /no commits yet/.test(r.error)).toBe(true)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('checks out an existing branch when -b would collide', () => {
    git(repo, 'branch', 'existing')
    const r = addWorktree(repo, 'existing', { startPoint: 'main' })
    expect('ok' in r && r.ok).toBe(true)
    if ('ok' in r) expect(git(r.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('existing')
  })
})

describe('lane → base merge-back', () => {
  it('merges a lane branch cleanly into the base branch', () => {
    const r = addWorktree(repo, 'crew/abc/pi-1', { startPoint: 'main' })
    if (!('ok' in r)) throw new Error('provision failed')
    writeFileSync(join(r.path, 'app.txt'), 'line1\npi-change\n')
    commit(r.path, 'pi: append')

    // The merge the IPC handler runs, from the base checkout.
    git(repo, 'merge', '--no-edit', 'crew/abc/pi-1')
    expect(readFileSync(join(repo, 'app.txt'), 'utf8')).toContain('pi-change')
  })

  it('surfaces a conflict (exit non-zero, "CONFLICT" output) and aborts cleanly', () => {
    const a = addWorktree(repo, 'crew/abc/pi-1', { startPoint: 'main' })
    const b = addWorktree(repo, 'crew/abc/codex-2', { startPoint: 'main' })
    if (!('ok' in a) || !('ok' in b)) throw new Error('provision failed')

    // Both lanes rewrite the same line, then base diverges on that line too.
    writeFileSync(join(a.path, 'app.txt'), 'line1-pi\n');    commit(a.path, 'pi: line1')
    writeFileSync(join(b.path, 'app.txt'), 'line1-codex\n'); commit(b.path, 'codex: line1')
    git(repo, 'merge', '--no-edit', 'crew/abc/pi-1')          // first merge: clean

    let conflicted = false
    let output = ''
    try {
      git(repo, 'merge', '--no-edit', 'crew/abc/codex-2')     // second: conflicts
    } catch (e) {
      conflicted = true
      const err = e as { stdout?: Buffer | string; stderr?: Buffer | string }
      output = String(err.stdout ?? '') + String(err.stderr ?? '')
    }
    expect(conflicted).toBe(true)
    expect(/conflict/i.test(output)).toBe(true)
    expect(git(repo, 'status', '--porcelain')).toMatch(/^UU /m)

    git(repo, 'merge', '--abort')
    // Abort clears the conflict; the only remaining entry is the untracked
    // .gitignore addWorktree created (never committed in this fixture).
    expect(git(repo, 'status', '--porcelain')).not.toMatch(/^UU /m)
  })
})

describe('removeWorktree', () => {
  it('removes a worktree from the repo registration', () => {
    const r = addWorktree(repo, 'crew/abc/pi-1', { startPoint: 'main' })
    if (!('ok' in r)) throw new Error('provision failed')
    expect(git(repo, 'worktree', 'list')).toContain(r.path)

    const rm = removeWorktree(r.path)
    expect('ok' in rm && rm.ok).toBe(true)
    expect(git(repo, 'worktree', 'list')).not.toContain(r.path)
  })
})

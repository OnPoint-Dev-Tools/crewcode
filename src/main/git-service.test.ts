import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { GitService } from './git-service'

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'crewcode-git-service-'))
  execFileSync('git', ['init'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'crewcode@example.test'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'CrewCode Test'], { cwd: root })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root })
  writeFileSync(join(root, 'README.md'), 'first\n')
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root })
  return root
}

describe('GitService', () => {
  it('reads status, diffs, branches, history, and remotes', async () => {
    const root = repo()
    const service = new GitService()
    writeFileSync(join(root, 'README.md'), 'changed\n')
    expect(await service.status(root)).toMatchObject({ ok: true, unstaged: [{ path: 'README.md' }] })
    expect(await service.diff(root, 'README.md', false)).toMatchObject({ ok: true })
    expect((await service.diff(root, 'README.md', false)).diff).toContain('+changed')
    expect(await service.branches(root)).toMatchObject({ ok: true })
    expect(await service.log(root, 20)).toMatchObject({ ok: true, commits: [{ message: 'initial' }] })
    expect(await service.remotes(root)).toMatchObject({ ok: true, isRepo: true, remotes: [] })
  })

  it('lists committed and working changes against a validated comparison branch', async () => {
    const root = repo()
    const service = new GitService()
    execFileSync('git', ['branch', 'base'], { cwd: root })
    writeFileSync(join(root, 'README.md'), 'committed\n')
    execFileSync('git', ['add', 'README.md'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'branch change'], { cwd: root })
    writeFileSync(join(root, 'extra.txt'), 'untracked\n')

    const changes = await service.changesVsRef(root, 'base')
    expect(changes).toMatchObject({ ok: true })
    expect(changes.files?.map(file => file.path)).toEqual(['README.md', 'extra.txt'])
    expect((await service.diffVsRef(root, 'base', 'README.md')).diff).toContain('+committed')
    expect(await service.changesVsRef(root, '--output=bad')).toEqual({ error: 'invalid comparison branch' })
    expect(await service.diffVsRef(root, '../bad', 'README.md')).toEqual({ error: 'invalid comparison branch' })
  })

  it('stages, unstages, commits, and validates branch names', async () => {
    const root = repo()
    const service = new GitService()
    writeFileSync(join(root, 'next.txt'), 'next')
    expect(await service.stage(root, ['next.txt'])).toEqual({ ok: true })
    expect(await service.unstage(root, ['next.txt'])).toEqual({ ok: true })
    await service.stageAll(root)
    expect(await service.commit(root, 'next commit', false, true)).toMatchObject({ ok: true })
    expect(await service.checkout(root, '--upload-pack=bad', true)).toEqual({ error: 'invalid branch name' })
    expect(await service.checkout(root, 'feature/web', true)).toEqual({ ok: true })
  })

  it('keeps merge-in-progress visible after the final conflict is staged', async () => {
    const root = repo()
    const service = new GitService()
    const original = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()
    execFileSync('git', ['checkout', '-b', 'base'], { cwd: root })
    writeFileSync(join(root, 'README.md'), 'base change\n')
    execFileSync('git', ['commit', '-am', 'base change'], { cwd: root })
    execFileSync('git', ['checkout', original], { cwd: root })
    writeFileSync(join(root, 'README.md'), 'head change\n')
    execFileSync('git', ['commit', '-am', 'head change'], { cwd: root })
    try { execFileSync('git', ['merge', 'base'], { cwd: root, stdio: 'pipe' }) } catch { /* expected conflict */ }

    expect(await service.status(root)).toMatchObject({ ok: true, mergeInProgress: true })
    const evidence = await service.conflictDiff(root, 'README.md')
    expect(evidence).toMatchObject({ ok: true, oursAvailable: true, theirsAvailable: true })
    expect(evidence.patch).toContain('diff --git a/README.md b/README.md')
    expect(evidence.patch).toContain('ours (PR head)')
    expect(evidence.patch).toContain('theirs (base)')
    expect((evidence.patch.match(/^diff --git /gm) ?? [])).toHaveLength(1)
    expect(await service.resolveConflict(root, 'README.md', 'ours')).toEqual({ ok: true })
    expect(await service.conflictDiff(root, 'README.md')).toMatchObject({ ok: false, error: expect.stringContaining('no longer an unresolved') })
    expect(await service.status(root)).toMatchObject({ ok: true, mergeInProgress: true, unstaged: [] })
    expect(await service.mergeContinue(root)).toMatchObject({ ok: true })
    expect(await service.status(root)).toMatchObject({ ok: true, mergeInProgress: false })
  })
})

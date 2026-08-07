import { describe, it, expect, vi } from 'vitest'
import { mergeDelegatedBranch, type GitRunResult } from './delegated-merge'

const request = {
  worktreePath: '/repo/.worktrees/child',
  repoPath: '/repo',
  branch: 'crewcode/delegated/sweep-abc',
  base: 'main',
}

const okResult = (stdout = ''): GitRunResult => ({ code: 0, stdout, stderr: '' })
const failResult = (stderr: string, stdout = ''): GitRunResult => ({ code: 1, stdout, stderr })

/** Builds a runner from a map of "first two args" -> queued results. */
function runner(responses: Record<string, GitRunResult | GitRunResult[]>) {
  const calls: { cwd: string; args: string[] }[] = []
  const queues = new Map<string, GitRunResult[]>(
    Object.entries(responses).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]),
  )
  const run = vi.fn(async (cwd: string, args: string[]) => {
    calls.push({ cwd, args })
    const key = args.slice(0, 2).join(' ')
    const queue = queues.get(key) ?? queues.get(args[0]) ?? []
    return queue.length > 1 ? queue.shift()! : (queue[0] ?? okResult())
  })
  return { run, calls }
}

describe('mergeDelegatedBranch', () => {
  it('rebases in the child worktree and fast-forwards the repo', async () => {
    const { run, calls } = runner({
      'status --porcelain': okResult(''),
      'rev-list --count': okResult('3\n'),
      'rebase main': okResult(),
      'merge --ff-only': okResult(),
    })
    const result = await mergeDelegatedBranch(request, run)

    expect(result).toMatchObject({ ok: true, status: 'merged', commits: 3 })
    // The rebase must run in the CHILD's worktree; the user's checkout is never
    // left mid-rebase by a background thread.
    expect(calls.find(c => c.args[0] === 'rebase')?.cwd).toBe(request.worktreePath)
    expect(calls.find(c => c.args[0] === 'merge')?.cwd).toBe(request.repoPath)
  })

  // Git only checks text. Two agents adding the same symbol in different regions
  // merges clean and breaks the build.
  it('says a clean merge is still unverified', async () => {
    const { run } = runner({
      'status --porcelain': okResult(''),
      'rev-list --count': okResult('1'),
      'rebase main': okResult(),
      'merge --ff-only': okResult(),
    })
    const result = await mergeDelegatedBranch(request, run)
    expect((result as { note: string }).note).toContain('not verified')
  })

  it('reports conflicts with their paths and writes nothing to the base', async () => {
    const { run, calls } = runner({
      'status --porcelain': okResult(''),
      'rev-list --count': okResult('2'),
      'rebase main': failResult('CONFLICT (content): Merge conflict in src/a.ts'),
      'diff --name-only': okResult('src/a.ts\nsrc/b.ts\n'),
    })
    const result = await mergeDelegatedBranch(request, run)

    expect(result).toMatchObject({ ok: false, status: 'conflict', conflicts: ['src/a.ts', 'src/b.ts'] })
    expect(calls.some(c => c.args[0] === 'merge')).toBe(false)
    // Left paused for the child's agent to resolve — not aborted.
    expect(calls.some(c => c.args.includes('--abort'))).toBe(false)
  })

  it('aborts a rebase that failed for a non-conflict reason', async () => {
    const { run, calls } = runner({
      'status --porcelain': okResult(''),
      'rev-list --count': okResult('1'),
      'rebase main': failResult('fatal: invalid upstream'),
      'diff --name-only': okResult(''),
    })
    const result = await mergeDelegatedBranch(request, run)

    expect(result).toMatchObject({ ok: false, status: 'error' })
    expect(calls.some(c => c.args.join(' ') === 'rebase --abort')).toBe(true)
  })

  // The child's agent isn't finished; rebasing over uncommitted work loses it.
  it('refuses when the child worktree is dirty', async () => {
    const { run, calls } = runner({
      'status --porcelain': okResult(' M src/a.ts\n?? src/new.ts\n'),
    })
    const result = await mergeDelegatedBranch(request, run)

    expect(result).toMatchObject({ ok: false, status: 'dirty', files: ['src/a.ts', 'src/new.ts'] })
    expect(calls.some(c => c.args[0] === 'rebase')).toBe(false)
  })

  it('reports nothing to merge when the branch has no commits of its own', async () => {
    const { run, calls } = runner({
      'status --porcelain': okResult(''),
      'rev-list --count': okResult('0\n'),
    })
    const result = await mergeDelegatedBranch(request, run)

    expect(result).toEqual({ ok: true, status: 'nothing-to-merge' })
    expect(calls.some(c => c.args[0] === 'rebase')).toBe(false)
  })

  it('fails rather than writing a merge commit when the base moved again', async () => {
    const { run } = runner({
      'status --porcelain': okResult(''),
      'rev-list --count': okResult('1'),
      'rebase main': okResult(),
      'merge --ff-only': failResult('fatal: Not possible to fast-forward'),
    })
    const result = await mergeDelegatedBranch(request, run)
    expect(result).toMatchObject({ ok: false, status: 'error' })
  })

  it('surfaces a status failure instead of proceeding blind', async () => {
    const { run, calls } = runner({ 'status --porcelain': failResult('not a git repository') })
    const result = await mergeDelegatedBranch(request, run)

    expect(result).toMatchObject({ ok: false, status: 'error', error: 'not a git repository' })
    expect(calls).toHaveLength(1)
  })
})

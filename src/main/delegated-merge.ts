// Merging a delegated thread's branch back onto the branch it forked from.
//
// The sequence is rebase-then-fast-forward, run **inside the child's worktree**,
// because that is where the agent that wrote the change is still sitting with the
// context for why it made it. The user's primary worktree is never left mid-merge
// by a background thread.
//
// Command execution is injected so the whole decision tree is testable without a
// real repository; `git.ts` supplies the real runner.

export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs one git invocation in a given directory. */
export type GitRunner = (cwd: string, args: string[]) => Promise<GitRunResult>

export interface DelegatedMergeRequest {
  /** The child's isolated worktree — where the rebase happens. */
  worktreePath: string
  /** The repository's primary checkout, where the fast-forward lands. */
  repoPath: string
  /** The child's branch. */
  branch: string
  /** The ref it forked from and merges back onto. */
  base: string
}

export type DelegatedMergeResult =
  | { ok: true; status: 'merged'; commits: number; note: string }
  | { ok: true; status: 'nothing-to-merge' }
  | { ok: false; status: 'conflict'; conflicts: string[]; note: string }
  | { ok: false; status: 'dirty'; files: string[] }
  | { ok: false; status: 'error'; error: string }

/** Files with unresolved conflict markers, from `diff --name-only --diff-filter=U`. */
function parseConflictPaths(stdout: string): string[] {
  return stdout.split('\n').map(line => line.trim()).filter(Boolean)
}

/**
 * Porcelain status lines -> paths. Any entry means the worktree is dirty.
 *
 * The format is `XY<space>path`, where X or Y may be a space (` M file`). The
 * line must NOT be trimmed before slicing off those three columns — trimming
 * first shifts the offset and eats the first characters of the path.
 */
function parseDirtyPaths(stdout: string): string[] {
  return stdout.split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => {
      const path = line.slice(3).trim()
      // Renames are reported as `old -> new`; the destination is the live file.
      const arrow = path.lastIndexOf(' -> ')
      return arrow === -1 ? path : path.slice(arrow + 4)
    })
    .filter(Boolean)
}

/**
 * Merge a delegated branch back onto its base.
 *
 * 1. Refuse if the child's worktree has uncommitted work — its agent isn't done,
 *    and rebasing over a dirty tree loses it.
 * 2. Rebase the child onto the current base tip, **in the child's worktree**.
 *    Conflicts stop here, leaving the rebase in progress there for its agent to
 *    resolve. Nothing has touched the user's checkout at this point.
 * 3. Fast-forward the base onto the rebased branch. `--ff-only` is deliberate:
 *    after a clean rebase this always succeeds, and if it somehow can't, that
 *    means the base moved again — better to fail than to write a merge commit
 *    into the user's branch unattended.
 */
export async function mergeDelegatedBranch(
  request: DelegatedMergeRequest,
  run: GitRunner,
): Promise<DelegatedMergeResult> {
  const { worktreePath, repoPath, branch, base } = request

  const dirty = await run(worktreePath, ['status', '--porcelain'])
  if (dirty.code !== 0) return { ok: false, status: 'error', error: dirty.stderr.trim() || 'could not read worktree status' }
  const dirtyPaths = parseDirtyPaths(dirty.stdout)
  if (dirtyPaths.length > 0) return { ok: false, status: 'dirty', files: dirtyPaths }

  const ahead = await run(worktreePath, ['rev-list', '--count', `${base}..${branch}`])
  if (ahead.code !== 0) return { ok: false, status: 'error', error: ahead.stderr.trim() || 'could not compare against the base branch' }
  const commits = Number.parseInt(ahead.stdout.trim(), 10)
  if (!Number.isFinite(commits) || commits <= 0) return { ok: true, status: 'nothing-to-merge' }

  const rebase = await run(worktreePath, ['rebase', base])
  if (rebase.code !== 0) {
    const conflicted = await run(worktreePath, ['diff', '--name-only', '--diff-filter=U'])
    const conflicts = parseConflictPaths(conflicted.stdout)
    if (conflicts.length > 0) {
      return {
        ok: false,
        status: 'conflict',
        conflicts,
        note: 'The rebase is paused in the delegated thread\'s own worktree. Nothing was written to your branch. Ask that thread to resolve the conflicts, then merge again.',
      }
    }
    // Non-conflict rebase failure: leave nothing half-applied.
    await run(worktreePath, ['rebase', '--abort'])
    return { ok: false, status: 'error', error: rebase.stderr.trim() || 'rebase failed' }
  }

  const merge = await run(repoPath, ['merge', '--ff-only', branch])
  if (merge.code !== 0) {
    return {
      ok: false,
      status: 'error',
      error: merge.stderr.trim() || `could not fast-forward ${base} onto ${branch}; the base branch moved again — merge once more`,
    }
  }

  return {
    ok: true,
    status: 'merged',
    commits,
    // A clean merge is not a correct merge: git resolves at hunk granularity and
    // knows nothing about two agents adding the same symbol in different regions.
    note: 'Merged, not verified. Git only checks for textual conflicts — run the typecheck/test suite before trusting this.',
  }
}

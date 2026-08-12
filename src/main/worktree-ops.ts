import { basename, isAbsolute, resolve } from 'path'
import { spawnSync } from 'child_process'
import { existsSync, readFileSync, appendFileSync, unlinkSync } from 'fs'
import os from 'os'

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace('~', os.homedir()) : p
}

export type WorktreeOpResult = { ok: true; path: string } | { error: string }

/**
 * Create a git worktree for a lane, forking a fresh branch. Extracted from the
 * `worktree:create` IPC handler so the real command sequence is unit-testable
 * against a temp repo without Electron. Mirrors the handler exactly:
 *
 *   - A repo with no commits has no HEAD to branch from → fail with a clear reason.
 *   - `worktree add <target> -b <branch> [startPoint]` forks the branch; crew
 *     sessions pass their base branch as `startPoint` so every isolated lane
 *     forks from the same base rather than from whatever HEAD happens to be.
 *   - Exit 128 means the branch already exists → re-add without `-b`.
 *   - Exclude `.worktrees/` through Git's private info/exclude file so creating
 *     a lane never dirties the user's project checkout.
 */
export function addWorktree(
  repoPath: string,
  branch: string,
  opts?: { worktreePath?: string; startPoint?: string },
): WorktreeOpResult {
  const cwd = expandHome(repoPath)
  const startPoint = opts?.startPoint

  if (!startPoint && spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).status !== 0) {
    return { error: 'no commits yet — make your first commit before creating a worktree' }
  }

  let resolvedTarget: string
  if (opts?.worktreePath) {
    resolvedTarget = expandHome(opts.worktreePath)
  } else {
    const repoName = basename(cwd)
    const slug     = branch.replace(/\//g, '-').replace(/[^a-zA-Z0-9-]/g, '')
    resolvedTarget = resolve(cwd, '.worktrees', `${repoName}-wt-${slug}`)
  }

  const addArgs = ['worktree', 'add', resolvedTarget, '-b', branch]
  if (startPoint) addArgs.push(startPoint)
  let result = spawnSync('git', addArgs, { cwd, encoding: 'utf8' })

  // Branch already exists — re-add without -b to check it out instead. Match on
  // the message, not a fixed exit code: git reports this as 128 on some versions
  // and 255 on others, so keying off the status alone silently skips the retry.
  if (result.status !== 0 && /branch named .* already exists|already exists/i.test(result.stderr ?? '')) {
    result = spawnSync('git', ['worktree', 'add', resolvedTarget, branch], { cwd, encoding: 'utf8' })
  }

  if (result.status !== 0) return { error: result.stderr?.trim() || 'git worktree add failed' }

  ensureWorktreesExcluded(cwd)
  return { ok: true, path: resolvedTarget }
}

/**
 * Keep Crew worktrees out of status without editing a project-owned file. Older
 * builds created an untracked `.gitignore` containing only this entry; migrate
 * that exact generated file into the repository-private exclude on sight.
 */
export function ensureWorktreesExcluded(repoPath: string): void {
  const cwd = expandHome(repoPath)
  const entry = '.worktrees/'
  try {
    const resolved = spawnSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd, encoding: 'utf8' })
    if (resolved.status !== 0) return
    const value = resolved.stdout.trim()
    const excludePath = isAbsolute(value) ? value : resolve(cwd, value)
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
    if (!existing.split('\n').some(line => line.trim() === entry)) {
      appendFileSync(excludePath, existing.endsWith('\n') || existing === '' ? `${entry}\n` : `\n${entry}\n`)
    }

    const legacyPath = resolve(cwd, '.gitignore')
    if (!existsSync(legacyPath) || readFileSync(legacyPath, 'utf8').trim() !== entry) return
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', '.gitignore'], { cwd, encoding: 'utf8' })
    if (tracked.status !== 0) unlinkSync(legacyPath)
  } catch { /* non-fatal — ignore */ }
}

/**
 * Remove a worktree. `git worktree remove` must run from inside the repository,
 * so resolve the repo's primary checkout from the target's own worktree list and
 * run there. Prune + retry covers a registration left stale by an out-of-band
 * directory deletion.
 */
export function removeWorktree(worktreePath: string): { ok: true } | { error: string } {
  const wt = expandHome(worktreePath)
  const list = spawnSync('git', ['-C', wt, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  const mainLine = (list.stdout ?? '').split('\n').find(l => l.startsWith('worktree '))
  const repoRoot = mainLine ? mainLine.slice('worktree '.length).trim() : wt

  let result = spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) {
    spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot, encoding: 'utf8' })
    if (existsSync(wt)) {
      result = spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: repoRoot, encoding: 'utf8' })
      if (result.status !== 0) return { error: result.stderr?.trim() || 'git worktree remove failed' }
    }
  }
  return { ok: true }
}

// Branch naming for write-capable delegated threads.
//
// Every delegated branch lives under one namespace so `git branch --list` makes
// agent-created work obvious, and so a future cleanup pass has a safe pattern to
// match. Kept pure and tested because a malformed ref name fails deep inside
// `git worktree add` with a message the agent can't act on.

/** Namespace prefix for every delegated branch. */
export const DELEGATED_BRANCH_PREFIX = 'crewcode/delegated'

/**
 * Slugify a thread title into a git-ref-safe fragment.
 *
 * git's ref rules forbid a lot: spaces, `~^:?*[`, `\`, leading/trailing dots and
 * slashes, `..`, `@{`, and a trailing `.lock`. Rather than enumerate the
 * exclusions, allow only `[a-z0-9-]` and collapse runs — an unusable title
 * degrades to a short slug instead of a hard git failure.
 */
export function slugForBranch(title: string, maxLength = 32): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
  return slug || 'thread'
}

/**
 * Branch name for a delegated thread. `suffix` must be unique per thread —
 * two threads sharing a branch would have `worktree add` fail on the second,
 * or worse, silently check the first one's branch out twice.
 */
export function delegatedBranchName(title: string, suffix: string): string {
  return `${DELEGATED_BRANCH_PREFIX}/${slugForBranch(title)}-${suffix}`
}

/** True for branches this feature created. Used to recognize delegated work. */
export function isDelegatedBranch(branch: string): boolean {
  return branch.startsWith(`${DELEGATED_BRANCH_PREFIX}/`)
}

// Monotonic within the process. Timestamp+random alone collides: a fan-out
// creates several threads in the same millisecond, and a few random chars hit
// the birthday bound quickly. A duplicate branch makes the second
// `git worktree add` fail — or worse, check the first one's branch out twice.
let suffixCounter = 0

/** Short, collision-free suffix. Not security-sensitive; it only has to make
 *  every delegated branch name distinct. */
export function branchSuffix(): string {
  suffixCounter = (suffixCounter + 1) % 1_000_000
  const counter = suffixCounter.toString(36)
  const random = Math.random().toString(36).slice(2, 6)
  return `${Date.now().toString(36)}${counter}${random}`
}

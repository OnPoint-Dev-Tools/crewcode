export type GitRunner = (args: string[]) => Promise<unknown>

/**
 * Remove paths from the index without changing their working-tree contents.
 * `git restore --staged` requires HEAD, so a newly initialized repository needs
 * `git rm --cached` until its first commit exists.
 */
export async function unstagePaths(paths: string[], run: GitRunner): Promise<void> {
  if (paths.length === 0) return

  let hasHead = true
  try {
    await run(['rev-parse', '--verify', 'HEAD'])
  } catch {
    hasHead = false
  }

  if (hasHead) {
    await run(['restore', '--staged', '--', ...paths])
  } else {
    await run(['rm', '--cached', '--', ...paths])
  }
}

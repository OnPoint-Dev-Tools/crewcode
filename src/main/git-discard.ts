export type GitRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>

/** Discard one working-tree change, including staged changes and untracked files. */
export async function discardPath(path: string, run: GitRunner): Promise<void> {
  if (!path) throw new Error('path is required')
  try {
    await run(['restore', '--source=HEAD', '--staged', '--worktree', '--', path])
    return
  } catch {
    // An added file has no HEAD version. Remove it from the index first, then
    // clean the working-tree copy below.
    try { await run(['rm', '--force', '--cached', '--', path]) } catch { /* not indexed */ }
  }
  await run(['clean', '--force', '--', path])
}

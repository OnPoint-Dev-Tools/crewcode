import { basename } from 'path'

/** A registered git worktree, as surfaced to the renderer's worktree list. */
export interface Worktree {
  id:     string
  path:   string
  branch: string
  head:   string
  locked: boolean
  dirty:  number
}

/**
 * Parse `git worktree list --porcelain` into the renderer's worktree shape.
 * Pure so it can be unit-tested without spawning git or booting Electron —
 * the IPC handler in index.ts feeds it raw stdout.
 *
 * `mainPath` is the repo's primary checkout, which git lists first; we skip it
 * (and any bare repo) so the result contains only the extra worktrees.
 */
export function parsePorcelainWorktrees(output: string, mainPath: string): Worktree[] {
  const blocks = output.trim().split(/\n\n+/)
  const worktrees: Worktree[] = []

  for (const block of blocks) {
    if (!block.trim()) continue
    const lines  = block.split('\n')
    let wtPath   = ''
    let head     = ''
    let branch   = ''
    let locked   = false
    let isBare   = false

    for (const line of lines) {
      if (line.startsWith('worktree '))      wtPath = line.slice('worktree '.length).trim()
      else if (line.startsWith('HEAD '))     head   = line.slice('HEAD '.length).trim().slice(0, 7)
      else if (line.startsWith('branch '))   branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
      else if (line.startsWith('locked'))    locked = true
      else if (line.trim() === 'bare')       isBare = true
    }

    // skip the main worktree (the repo root) and bare repos
    if (!wtPath || isBare || wtPath === mainPath) continue
    const id = basename(wtPath).replace(/[\s/]+/g, '-')
    worktrees.push({ id, path: wtPath, branch, head, locked, dirty: 0 })
  }

  return worktrees
}

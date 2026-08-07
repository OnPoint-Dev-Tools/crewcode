/**
 * Pure parsers + predicates for git porcelain output. Kept free of Electron and
 * child_process so they're unit-testable; git.ts feeds them raw command output.
 */

export interface GitStatusFile {
  path:   string
  status: string
  staged: boolean
}

export interface GitCommit {
  hash:      string
  shortHash: string
  author:    string
  date:      string
  message:   string
}

export interface GitStatus {
  branch:    string
  ahead:     number
  behind:    number
  hasUpstream: boolean
  staged:    GitStatusFile[]
  unstaged:  GitStatusFile[]
  untracked: GitStatusFile[]
}

/** Parse `git status --porcelain=v1 -b` into staged/unstaged/untracked sets. */
export function parseStatus(raw: string): GitStatus {
  const lines    = raw.split('\n')
  let branch     = 'HEAD'
  let ahead      = 0
  let behind     = 0
  let hasUpstream = false
  const staged:    GitStatusFile[] = []
  const unstaged:  GitStatusFile[] = []
  const untracked: GitStatusFile[] = []

  for (const line of lines) {
    if (!line) continue
    if (line.startsWith('## ')) {
      const branchMatch = line.match(/^## ([^\s.]+)/)
      if (branchMatch) branch = branchMatch[1]
      hasUpstream = line.includes('...')
      const aheadMatch  = line.match(/ahead (\d+)/)
      const behindMatch = line.match(/behind (\d+)/)
      if (aheadMatch)  ahead  = parseInt(aheadMatch[1])
      if (behindMatch) behind = parseInt(behindMatch[1])
      continue
    }
    const x = line[0] ?? ' '
    const y = line[1] ?? ' '
    // Handle rename: "R  old -> new"  or  "R  new\told"
    let path = line.slice(3)
    if ((x === 'R' || y === 'R') && path.includes('\t')) {
      path = path.split('\t')[1] ?? path
    }
    if (x === '?' && y === '?') {
      untracked.push({ path, status: '?', staged: false })
      continue
    }
    if (x !== ' ') staged.push({ path, status: x, staged: true })
    if (y !== ' ') unstaged.push({ path, status: y, staged: false })
  }

  return { branch, ahead, behind, hasUpstream, staged, unstaged, untracked }
}

/** Parse `git log --format=%H\x1f%an\x1f%ar\x1f%s` into commit records. */
export function parseLog(raw: string): GitCommit[] {
  if (!raw.trim()) return []
  return raw.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split('\x1f')
    return {
      hash:      parts[0] ?? '',
      shortHash: (parts[0] ?? '').slice(0, 7),
      author:    parts[1] ?? '',
      date:      parts[2] ?? '',
      message:   parts[3] ?? '',
    }
  })
}

/** A commit failure caused by commit-signing the GUI can't satisfy (locked SSH/GPG
 *  key, missing askpass). Used so the renderer can offer an unsigned-commit retry. */
export function isSigningFailure(msg: string): boolean {
  return /ssh_askpass|gpg failed to sign|failed to write commit object|incorrect passphrase|signing key|user\.signingkey|need a passphrase/i.test(msg)
}

/** A merge that left conflicts: exits non-zero but is "in progress", not failed. */
export function isMergeConflictOutput(out: string): boolean {
  return /conflict/i.test(out)
}

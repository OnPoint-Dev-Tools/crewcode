export interface PullRequestFilePatch {
  path: string
  patch: string
}

function trimMailEnvelope(patch: string): string {
  const boundary = patch.search(/\nFrom [0-9a-f]{7,64} Mon Sep 17 00:00:00 2001\r?\n/i)
  const signature = patch.search(/\n-- \r?\n/)
  const end = [boundary, signature].filter(index => index >= 0).sort((a, b) => a - b)[0]
  return (end == null ? patch : patch.slice(0, end)).trimEnd()
}

function appendUniqueHunks(base: string, next: string): string {
  const firstHunk = next.search(/^@@ /m)
  if (firstHunk < 0) return base
  const hunks = next.slice(firstHunk).trim()
  return !hunks || base.includes(hunks) ? base : `${base.trimEnd()}\n${hunks}`
}

/** Split and normalize GitHub's repository diff into one patch per file for PierreDiff. */
export function splitPullRequestPatch(raw: string): PullRequestFilePatch[] {
  const starts: number[] = []
  const matcher = /^diff --git /gm
  let match: RegExpExecArray | null
  while ((match = matcher.exec(raw)) !== null) starts.push(match.index)
  const byPath = new Map<string, PullRequestFilePatch>()
  for (const [index, start] of starts.entries()) {
    const patch = trimMailEnvelope(raw.slice(start, starts[index + 1] ?? raw.length))
    const plus = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1]
    const header = /^diff --git a\/(.+) b\/(.+)$/m.exec(patch)?.[2]
    const path = (plus ?? header)?.replace(/^"|"$/g, '')
    if (!path) continue
    const existing = byPath.get(path)
    byPath.set(path, existing ? { path, patch: appendUniqueHunks(existing.patch, patch) } : { path, patch })
  }
  return [...byPath.values()]
}

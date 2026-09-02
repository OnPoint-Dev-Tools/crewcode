export interface PullRequestFilePatch {
  path: string
  patch: string
}

/** Split GitHub's multi-file PR patch into the single-file patches PierreDiff expects. */
export function splitPullRequestPatch(raw: string): PullRequestFilePatch[] {
  const starts: number[] = []
  const matcher = /^diff --git /gm
  let match: RegExpExecArray | null
  while ((match = matcher.exec(raw)) !== null) starts.push(match.index)
  return starts.flatMap((start, index) => {
    const patch = raw.slice(start, starts[index + 1] ?? raw.length).trimEnd()
    const plus = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1]
    const header = /^diff --git a\/(.+) b\/(.+)$/m.exec(patch)?.[2]
    const path = (plus ?? header)?.replace(/^"|"$/g, '')
    return path ? [{ path, patch }] : []
  })
}

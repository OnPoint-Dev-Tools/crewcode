export interface GitCommitDraft {
  message: string
  amend: boolean
}

export interface GitPageMemory {
  createPullRequestOpen: boolean
  pullRequestBrowserOpen: boolean
}

export interface PullRequestCreationDraft {
  step: number
  title: string
  bodyValues: Record<'description' | 'problem' | 'whatChanged' | 'whyChanged' | 'solution', string>
  base: string
  draft: boolean
  commitScope: 'all' | 'selected'
  selectedCommits: string[]
  selectedBranch: string
}

const MAX_ENTRIES = 100
const memory = new Map<string, unknown>()

export function readGitTabMemory<T>(key: string): T | undefined {
  return memory.get(key) as T | undefined
}

export function writeGitTabMemory<T>(key: string, value: T): void {
  memory.delete(key)
  memory.set(key, value)
  while (memory.size > MAX_ENTRIES) {
    const oldest = memory.keys().next().value as string | undefined
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

export function clearGitTabMemory(key: string): void {
  memory.delete(key)
}

export function resetGitTabMemoryForTests(): void {
  memory.clear()
}

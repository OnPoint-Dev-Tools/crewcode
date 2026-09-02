/* Data contract for the Git Sidebar — see crewcode-git-sidebar/HANDOFF.md §3.
 * The renderer component is dumb: the shape below is produced by useGitSidebar
 * from the real git + GitHub IPC layer. */
import type { GitHubMergeMethod, GitHubPullRequestCreateOptions, GitHubPullRequestReviewOptions } from '../../../../shared/github-types'

export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'U' // U = unmerged (conflict)
export type CheckState   = 'ok' | 'f' | 'p' | 's'      // pass / fail / pending / skipped

export interface GitBranchRef {
  kind:    'local' | 'remote'
  name:    string
  updated: string
}

export interface GitChange {
  staged: boolean
  status: ChangeStatus
  path:   string   // full path from repo root
  name:   string   // basename for display
  dir:    string   // dirname + trailing slash
  /** False for committed differences that exist only relative to the comparison branch. */
  stageable?: boolean
  add?:   number
  del?:   number
}

export interface GitConflict {
  path:  string
  hunks: number
}

export interface GitWorktreeRef {
  id:     string
  branch: string
  path:   string
  dirty:  number
  ahead:  number
  behind: number
  agent?: string | null
}

export interface GitPrRef {
  num:      number
  status:   'open' | 'draft' | 'merged' | 'closed'
  title:    string
  head:     string
  base:     string
  author:   string
  updated:  string
  url?:     string
  checks?:  CheckState[]
  reviews?: Array<{ user: string; state: 'ok' | 'req' }>
  expanded?: boolean
  body?:    string
  mergeStateStatus?: string
  reviewDecision?: string | null
  runs?:    Array<{ name: string; state: CheckState; dur: string }>
}

export interface GitHistoryEntry {
  sha:    string
  msg:    string
  author: string
  when:   string
  you?:   boolean
  merge?: boolean
  tag?:   string
}

export interface GitBanner {
  kind?:     '' | 'warn' | 'err'
  text:      string
  spinning?: boolean
  auto?:     number   // ms before auto-dismiss; 0 = persistent
}

export interface GitState {
  ahead:           number
  behind:          number
  branch:          string   // real current branch of the active worktree
  lastFetch:       string
  remoteUrl:       string
  currentWorktree: string
  branches:        GitBranchRef[]
  changes:         GitChange[]
  conflicts:       GitConflict[]
  worktrees:       GitWorktreeRef[]
  prs:             GitPrRef[]
  history:         GitHistoryEntry[]
  banner?:         GitBanner
  user?:           string
  isRepo?:         boolean   // false when the folder isn't a git repo yet
  hasRemote?:      boolean   // false when no git remote is configured
  hasUpstream?:    boolean   // false when the current branch has not been pushed/tracked
  /** Settings-selected branch used as the review/comparison base. */
  comparisonRef?:  string
  /** Default pull-request target captured from Settings or the primary branch. */
  defaultBase?:    string
}

export interface GitPublishOpts {
  name:        string
  visibility:  'private' | 'public'
  description?: string
}

export interface GitActionOutcome {
  ok: boolean
  error?: string
}

export interface GitSidebarWorkspace {
  name:   string
  path:   string
  branch: string
  user?:  string
}

/** A chat tab the "ask agent" conflict action can route a prompt to. */
export interface GitChatTarget {
  id:    string   // chat tab id
  label: string
}

/** Sentinel target id meaning "spin up a fresh chat tab for this". */
export const NEW_CHAT_TARGET = '__new_chat__'

export interface GitSidebarHandlers {
  // Sync
  onPush?:           () => void
  onPull?:           () => void
  onFetch?:          () => void
  onSync?:           () => void   // pull then push
  onCheckoutBranch?: (ref: string) => void   // checkout an existing branch
  onCreateBranch?:   (name: string) => void  // git checkout -b

  // Working tree
  onStageFile?:   (path: string) => void
  onUnstageFile?: (path: string) => void
  /** Stage/unstage many paths in a single git call — avoids one IPC + refetch per file. */
  onStageAll?:    (paths: string[]) => void
  onUnstageAll?:  (paths: string[]) => void
  onDiscardFile?: (path: string) => void
  /** Open the unified diff for a changed file in the code editor. */
  onOpenFileDiff?: (path: string, staged: boolean) => void
  onCommit?:      (opts: { message: string; amend: boolean; push: boolean; sync?: boolean }) => void

  // Worktrees
  onCreateWorktree?: (branch: string) => void
  onSwitchWorktree?: (id: string) => void
  onMergeWorktree?:  (opts: { from: string; into: string }) => void
  onRemoveWorktree?: (id: string) => void

  // Conflicts
  // `targetTabId` (agent strategy only) routes the prompt to a specific chat tab,
  // or NEW_CHAT_TARGET to open a fresh one. Omitted → falls back to the active tab.
  onResolveConflict?: (opts: { file: string; strategy: 'ours' | 'theirs' | 'editor' | 'agent'; targetTabId?: string }) => void
  onAbortMerge?:      () => void
  onContinueMerge?:   () => void

  // Pull requests
  onCreatePR?:  (options: GitHubPullRequestCreateOptions) => Promise<GitActionOutcome>
  onOpenPR?:    (num: number) => void
  onMergePR?:   (num: number, method: GitHubMergeMethod) => Promise<GitActionOutcome>
  onApprovePR?: (num: number) => void
  onUpdatePRBranch?: (num: number) => Promise<GitActionOutcome>
  onCommentPR?: (num: number, body: string) => Promise<boolean>
  onClosePR?: (num: number) => Promise<GitActionOutcome>
  onReviewPR?: (num: number, options: GitHubPullRequestReviewOptions) => Promise<GitActionOutcome>

  // Publish flow — for folders/repos with no remote
  onInitRepo?:  () => void                    // git init a non-repo folder
  onPublish?:   (opts: GitPublishOpts) => Promise<boolean> // complete publish flow; true on success
}

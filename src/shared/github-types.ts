export type GitHubMergeMethod = 'merge' | 'squash' | 'rebase'

export interface GitHubPullRequestCreateOptions {
  title: string
  body?: string
  base: string
  draft: boolean
}

export interface GitHubCommandResponse {
  ok: boolean
  output: string
  error?: string
}

export interface GitHubPullRequestCreateContext {
  head: string
  base: string
  ahead: number
  behind: number
  changedFiles: number
  mergeStatus: 'clean' | 'conflicts' | 'unknown'
}

export interface GitHubPullRequestFile {
  path: string
  additions: number
  deletions: number
}

export interface GitHubPullRequestCommit {
  oid: string
  message: string
  author: string
  committedAt: string
}

export interface GitHubPullRequestComment {
  id: string
  author: string
  body: string
  createdAt: string
  state?: string
  kind: 'comment' | 'review'
}

export interface GitHubPullRequestCheck {
  name: string
  status: string
  conclusion: string | null
  detailsUrl?: string
}

export interface GitHubPullRequestDetail {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  url: string
  isDraft: boolean
  author: string
  body: string
  head: string
  base: string
  mergeStateStatus: string
  reviewDecision: string | null
  additions: number
  deletions: number
  files: GitHubPullRequestFile[]
  commits: GitHubPullRequestCommit[]
  comments: GitHubPullRequestComment[]
  checks: GitHubPullRequestCheck[]
}

export type GitHubPullRequestReviewEvent = 'approve' | 'comment' | 'request-changes'

export interface GitHubPullRequestReviewOptions {
  event: GitHubPullRequestReviewEvent
  body?: string
}

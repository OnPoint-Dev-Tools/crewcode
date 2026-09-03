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

export interface GitHubPullRequestConflictPreparationResult {
  ok: boolean
  status?: 'merged' | 'conflicts' | 'ready-to-continue'
  conflicts: string[]
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

export type GitHubDiffSide = 'LEFT' | 'RIGHT'

export interface GitHubPullRequestInlineCommentDraft {
  id: string
  path: string
  side: GitHubDiffSide
  line: number
  body: string
  commitId: string
}

export interface GitHubPullRequestReviewThreadComment {
  id: string
  databaseId: number | null
  author: string
  body: string
  createdAt: string
  reviewState: string
  commitId: string
}

export interface GitHubPullRequestReviewThread {
  id: string
  path: string
  side: GitHubDiffSide
  line: number | null
  startLine: number | null
  isResolved: boolean
  isOutdated: boolean
  resolvedBy: string | null
  viewerCanReply: boolean
  viewerCanResolve: boolean
  viewerCanUnresolve: boolean
  comments: GitHubPullRequestReviewThreadComment[]
}

export interface GitHubPullRequestReviewContext {
  pullRequestId: string
  headCommitId: string
  viewer: string
  viewedStateSource: 'github'
  files: Array<{ path: string; viewed: boolean }>
  threads: GitHubPullRequestReviewThread[]
  lastReviewedCommitId: string | null
  lastReviewedAt: string | null
  filesSinceLastReview: string[]
  commitsSinceLastReview: Array<{ oid: string; message: string }>
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

export interface GitHubPullRequestCheckStep {
  name: string
  number: number
  status: string
  conclusion: string | null
  startedAt: string
  completedAt: string
}

export interface GitHubPullRequestCheckAnnotation {
  level: string
  path: string
  startLine: number | null
  endLine: number | null
  title: string
  message: string
  details: string
  blobUrl?: string
}

export interface GitHubPullRequestCheckEvidence {
  id: string
  kind: 'check-run' | 'status-context'
  name: string
  suiteName: string
  status: string
  conclusion: string | null
  isRequired: boolean
  detailsUrl?: string
  startedAt: string
  completedAt: string
  title: string
  summary: string
  text: string
  runId: number | null
  runAttempt: number | null
  jobId: number | null
  steps: GitHubPullRequestCheckStep[]
  annotations: GitHubPullRequestCheckAnnotation[]
  annotationsTruncated: boolean
  stepsTruncated: boolean
}

export interface GitHubPullRequestChecksContext {
  headCommitId: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  mergeable: string
  mergeStateStatus: string
  reviewDecision: string | null
  viewerCanRerunChecks: boolean
  viewerCanEnableAutoMerge: boolean
  viewerCanDisableAutoMerge: boolean
  viewerCanUpdateBranch: boolean
  viewerCannotUpdateReasons: string[]
  isMergeQueueEnabled: boolean
  isInMergeQueue: boolean
  autoMerge: null | { enabledAt: string; enabledBy: string; mergeMethod: GitHubMergeMethod | null }
  mergeQueueEntry: null | { position: number | null; state: string; enqueuedAt: string; estimatedTimeToMerge: string; enqueuedBy: string }
  checks: GitHubPullRequestCheckEvidence[]
}

export interface GitHubPullRequestCheckLogResult {
  ok: boolean
  log: string
  truncated: boolean
  error?: string
}

export interface GitHubPullRequestCheckRerunOptions {
  headCommitId: string
  runId: number
  mode: 'all' | 'failed' | 'job'
  jobId?: number
}

export interface GitHubPullRequestMergeAutomationOptions {
  action: 'enable' | 'disable' | 'queue'
  headCommitId: string
  method?: GitHubMergeMethod
}

export interface GitHubPullRequestCatalogueItem {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  url: string
  isDraft: boolean
  author: string
  body: string
  head: string
  base: string
  createdAt: string
  updatedAt: string
  reviewDecision: string | null
  assignees: string[]
  reviewers: string[]
  labels: string[]
}

export interface GitHubPullRequestCatalogue {
  viewer: string | null
  items: GitHubPullRequestCatalogueItem[]
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
  createdAt: string
  updatedAt: string
  headCommitId: string
  mergeStateStatus: string
  reviewDecision: string | null
  additions: number
  deletions: number
  files: GitHubPullRequestFile[]
  commits: GitHubPullRequestCommit[]
  comments: GitHubPullRequestComment[]
  checks: GitHubPullRequestCheck[]
  assignees: string[]
  reviewers: Array<{ login: string; state: string }>
  labels: string[]
}

export interface GitHubPullRequestManagementContext {
  assignableUsers: string[]
  suggestedReviewers: string[]
  labels: string[]
}

export interface GitHubPullRequestEditOptions {
  title: string
  body: string
}

export type GitHubPullRequestMetadataKind = 'reviewer' | 'assignee' | 'label'
export type GitHubPullRequestMetadataOperation = 'add' | 'remove'

export interface GitHubPullRequestMetadataOptions {
  kind: GitHubPullRequestMetadataKind
  operation: GitHubPullRequestMetadataOperation
  value: string
}

export type GitHubPullRequestReviewEvent = 'approve' | 'comment' | 'request-changes'

export interface GitHubPullRequestReviewOptions {
  event: GitHubPullRequestReviewEvent
  body?: string
  commitId?: string
  comments?: GitHubPullRequestInlineCommentDraft[]
}

export interface GitHubPullRequestViewedFileOptions {
  pullRequestId: string
  path: string
  viewed: boolean
}

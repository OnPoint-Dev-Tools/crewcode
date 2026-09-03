import { execFile, spawn, spawnSync } from 'child_process'
import type {
  GitHubMergeMethod,
  GitHubPullRequestCommit,
  GitHubPullRequestCheckLogResult,
  GitHubPullRequestCheckRerunOptions,
  GitHubPullRequestChecksContext,
  GitHubPullRequestCatalogue,
  GitHubPullRequestComment,
  GitHubPullRequestConflictPreparationResult,
  GitHubPullRequestCreateContext,
  GitHubPullRequestCreateOptions,
  GitHubPullRequestDetail,
  GitHubPullRequestEditOptions,
  GitHubPullRequestManagementContext,
  GitHubPullRequestMetadataOptions,
  GitHubPullRequestMergeAutomationOptions,
  GitHubPullRequestReviewOptions,
  GitHubPullRequestReviewContext,
  GitHubPullRequestViewedFileOptions,
} from '../shared/github-types'

export interface GitHubPullRequest {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  branch: string
  base: string
  url: string
  isDraft: boolean
  author: string
  updatedAt: string
  body: string
  mergeStateStatus: string
  reviewDecision: string | null
}

interface GitHubRun {
  id: number
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | null
  branch: string
}

export interface HeadlessGitHubStatus {
  owner: string
  repo: string
  prs: GitHubPullRequest[]
  runs: GitHubRun[]
  issues: number
}

export interface GhStatusResult {
  available: boolean
  loggedIn: boolean
  user: string | null
  host: string | null
  raw: string
  error?: string
}

export interface GitHubCommandResult {
  status: number | null
  stdout: string
  stderr: string
}

export type GitHubCommandRunner = (
  command: string,
  args: string[],
  cwd?: string,
) => Promise<GitHubCommandResult>

export type GitHubInputCommandRunner = (
  command: string,
  args: string[],
  input: string,
  cwd?: string,
) => Promise<GitHubCommandResult>

const GITHUB_COMMAND_TIMEOUT_MS = 15_000
const GITHUB_AVATAR_TIMEOUT_MS = 10_000
const GITHUB_AVATAR_MAX_BYTES = 256 * 1024
const GITHUB_AVATAR_CACHE_LIMIT = 128
const GITHUB_AVATAR_HOSTS = new Set(['github.com', 'avatars.githubusercontent.com'])
const GITHUB_AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface GitHubAvatarResult {
  ok: boolean
  dataUrl?: string
  error?: string
}

const githubAvatarCache = new Map<string, Promise<GitHubAvatarResult>>()

const runGitHubCommand: GitHubCommandRunner = (command, args, cwd) => new Promise(resolve => {
  execFile(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: GITHUB_COMMAND_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    const code = (error as (NodeJS.ErrnoException & { code?: string | number }) | null)?.code
    resolve({
      status: error ? (typeof code === 'number' ? code : null) : 0,
      stdout: stdout ?? '',
      stderr: stderr ?? '',
    })
  })
})

const runGitHubInputCommand: GitHubInputCommandRunner = (command, args, input, cwd) => new Promise(resolve => {
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let settled = false
  let outputBytes = 0
  const finish = (status: number | null, fallback = '') => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolve({ status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') || fallback })
  }
  const collect = (target: Buffer[], chunk: Buffer) => {
    outputBytes += chunk.byteLength
    if (outputBytes > 4 * 1024 * 1024) {
      child.kill()
      finish(null, 'GitHub response exceeded the 4 MiB limit')
      return
    }
    target.push(chunk)
  }
  child.stdout.on('data', chunk => collect(stdout, Buffer.from(chunk)))
  child.stderr.on('data', chunk => collect(stderr, Buffer.from(chunk)))
  child.once('error', error => finish(null, error.message))
  child.once('close', code => finish(code))
  const timer = setTimeout(() => {
    child.kill()
    finish(null, 'GitHub command timed out')
  }, GITHUB_COMMAND_TIMEOUT_MS)
  child.stdin.end(input)
})

export function ghAvailable(): boolean {
  try {
    return spawnSync('gh', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0
  } catch {
    return false
  }
}

function validGitHubLogin(login: string): boolean {
  return login.length <= 100 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?$/.test(login)
}

function allowedGitHubAvatarUrl(url: URL): boolean {
  return url.protocol === 'https:' && GITHUB_AVATAR_HOSTS.has(url.hostname)
}

async function readBoundedAvatar(response: Response): Promise<Buffer | null> {
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > GITHUB_AVATAR_MAX_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total)
}

async function fetchGitHubAvatar(login: string, fetcher: typeof fetch): Promise<GitHubAvatarResult> {
  let url = new URL(`https://github.com/${encodeURIComponent(login)}.png?size=64`)
  const signal = AbortSignal.timeout(GITHUB_AVATAR_TIMEOUT_MS)

  try {
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      if (!allowedGitHubAvatarUrl(url)) return { ok: false, error: 'GitHub returned an unsupported avatar location' }
      const response = await fetcher(url, { redirect: 'manual', signal })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) return { ok: false, error: 'GitHub returned an invalid avatar redirect' }
        url = new URL(location, url)
        continue
      }
      if (!response.ok) return { ok: false, error: `GitHub avatar request failed (${response.status})` }

      const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
      if (!GITHUB_AVATAR_TYPES.has(contentType)) return { ok: false, error: 'GitHub returned an unsupported avatar image type' }
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > GITHUB_AVATAR_MAX_BYTES) {
        return { ok: false, error: 'GitHub avatar image is too large' }
      }
      const bytes = await readBoundedAvatar(response)
      if (!bytes) return { ok: false, error: 'GitHub avatar image is too large' }
      if (bytes.byteLength === 0) return { ok: false, error: 'GitHub returned an empty avatar image' }
      return { ok: true, dataUrl: `data:${contentType};base64,${bytes.toString('base64')}` }
    }
    return { ok: false, error: 'GitHub returned too many avatar redirects' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function getGitHubAvatar(
  cwd: string,
  loginInput: string,
  fetcher: typeof fetch = fetch,
): Promise<GitHubAvatarResult> {
  if (/^ssh:\/\//i.test(cwd)) return { ok: false, error: 'GitHub avatars are not available for SSH workspaces yet' }
  const login = loginInput.trim()
  if (!validGitHubLogin(login)) return { ok: false, error: 'Invalid GitHub username' }
  const cacheKey = login.toLowerCase()
  const cached = githubAvatarCache.get(cacheKey)
  if (cached) return cached

  if (githubAvatarCache.size >= GITHUB_AVATAR_CACHE_LIMIT) {
    const oldestKey = githubAvatarCache.keys().next().value as string | undefined
    if (oldestKey) githubAvatarCache.delete(oldestKey)
  }
  const pending = fetchGitHubAvatar(login, fetcher)
  githubAvatarCache.set(cacheKey, pending)
  const result = await pending
  if (!result.ok) githubAvatarCache.delete(cacheKey)
  return result
}

export async function getGhStatus(runCommand: GitHubCommandRunner = runGitHubCommand): Promise<GhStatusResult> {
  const available = await runCommand('gh', ['--version'])
  if (available.status !== 0) return { available: false, loggedIn: false, user: null, host: null, raw: '', error: 'gh CLI not found in PATH' }
  const result = await runCommand('gh', ['auth', 'status'])
  const raw = result.stdout + result.stderr
  const userMatch = raw.match(/account\s+(\S+)/i) ?? raw.match(/Logged in to\s+(\S+)\s+as\s+(\S+)/i)
  const hostMatch = raw.match(/Logged in to\s+(\S+)/i)
  return {
    available: true,
    loggedIn: result.status === 0,
    user: userMatch ? (userMatch[2] ?? userMatch[1]) : null,
    host: hostMatch?.[1] ?? null,
    raw,
  }
}

export async function runGh(cwd: string, args: string[], runCommand: GitHubCommandRunner = runGitHubCommand): Promise<{ ok: boolean; output: string; error?: string }> {
  if (/^ssh:\/\//i.test(cwd)) return { ok: false, output: '', error: 'GitHub pull-request operations are not available for SSH workspaces yet' }
  const result = await runCommand('gh', args, cwd)
  const output = (result.stdout + result.stderr).trim()
  if (result.status !== 0) return { ok: false, output, error: output || (result.status === null ? 'gh CLI not found in PATH or command timed out' : `gh ${args.join(' ')} failed`) }
  return { ok: true, output }
}

export function pullRequestCreateArgs(options: GitHubPullRequestCreateOptions): string[] {
  const title = options.title.trim()
  const base = options.base.trim()
  if (!title) throw new Error('Pull request title is required')
  if (!base) throw new Error('Base branch is required')
  const args = ['pr', 'create', '--title', title, '--base', base, '--body', options.body?.trim() ?? '']
  if (options.draft) args.push('--draft')
  return args
}

export function pullRequestMergeArgs(number: number, method: GitHubMergeMethod, headCommitId?: string): string[] {
  assertPullRequestNumber(number)
  if (!['merge', 'squash', 'rebase'].includes(method)) throw new Error('Unsupported pull request merge method')
  const args = ['pr', 'merge', String(number), `--${method}`]
  if (headCommitId) args.push('--match-head-commit', assertCommitId(headCommitId))
  return args
}

function assertPullRequestNumber(number: number): void {
  if (!Number.isInteger(number) || number < 1) throw new Error('Pull request number must be a positive integer')
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`)
  return value
}

function assertCommitId(value: string): string {
  const commitId = value.trim()
  if (!/^[0-9a-f]{7,64}$/i.test(commitId)) throw new Error('Pull request head commit is invalid')
  return commitId
}

export function pullRequestActionArgs(action: 'approve' | 'ready' | 'draft' | 'update-branch' | 'close' | 'reopen', number: number): string[] {
  assertPullRequestNumber(number)
  if (action === 'approve') return ['pr', 'review', String(number), '--approve']
  if (action === 'draft') return ['pr', 'ready', String(number), '--undo']
  return ['pr', action, String(number)]
}

export function pullRequestEditArgs(number: number, options: GitHubPullRequestEditOptions): string[] {
  assertPullRequestNumber(number)
  const title = options.title.trim()
  if (!title) throw new Error('Pull request title is required')
  if (title.length > 256) throw new Error('Pull request title must be 256 characters or fewer')
  if (options.body.length > 65_536) throw new Error('Pull request description must be 65,536 characters or fewer')
  return ['pr', 'edit', String(number), '--title', title, '--body', options.body]
}

export function pullRequestMetadataArgs(number: number, options: GitHubPullRequestMetadataOptions): string[] {
  assertPullRequestNumber(number)
  if (!['reviewer', 'assignee', 'label'].includes(options.kind)) throw new Error('Unsupported pull request metadata kind')
  if (!['add', 'remove'].includes(options.operation)) throw new Error('Unsupported pull request metadata operation')
  const value = options.value.trim()
  if (!value || value.length > 100 || /[\r\n\0,]/.test(value)) throw new Error(`Invalid pull request ${options.kind}`)
  return ['pr', 'edit', String(number), `--${options.operation}-${options.kind}`, value]
}

export function pullRequestCommentArgs(number: number, body: string): string[] {
  assertPullRequestNumber(number)
  const comment = body.trim()
  if (!comment) throw new Error('Comment is required')
  return ['pr', 'comment', String(number), '--body', comment]
}

export function pullRequestReviewArgs(number: number, options: GitHubPullRequestReviewOptions): string[] {
  assertPullRequestNumber(number)
  const body = options.body?.trim() ?? ''
  if (!['approve', 'comment', 'request-changes'].includes(options.event)) throw new Error('Unsupported pull request review event')
  if (options.event !== 'approve' && !body) throw new Error('Review comment is required')
  const flag = options.event === 'request-changes' ? '--request-changes' : `--${options.event}`
  const args = ['pr', 'review', String(number), flag]
  if (body) args.push('--body', body)
  return args
}

const REVIEW_CONTEXT_QUERY = `query CrewCodePullRequestReview($owner:String!,$repo:String!,$number:Int!){
  viewer { login }
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$number) {
      id headRefOid
      files(first:100) { nodes { path viewerViewedState } }
      reviews(last:100) { nodes { author { login } state submittedAt commit { oid } } }
      reviewThreads(first:100) { nodes {
        id path diffSide line startLine isResolved isOutdated resolvedBy { login }
        viewerCanReply viewerCanResolve viewerCanUnresolve
        comments(first:100) { nodes {
          id databaseId author { login } body createdAt commit { oid }
          pullRequestReview { state }
        } }
      } }
    }
  }
}`

const MANAGEMENT_CONTEXT_QUERY = `query CrewCodePullRequestManagement($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo) {
    assignableUsers(first:100) { nodes { login } }
    labels(first:100) { nodes { name } }
    pullRequest(number:$number) { suggestedReviewers { reviewer { login } } }
  }
}`

const CHECKS_CONTEXT_QUERY = `query CrewCodePullRequestChecks($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo) {
    viewerPermission
    pullRequest(number:$number) {
      headRefOid state isDraft mergeable mergeStateStatus reviewDecision
      isMergeQueueEnabled isInMergeQueue
      viewerCanEnableAutoMerge viewerCanDisableAutoMerge viewerCanUpdateBranch viewerCannotUpdateReasons
      autoMergeRequest { enabledAt enabledBy { login } mergeMethod }
      mergeQueueEntry { position state enqueuedAt estimatedTimeToMerge enqueuer { login } }
      statusCheckRollup { contexts(first:100) { nodes {
        __typename
        ... on CheckRun {
          id databaseId name status conclusion isRequired(pullRequestNumber:$number) detailsUrl permalink startedAt completedAt title summary text
          steps(first:100) { nodes { name number status conclusion startedAt completedAt } pageInfo { hasNextPage } }
          annotations(first:50) { nodes {
            annotationLevel path message title rawDetails blobUrl
            location { start { line column } end { line column } }
          } pageInfo { hasNextPage } }
          checkSuite { app { name } workflowRun { databaseId runAttempt url workflow { name } } }
        }
        ... on StatusContext { id context state description isRequired(pullRequestNumber:$number) targetUrl createdAt updatedAt }
      } } }
    }
  }
}`

function parseNameWithOwner(value: string): { owner: string; repo: string } | null {
  const [owner, repo, ...rest] = value.trim().split('/')
  return owner && repo && rest.length === 0 ? { owner, repo } : null
}

async function repositoryNameWithOwner(cwd: string, runCommand: GitHubCommandRunner): Promise<{ owner: string; repo: string } | { error: string }> {
  const result = await runCommand('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd)
  if (result.status !== 0) return { error: (result.stderr || result.stdout).trim() || 'Could not identify the GitHub repository' }
  return parseNameWithOwner(result.stdout) ?? { error: 'GitHub returned an invalid repository identity' }
}

export async function getPullRequestManagementContext(
  cwd: string,
  number: number,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<GitHubPullRequestManagementContext | { error: string }> {
  if (/^ssh:\/\//i.test(cwd)) return { error: 'Pull-request management is not available for SSH workspaces yet' }
  try { assertPullRequestNumber(number) } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  const identity = await repositoryNameWithOwner(cwd, runCommand)
  if ('error' in identity) return identity
  const result = await runCommand('gh', ['api', 'graphql', '-f', `query=${MANAGEMENT_CONTEXT_QUERY}`, '-F', `owner=${identity.owner}`, '-F', `repo=${identity.repo}`, '-F', `number=${number}`], cwd)
  if (result.status !== 0) return { error: (result.stderr || result.stdout).trim() || `Could not load management choices for #${number}` }
  try {
    const repository = (JSON.parse(result.stdout) as any)?.data?.repository
    if (!repository?.pullRequest) return { error: `GitHub did not return pull request #${number}` }
    return {
      assignableUsers: logins(repository.assignableUsers?.nodes),
      suggestedReviewers: logins((repository.pullRequest.suggestedReviewers ?? []).map((entry: any) => entry.reviewer)),
      labels: (Array.isArray(repository.labels?.nodes) ? repository.labels.nodes : []).map((label: any) => String(label?.name ?? '')).filter(Boolean),
    }
  } catch { return { error: `GitHub returned malformed management choices for #${number}` } }
}

function normalizeMergeMethod(value: unknown): GitHubMergeMethod | null {
  const method = String(value ?? '').toLowerCase()
  return method === 'merge' || method === 'rebase' || method === 'squash' ? method : null
}

function boundedGitHubText(value: unknown, limit: number): string {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}\n…truncated by CrewCode` : text
}

export async function getPullRequestChecksContext(
  cwd: string,
  number: number,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<GitHubPullRequestChecksContext | { error: string }> {
  if (/^ssh:\/\//i.test(cwd)) return { error: 'Detailed pull-request checks are not available for SSH workspaces yet' }
  try { assertPullRequestNumber(number) } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  const identity = await repositoryNameWithOwner(cwd, runCommand)
  if ('error' in identity) return identity
  const result = await runCommand('gh', [
    'api', 'graphql', '-f', `query=${CHECKS_CONTEXT_QUERY}`,
    '-f', `owner=${identity.owner}`, '-f', `repo=${identity.repo}`, '-F', `number=${number}`,
  ], cwd)
  if (result.status !== 0) return { error: (result.stderr || result.stdout).trim() || `Could not load detailed checks for #${number}` }
  try {
    const repository = (JSON.parse(result.stdout) as any)?.data?.repository
    const pullRequest = repository?.pullRequest
    if (!pullRequest?.headRefOid) throw new Error('missing pull request head')
    const checks = (Array.isArray(pullRequest.statusCheckRollup?.contexts?.nodes) ? pullRequest.statusCheckRollup.contexts.nodes : []).map((check: any) => {
      if (check.__typename === 'StatusContext') {
        return {
          id: String(check.id ?? `status:${check.context ?? ''}`), kind: 'status-context' as const,
          name: boundedGitHubText(check.context ?? 'External status', 512), suiteName: 'External statuses', status: String(check.state ?? 'UNKNOWN'),
          conclusion: check.state == null ? null : String(check.state), isRequired: check.isRequired === true,
          detailsUrl: typeof check.targetUrl === 'string' ? check.targetUrl : undefined,
          startedAt: String(check.createdAt ?? ''), completedAt: String(check.updatedAt ?? ''), title: '', summary: boundedGitHubText(check.description, 8_192), text: '',
          runId: null, runAttempt: null, jobId: null, steps: [], annotations: [], annotationsTruncated: false, stepsTruncated: false,
        }
      }
      const workflowRun = check.checkSuite?.workflowRun
      return {
        id: String(check.id ?? `check:${check.databaseId ?? check.name ?? ''}`), kind: 'check-run' as const,
        name: boundedGitHubText(check.name ?? 'Check', 512), suiteName: boundedGitHubText(workflowRun?.workflow?.name ?? check.checkSuite?.app?.name ?? 'Checks', 512),
        status: String(check.status ?? 'UNKNOWN'), conclusion: check.conclusion == null ? null : String(check.conclusion), isRequired: check.isRequired === true,
        detailsUrl: typeof check.permalink === 'string' ? check.permalink : typeof check.detailsUrl === 'string' ? check.detailsUrl : typeof workflowRun?.url === 'string' ? workflowRun.url : undefined,
        startedAt: String(check.startedAt ?? ''), completedAt: String(check.completedAt ?? ''), title: boundedGitHubText(check.title, 2_048), summary: boundedGitHubText(check.summary, 32_768), text: boundedGitHubText(check.text, 32_768),
        runId: Number.isInteger(workflowRun?.databaseId) ? Number(workflowRun.databaseId) : null,
        runAttempt: Number.isInteger(workflowRun?.runAttempt) ? Number(workflowRun.runAttempt) : null,
        jobId: Number.isInteger(check.databaseId) ? Number(check.databaseId) : null,
        steps: (Array.isArray(check.steps?.nodes) ? check.steps.nodes : []).map((step: any) => ({
          name: boundedGitHubText(step.name, 512), number: Number(step.number ?? 0), status: String(step.status ?? 'UNKNOWN'), conclusion: step.conclusion == null ? null : String(step.conclusion),
          startedAt: String(step.startedAt ?? ''), completedAt: String(step.completedAt ?? ''),
        })),
        annotations: (Array.isArray(check.annotations?.nodes) ? check.annotations.nodes : []).map((annotation: any) => ({
          level: String(annotation.annotationLevel ?? 'NOTICE'), path: boundedGitHubText(annotation.path, 2_048), title: boundedGitHubText(annotation.title, 2_048),
          startLine: Number.isInteger(annotation.location?.start?.line) ? Number(annotation.location.start.line) : null,
          endLine: Number.isInteger(annotation.location?.end?.line) ? Number(annotation.location.end.line) : null,
          message: boundedGitHubText(annotation.message, 8_192), details: boundedGitHubText(annotation.rawDetails, 16_384), blobUrl: typeof annotation.blobUrl === 'string' ? annotation.blobUrl : undefined,
        })),
        annotationsTruncated: check.annotations?.pageInfo?.hasNextPage === true,
        stepsTruncated: check.steps?.pageInfo?.hasNextPage === true,
      }
    })
    return {
      headCommitId: String(pullRequest.headRefOid), state: pullRequest.state as GitHubPullRequestChecksContext['state'], isDraft: pullRequest.isDraft === true,
      mergeable: String(pullRequest.mergeable ?? 'UNKNOWN'), mergeStateStatus: String(pullRequest.mergeStateStatus ?? 'UNKNOWN'),
      reviewDecision: pullRequest.reviewDecision == null ? null : String(pullRequest.reviewDecision),
      viewerCanRerunChecks: ['WRITE', 'MAINTAIN', 'ADMIN'].includes(String(repository.viewerPermission ?? '').toUpperCase()),
      viewerCanEnableAutoMerge: pullRequest.viewerCanEnableAutoMerge === true, viewerCanDisableAutoMerge: pullRequest.viewerCanDisableAutoMerge === true,
      viewerCanUpdateBranch: pullRequest.viewerCanUpdateBranch === true,
      viewerCannotUpdateReasons: (Array.isArray(pullRequest.viewerCannotUpdateReasons) ? pullRequest.viewerCannotUpdateReasons : []).map(String),
      isMergeQueueEnabled: pullRequest.isMergeQueueEnabled === true, isInMergeQueue: pullRequest.isInMergeQueue === true,
      autoMerge: pullRequest.autoMergeRequest ? { enabledAt: String(pullRequest.autoMergeRequest.enabledAt ?? ''), enabledBy: String(pullRequest.autoMergeRequest.enabledBy?.login ?? ''), mergeMethod: normalizeMergeMethod(pullRequest.autoMergeRequest.mergeMethod) } : null,
      mergeQueueEntry: pullRequest.mergeQueueEntry ? {
        position: Number.isInteger(pullRequest.mergeQueueEntry.position) ? Number(pullRequest.mergeQueueEntry.position) : null,
        state: String(pullRequest.mergeQueueEntry.state ?? ''), enqueuedAt: String(pullRequest.mergeQueueEntry.enqueuedAt ?? ''),
        estimatedTimeToMerge: String(pullRequest.mergeQueueEntry.estimatedTimeToMerge ?? ''), enqueuedBy: String(pullRequest.mergeQueueEntry.enqueuer?.login ?? ''),
      } : null,
      checks,
    }
  } catch { return { error: `GitHub returned malformed detailed check evidence for #${number}` } }
}

const CHECK_LOG_LIMIT = 256 * 1024

export async function getPullRequestCheckLog(
  cwd: string,
  number: number,
  headCommitIdInput: string,
  runIdInput: number,
  jobIdInput: number,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<GitHubPullRequestCheckLogResult> {
  let headCommitId: string
  let runId: number
  let jobId: number
  try { headCommitId = assertCommitId(headCommitIdInput); runId = assertPositiveInteger(runIdInput, 'Workflow run'); jobId = assertPositiveInteger(jobIdInput, 'Check job') }
  catch (error) { return { ok: false, log: '', truncated: false, error: error instanceof Error ? error.message : String(error) } }
  const context = await getPullRequestChecksContext(cwd, number, runCommand)
  if ('error' in context) return { ok: false, log: '', truncated: false, error: context.error }
  if (context.headCommitId !== headCommitId) return { ok: false, log: '', truncated: false, error: 'The pull request head changed before its check log was loaded' }
  if (!context.checks.some(check => check.runId === runId && check.jobId === jobId)) return { ok: false, log: '', truncated: false, error: 'The workflow job does not belong to the selected pull request head' }
  const result = await runCommand('gh', ['run', 'view', String(runId), '--job', String(jobId), '--log'], cwd)
  if (result.status !== 0) return { ok: false, log: '', truncated: false, error: (result.stderr || result.stdout).trim() || 'GitHub did not return a log for this workflow job' }
  const cleanLog = result.stdout.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
  return { ok: true, log: cleanLog.slice(0, CHECK_LOG_LIMIT), truncated: cleanLog.length > CHECK_LOG_LIMIT }
}

export async function rerunPullRequestCheck(
  cwd: string,
  number: number,
  options: GitHubPullRequestCheckRerunOptions,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<{ ok: boolean; output: string; error?: string }> {
  let headCommitId: string
  let runId: number
  try { assertPullRequestNumber(number); headCommitId = assertCommitId(options.headCommitId); runId = assertPositiveInteger(options.runId, 'Workflow run') }
  catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  if (!['all', 'failed', 'job'].includes(options.mode)) return { ok: false, output: '', error: 'Unsupported check rerun mode' }
  const context = await getPullRequestChecksContext(cwd, number, runCommand)
  if ('error' in context) return { ok: false, output: '', error: context.error }
  if (context.headCommitId !== headCommitId) return { ok: false, output: '', error: 'The pull request head changed before the check rerun' }
  if (!context.viewerCanRerunChecks) return { ok: false, output: '', error: 'GitHub does not report write permission to rerun checks in this repository' }
  const runChecks = context.checks.filter(check => check.runId === runId)
  if (!runChecks.length) return { ok: false, output: '', error: 'The workflow run does not belong to the selected pull request head' }
  const args = ['run', 'rerun', String(runId)]
  if (options.mode === 'failed') args.push('--failed')
  if (options.mode === 'job') {
    let jobId: number
    try { jobId = assertPositiveInteger(Number(options.jobId), 'Check job') }
    catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
    if (!runChecks.some(check => check.jobId === jobId)) return { ok: false, output: '', error: 'The workflow job does not belong to the selected workflow run' }
    args.push('--job', String(jobId))
  }
  return runGh(cwd, args, runCommand)
}

export async function updatePullRequestMergeAutomation(
  cwd: string,
  number: number,
  options: GitHubPullRequestMergeAutomationOptions,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<{ ok: boolean; output: string; error?: string }> {
  let headCommitId: string
  try { assertPullRequestNumber(number); headCommitId = assertCommitId(options.headCommitId) }
  catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  const context = await getPullRequestChecksContext(cwd, number, runCommand)
  if ('error' in context) return { ok: false, output: '', error: context.error }
  if (context.headCommitId !== headCommitId) return { ok: false, output: '', error: 'The pull request head changed before the merge action' }
  if (context.state !== 'OPEN' || context.isDraft) return { ok: false, output: '', error: 'Only an open, ready pull request can use merge automation' }
  if (options.action === 'disable') {
    if (!context.viewerCanDisableAutoMerge) return { ok: false, output: '', error: 'GitHub does not allow this user to disable auto-merge' }
    return runGh(cwd, ['pr', 'merge', String(number), '--disable-auto', '--match-head-commit', headCommitId], runCommand)
  }
  if (options.action === 'queue') {
    if (!context.isMergeQueueEnabled) return { ok: false, output: '', error: 'GitHub does not report a merge queue for this base branch' }
    return runGh(cwd, ['pr', 'merge', String(number), '--match-head-commit', headCommitId], runCommand)
  }
  if (options.action !== 'enable' || !options.method || !['merge', 'squash', 'rebase'].includes(options.method)) return { ok: false, output: '', error: 'A supported auto-merge method is required' }
  if (!context.viewerCanEnableAutoMerge) return { ok: false, output: '', error: 'GitHub does not allow this user to enable auto-merge' }
  return runGh(cwd, ['pr', 'merge', String(number), '--auto', `--${options.method}`, '--match-head-commit', headCommitId], runCommand)
}

export async function getPullRequestReviewContext(
  cwd: string,
  number: number,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<GitHubPullRequestReviewContext | { error: string }> {
  if (/^ssh:\/\//i.test(cwd)) return { error: 'Inline pull-request review is not available for SSH workspaces yet' }
  try { assertPullRequestNumber(number) } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  const identity = await repositoryNameWithOwner(cwd, runCommand)
  if ('error' in identity) return identity
  const result = await runCommand('gh', [
    'api', 'graphql', '-f', `query=${REVIEW_CONTEXT_QUERY}`,
    '-f', `owner=${identity.owner}`, '-f', `repo=${identity.repo}`, '-F', `number=${number}`,
  ], cwd)
  if (result.status !== 0) return { error: (result.stderr || result.stdout).trim() || `Could not load inline review evidence for #${number}` }
  try {
    const raw = JSON.parse(result.stdout) as Record<string, any>
    const pullRequest = raw.data?.repository?.pullRequest
    const viewer = String(raw.data?.viewer?.login ?? '')
    if (!pullRequest?.id || !pullRequest?.headRefOid || !viewer) throw new Error('missing review identity')
    const reviews = (Array.isArray(pullRequest.reviews?.nodes) ? pullRequest.reviews.nodes : [])
      .filter((review: Record<string, any>) => review.author?.login?.toLowerCase() === viewer.toLowerCase() && review.state !== 'PENDING' && review.submittedAt)
      .sort((a: Record<string, any>, b: Record<string, any>) => String(b.submittedAt).localeCompare(String(a.submittedAt)))
    const lastReview = reviews[0]
    const headCommitId = String(pullRequest.headRefOid)
    const lastReviewedCommitId = lastReview?.commit?.oid ? String(lastReview.commit.oid) : null
    let filesSinceLastReview: string[] = []
    let commitsSinceLastReview: Array<{ oid: string; message: string }> = []
    if (lastReviewedCommitId && /^[0-9a-f]{7,64}$/i.test(lastReviewedCommitId) && lastReviewedCommitId !== headCommitId) {
      const comparison = await runCommand('gh', ['api', `repos/${identity.owner}/${identity.repo}/compare/${lastReviewedCommitId}...${headCommitId}`], cwd)
      if (comparison.status === 0) {
        const compared = JSON.parse(comparison.stdout) as Record<string, any>
        filesSinceLastReview = (Array.isArray(compared.files) ? compared.files : []).map((file: Record<string, unknown>) => String(file.filename ?? '')).filter(Boolean)
        commitsSinceLastReview = (Array.isArray(compared.commits) ? compared.commits : []).map((commit: Record<string, any>) => ({
          oid: String(commit.sha ?? ''), message: String(commit.commit?.message ?? '').split(/\r?\n/, 1)[0],
        })).filter((commit: { oid: string }) => commit.oid)
      }
    }
    return {
      pullRequestId: String(pullRequest.id),
      headCommitId,
      viewer,
      viewedStateSource: 'github',
      files: (Array.isArray(pullRequest.files?.nodes) ? pullRequest.files.nodes : []).map((file: Record<string, unknown>) => ({
        path: String(file.path ?? ''), viewed: String(file.viewerViewedState ?? '').toUpperCase() === 'VIEWED',
      })).filter((file: { path: string }) => file.path),
      threads: (Array.isArray(pullRequest.reviewThreads?.nodes) ? pullRequest.reviewThreads.nodes : []).map((thread: Record<string, any>) => ({
        id: String(thread.id ?? ''), path: String(thread.path ?? ''), side: String(thread.diffSide ?? 'RIGHT') === 'LEFT' ? 'LEFT' as const : 'RIGHT' as const,
        line: Number.isInteger(thread.line) ? Number(thread.line) : null,
        startLine: Number.isInteger(thread.startLine) ? Number(thread.startLine) : null,
        isResolved: thread.isResolved === true, isOutdated: thread.isOutdated === true,
        resolvedBy: thread.resolvedBy?.login ? String(thread.resolvedBy.login) : null,
        viewerCanReply: thread.viewerCanReply === true, viewerCanResolve: thread.viewerCanResolve === true, viewerCanUnresolve: thread.viewerCanUnresolve === true,
        comments: (Array.isArray(thread.comments?.nodes) ? thread.comments.nodes : []).map((comment: Record<string, any>) => ({
          id: String(comment.id ?? ''), databaseId: Number.isInteger(comment.databaseId) ? Number(comment.databaseId) : null,
          author: String(comment.author?.login ?? ''), body: String(comment.body ?? ''), createdAt: String(comment.createdAt ?? ''),
          reviewState: String(comment.pullRequestReview?.state ?? ''), commitId: String(comment.commit?.oid ?? ''),
        })),
      })).filter((thread: { id: string; path: string }) => thread.id && thread.path),
      lastReviewedCommitId,
      lastReviewedAt: lastReview?.submittedAt ? String(lastReview.submittedAt) : null,
      filesSinceLastReview,
      commitsSinceLastReview,
    }
  } catch {
    return { error: `GitHub returned malformed inline review evidence for #${number}` }
  }
}

export function pullRequestViewedFileArgs(options: GitHubPullRequestViewedFileOptions): string[] {
  if (!options.pullRequestId.trim() || !options.path.trim()) throw new Error('Pull request and file are required')
  const mutation = options.viewed
    ? 'mutation($pullRequestId:ID!,$path:String!){markFileAsViewed(input:{pullRequestId:$pullRequestId,path:$path}){pullRequest{id}}}'
    : 'mutation($pullRequestId:ID!,$path:String!){unmarkFileAsViewed(input:{pullRequestId:$pullRequestId,path:$path}){pullRequest{id}}}'
  return ['api', 'graphql', '-f', `query=${mutation}`, '-f', `pullRequestId=${options.pullRequestId}`, '-f', `path=${options.path}`]
}

export function pullRequestReviewThreadArgs(threadIdInput: string, resolved: boolean): string[] {
  const threadId = threadIdInput.trim()
  if (!threadId) throw new Error('Review thread is required')
  const mutation = resolved
    ? 'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}'
    : 'mutation($threadId:ID!){unresolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}'
  return ['api', 'graphql', '-f', `query=${mutation}`, '-f', `threadId=${threadId}`]
}

export async function updatePullRequestViewedFile(
  cwd: string,
  number: number,
  options: GitHubPullRequestViewedFileOptions,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const context = await getPullRequestReviewContext(cwd, number, runCommand)
  if ('error' in context) return { ok: false, output: '', error: context.error }
  if (context.pullRequestId !== options.pullRequestId || !context.files.some(file => file.path === options.path)) {
    return { ok: false, output: '', error: 'The viewed-file target does not belong to the selected pull request' }
  }
  return runGh(cwd, pullRequestViewedFileArgs(options), runCommand)
}

export async function updatePullRequestReviewThread(
  cwd: string,
  number: number,
  threadId: string,
  resolved: boolean,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<{ ok: boolean; output: string; error?: string }> {
  const context = await getPullRequestReviewContext(cwd, number, runCommand)
  if ('error' in context) return { ok: false, output: '', error: context.error }
  const thread = context.threads.find(candidate => candidate.id === threadId)
  if (!thread) return { ok: false, output: '', error: 'The review conversation does not belong to the selected pull request' }
  if (resolved && !thread.viewerCanResolve) return { ok: false, output: '', error: 'GitHub does not allow this user to resolve the review conversation' }
  if (!resolved && !thread.viewerCanUnresolve) return { ok: false, output: '', error: 'GitHub does not allow this user to reopen the review conversation' }
  return runGh(cwd, pullRequestReviewThreadArgs(threadId, resolved), runCommand)
}

export async function submitPullRequestReview(
  cwd: string,
  number: number,
  options: GitHubPullRequestReviewOptions,
  runCommand: GitHubCommandRunner = runGitHubCommand,
  runInputCommand: GitHubInputCommandRunner = runGitHubInputCommand,
): Promise<{ ok: boolean; output: string; error?: string }> {
  if (/^ssh:\/\//i.test(cwd)) return { ok: false, output: '', error: 'Inline pull-request review is not available for SSH workspaces yet' }
  try { assertPullRequestNumber(number) } catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  if (!['approve', 'comment', 'request-changes'].includes(options.event)) return { ok: false, output: '', error: 'Unsupported pull request review event' }
  const body = options.body?.trim() ?? ''
  if (options.event !== 'approve' && !body) return { ok: false, output: '', error: 'Review comment is required' }
  const comments = options.comments ?? []
  const commitId = options.commitId?.trim() ?? ''
  if (comments.length > 100) return { ok: false, output: '', error: 'A review can contain at most 100 inline comments' }
  if (comments.length && !/^[0-9a-f]{7,64}$/i.test(commitId)) return { ok: false, output: '', error: 'The reviewed head commit is invalid' }
  for (const comment of comments) {
    if (!comment.path.trim() || !comment.body.trim() || !Number.isInteger(comment.line) || comment.line < 1 || !['LEFT', 'RIGHT'].includes(comment.side) || comment.commitId !== commitId) {
      return { ok: false, output: '', error: 'An inline review comment has an invalid or stale target' }
    }
  }
  const identity = await repositoryNameWithOwner(cwd, runCommand)
  if ('error' in identity) return { ok: false, output: '', error: identity.error }
  if (comments.length) {
    const head = await runCommand('gh', ['pr', 'view', String(number), '--json', 'headRefOid', '--jq', '.headRefOid'], cwd)
    if (head.status !== 0) return { ok: false, output: '', error: (head.stderr || head.stdout).trim() || 'Could not validate the pull request head commit' }
    if (head.stdout.trim() !== commitId) return { ok: false, output: '', error: 'The pull request changed after these inline comments were drafted. Refresh the review before submitting.' }
  }
  const payload = JSON.stringify({
    ...(commitId ? { commit_id: commitId } : {}),
    body,
    event: options.event === 'request-changes' ? 'REQUEST_CHANGES' : options.event.toUpperCase(),
    comments: comments.map(comment => ({ path: comment.path, line: comment.line, side: comment.side, body: comment.body.trim() })),
  })
  const result = await runInputCommand('gh', ['api', '--method', 'POST', `repos/${identity.owner}/${identity.repo}/pulls/${number}/reviews`, '--input', '-'], payload, cwd)
  const output = (result.stdout + result.stderr).trim()
  return result.status === 0 ? { ok: true, output } : { ok: false, output, error: output || 'GitHub did not accept the pull-request review' }
}

export async function preparePullRequestConflictResolution(
  cwd: string,
  expectedHeadInput: string,
  baseInput: string,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<GitHubPullRequestConflictPreparationResult> {
  if (/^ssh:\/\//i.test(cwd)) return { ok: false, conflicts: [], output: '', error: 'Pull-request conflict resolution is not available for SSH workspaces yet' }
  const expectedHead = expectedHeadInput.trim()
  const base = baseInput.trim()
  if (!validGitRef(expectedHead) || !validGitRef(base)) return { ok: false, conflicts: [], output: '', error: 'Invalid pull-request branch' }

  const branchResult = await runCommand('git', ['branch', '--show-current'], cwd)
  const currentBranch = branchResult.stdout.trim()
  if (branchResult.status !== 0 || !currentBranch) {
    return { ok: false, conflicts: [], output: '', error: (branchResult.stderr || branchResult.stdout).trim() || 'Could not determine the current branch' }
  }
  if (currentBranch !== expectedHead) {
    return { ok: false, conflicts: [], output: '', error: `Conflict resolution must run in the ${expectedHead} worktree; this worktree is on ${currentBranch}` }
  }

  const mergeHead = await runCommand('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd)
  if (mergeHead.status === 0) {
    const unresolved = await runCommand('git', ['diff', '--name-only', '--diff-filter=U'], cwd)
    const conflicts = unresolved.stdout.split(/\r?\n/).map(path => path.trim()).filter(Boolean)
    return {
      ok: true,
      status: conflicts.length > 0 ? 'conflicts' : 'ready-to-continue',
      conflicts,
      output: conflicts.length > 0 ? 'A merge is already in progress with unresolved conflicts.' : 'All merge conflicts are resolved; continue the merge.',
    }
  }

  const worktree = await runCommand('git', ['status', '--porcelain'], cwd)
  if (worktree.status !== 0) return { ok: false, conflicts: [], output: '', error: (worktree.stderr || worktree.stdout).trim() || 'Could not inspect the worktree' }
  if (worktree.stdout.trim()) return { ok: false, conflicts: [], output: '', error: `The ${expectedHead} worktree has uncommitted changes. Commit, stash, or discard them before starting conflict resolution.` }

  const fetch = await runCommand('git', ['fetch', 'origin', base], cwd)
  if (fetch.status !== 0) return { ok: false, conflicts: [], output: fetch.stdout.trim(), error: (fetch.stderr || fetch.stdout).trim() || `Could not fetch origin/${base}` }

  const merge = await runCommand('git', ['merge', '--no-edit', `origin/${base}`], cwd)
  const output = (merge.stdout + merge.stderr).trim()
  if (merge.status === 0) return { ok: true, status: 'merged', conflicts: [], output }

  const unresolved = await runCommand('git', ['diff', '--name-only', '--diff-filter=U'], cwd)
  const conflicts = unresolved.stdout.split(/\r?\n/).map(path => path.trim()).filter(Boolean)
  if (conflicts.length > 0) return { ok: true, status: 'conflicts', conflicts, output }
  return { ok: false, conflicts: [], output, error: output || `Could not merge origin/${base} into ${expectedHead}` }
}

function validGitRef(ref: string): boolean {
  return !!ref && !ref.startsWith('-') && !ref.endsWith('/') && !ref.endsWith('.lock')
    && !ref.includes('..') && !ref.includes('@{') && !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(ref)
}

export async function getPullRequestCreateContext(
  cwd: string,
  baseInput: string,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<GitHubPullRequestCreateContext | { error: string }> {
  if (/^ssh:\/\//i.test(cwd)) return { error: 'Pull-request comparison is not available for SSH workspaces yet' }
  const base = baseInput.trim()
  if (!validGitRef(base)) return { error: 'Invalid base branch' }
  const [headResult, countsResult, filesResult, mergeBaseResult] = await Promise.all([
    runCommand('git', ['branch', '--show-current'], cwd),
    runCommand('git', ['rev-list', '--left-right', '--count', `${base}...HEAD`], cwd),
    runCommand('git', ['diff', '--name-only', `${base}...HEAD`], cwd),
    runCommand('git', ['merge-base', base, 'HEAD'], cwd),
  ])
  if (countsResult.status !== 0) return { error: (countsResult.stderr || countsResult.stdout).trim() || `Could not compare HEAD with ${base}` }
  const [behindRaw = '0', aheadRaw = '0'] = countsResult.stdout.trim().split(/\s+/)
  let mergeStatus: GitHubPullRequestCreateContext['mergeStatus'] = 'unknown'
  if (mergeBaseResult.status === 0 && mergeBaseResult.stdout.trim()) {
    const merge = await runCommand('git', ['merge-tree', mergeBaseResult.stdout.trim(), base, 'HEAD'], cwd)
    if (merge.status === 0) mergeStatus = /^(?:added in both|removed in remote|removed in local)$/m.test(merge.stdout) || /<<<<<<<|>>>>>>>|CONFLICT/m.test(merge.stdout)
      ? 'conflicts'
      : 'clean'
  }
  return {
    head: headResult.stdout.trim() || 'HEAD',
    base,
    ahead: Number.parseInt(aheadRaw, 10) || 0,
    behind: Number.parseInt(behindRaw, 10) || 0,
    changedFiles: filesResult.status === 0 ? filesResult.stdout.split(/\r?\n/).filter(Boolean).length : 0,
    mergeStatus,
  }
}

function normalizeCheck(raw: Record<string, unknown>): GitHubPullRequestDetail['checks'][number] {
  return {
    name: String(raw.name ?? raw.context ?? raw.workflowName ?? 'check'),
    status: String(raw.status ?? raw.state ?? 'UNKNOWN'),
    conclusion: raw.conclusion == null ? null : String(raw.conclusion),
    detailsUrl: typeof raw.detailsUrl === 'string' ? raw.detailsUrl : typeof raw.targetUrl === 'string' ? raw.targetUrl : undefined,
  }
}

export async function getPullRequestDetail(
  cwd: string,
  number: number,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<GitHubPullRequestDetail | { error: string }> {
  if (/^ssh:\/\//i.test(cwd)) return { error: 'Pull-request review is not available for SSH workspaces yet' }
  try { assertPullRequestNumber(number) } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
  const fields = 'number,title,state,url,isDraft,author,body,headRefName,headRefOid,baseRefName,createdAt,updatedAt,mergeStateStatus,reviewDecision,additions,deletions,files,commits,comments,reviews,reviewRequests,assignees,labels,statusCheckRollup'
  const result = await runCommand('gh', ['pr', 'view', String(number), '--json', fields], cwd)
  if (result.status !== 0) return { error: (result.stderr || result.stdout).trim() || `Could not load pull request #${number}` }
  try {
    const raw = JSON.parse(result.stdout) as Record<string, any>
    const commits: GitHubPullRequestCommit[] = (Array.isArray(raw.commits) ? raw.commits : []).map((commit: Record<string, any>) => ({
      oid: String(commit.oid ?? ''),
      message: String(commit.messageHeadline ?? commit.message ?? ''),
      author: String(commit.authors?.[0]?.login ?? commit.authors?.[0]?.name ?? ''),
      committedAt: String(commit.committedDate ?? ''),
    }))
    const comments: GitHubPullRequestComment[] = [
      ...(Array.isArray(raw.comments) ? raw.comments : []).map((comment: Record<string, any>) => ({
        id: String(comment.id ?? ''), author: String(comment.author?.login ?? ''), body: String(comment.body ?? ''),
        createdAt: String(comment.createdAt ?? ''), kind: 'comment' as const,
      })),
      ...(Array.isArray(raw.reviews) ? raw.reviews : []).filter((review: Record<string, any>) => review.body || review.state).map((review: Record<string, any>) => ({
        id: String(review.id ?? ''), author: String(review.author?.login ?? ''), body: String(review.body ?? ''),
        createdAt: String(review.submittedAt ?? ''), state: String(review.state ?? ''), kind: 'review' as const,
      })),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const reviewerStates = new Map<string, string>()
    for (const request of Array.isArray(raw.reviewRequests) ? raw.reviewRequests : []) {
      const login = String(request.login ?? '')
      if (login) reviewerStates.set(login, 'REQUESTED')
    }
    for (const review of Array.isArray(raw.reviews) ? raw.reviews : []) {
      const login = String(review.author?.login ?? '')
      if (login) reviewerStates.set(login, String(review.state ?? 'REVIEWED'))
    }
    return {
      number: Number(raw.number), title: String(raw.title ?? ''), state: raw.state as GitHubPullRequestDetail['state'],
      url: String(raw.url ?? ''), isDraft: raw.isDraft === true, author: String(raw.author?.login ?? ''), body: String(raw.body ?? ''),
      head: String(raw.headRefName ?? ''), base: String(raw.baseRefName ?? ''), createdAt: String(raw.createdAt ?? ''), updatedAt: String(raw.updatedAt ?? ''), headCommitId: String(raw.headRefOid ?? ''), mergeStateStatus: String(raw.mergeStateStatus ?? 'UNKNOWN'),
      reviewDecision: raw.reviewDecision == null ? null : String(raw.reviewDecision), additions: Number(raw.additions ?? 0), deletions: Number(raw.deletions ?? 0),
      files: (Array.isArray(raw.files) ? raw.files : []).map((file: Record<string, unknown>) => ({ path: String(file.path ?? ''), additions: Number(file.additions ?? 0), deletions: Number(file.deletions ?? 0) })),
      commits, comments, checks: (Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []).map((check: Record<string, unknown>) => normalizeCheck(check)),
      assignees: (Array.isArray(raw.assignees) ? raw.assignees : []).map((person: Record<string, unknown>) => String(person.login ?? '')).filter(Boolean),
      reviewers: [...reviewerStates].map(([login, state]) => ({ login, state })),
      labels: (Array.isArray(raw.labels) ? raw.labels : []).map((label: Record<string, unknown>) => String(label.name ?? '')).filter(Boolean),
    }
  } catch { return { error: `GitHub returned malformed pull request data for #${number}` } }
}

function logins(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : [])
    .map(person => String((person as Record<string, unknown>).login ?? ''))
    .filter(Boolean)
}

export async function getPullRequestCatalogue(
  cwd: string,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<GitHubPullRequestCatalogue | { error: string }> {
  if (/^ssh:\/\//i.test(cwd)) return { error: 'Pull-request browsing is not available for SSH workspaces yet' }
  const fields = 'number,title,state,url,isDraft,author,body,headRefName,baseRefName,createdAt,updatedAt,reviewDecision,assignees,reviewRequests,labels'
  const [list, auth] = await Promise.all([
    runCommand('gh', ['pr', 'list', '--state', 'all', '--limit', '100', '--json', fields], cwd),
    runCommand('gh', ['auth', 'status'], cwd),
  ])
  if (list.status !== 0) return { error: (list.stderr || list.stdout).trim() || 'Could not load pull requests' }
  try {
    const raw = JSON.parse(list.stdout) as Array<Record<string, any>>
    const authText = auth.stdout + auth.stderr
    const viewer = authText.match(/Logged in to\s+\S+\s+as\s+(\S+)/i)?.[1]
      ?? authText.match(/account\s+(\S+)/i)?.[1]
      ?? null
    return {
      viewer,
      items: raw.map(pr => ({
        number: Number(pr.number),
        title: String(pr.title ?? ''),
        state: pr.state as 'OPEN' | 'CLOSED' | 'MERGED',
        url: String(pr.url ?? ''),
        isDraft: pr.isDraft === true,
        author: String(pr.author?.login ?? ''),
        body: String(pr.body ?? ''),
        head: String(pr.headRefName ?? ''),
        base: String(pr.baseRefName ?? ''),
        createdAt: String(pr.createdAt ?? ''),
        updatedAt: String(pr.updatedAt ?? ''),
        reviewDecision: pr.reviewDecision == null ? null : String(pr.reviewDecision),
        assignees: logins(pr.assignees),
        reviewers: logins(pr.reviewRequests),
        labels: (Array.isArray(pr.labels) ? pr.labels : []).map((label: Record<string, unknown>) => String(label.name ?? '')).filter(Boolean),
      })),
    }
  } catch {
    return { error: 'GitHub returned malformed pull-request catalogue data' }
  }
}

export async function getPullRequestDiff(
  cwd: string,
  number: number,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<{ ok: boolean; patch: string; error?: string }> {
  if (/^ssh:\/\//i.test(cwd)) return { ok: false, patch: '', error: 'Pull-request review is not available for SSH workspaces yet' }
  try { assertPullRequestNumber(number) } catch (error) { return { ok: false, patch: '', error: error instanceof Error ? error.message : String(error) } }
  // The default output is one combined base-to-head diff. `--patch` emits a
  // format-patch mail series (one envelope per commit), which is not a single
  // repository patch and can make Pierre parse multiple diffs for one file.
  const result = await runCommand('gh', ['pr', 'diff', String(number)], cwd)
  if (result.status !== 0) return { ok: false, patch: '', error: (result.stderr || result.stdout).trim() || `Could not load diff for #${number}` }
  return { ok: true, patch: result.stdout }
}

export async function getGitHubStatus(
  cwd: string,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<HeadlessGitHubStatus | { error: string }> {
  const [available, remoteResult] = await Promise.all([
    runCommand('gh', ['--version'], cwd),
    runCommand('git', ['remote', 'get-url', 'origin'], cwd),
  ])
  if (available.status !== 0) return { error: 'gh CLI not found' }
  const remoteUrl = remoteResult.stdout.trim()
  if (!remoteUrl.includes('github.com')) return { error: 'not a GitHub repo' }
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/)
  if (!match) return { error: 'could not parse GitHub remote URL' }
  const [, owner, repo] = match

  const [prResult, runResult, issueResult] = await Promise.all([
    runCommand('gh', ['pr', 'list', '--json', 'number,title,headRefName,baseRefName,state,url,isDraft,author,updatedAt,body,mergeStateStatus,reviewDecision', '--limit', '20'], cwd),
    runCommand('gh', ['run', 'list', '--json', 'databaseId,name,status,conclusion,headBranch', '--limit', '10'], cwd),
    runCommand('gh', ['issue', 'list', '--state', 'open', '--json', 'number', '--limit', '100'], cwd),
  ])

  let prs: GitHubPullRequest[] = []
  if (prResult.status === 0 && prResult.stdout) {
    try {
      const raw = JSON.parse(prResult.stdout) as Array<{
        number: number; title: string; headRefName: string; baseRefName: string; state: string; url: string
        isDraft?: boolean; author?: { login?: string } | null; updatedAt?: string; body?: string
        mergeStateStatus?: string; reviewDecision?: string | null
      }>
      prs = raw.map(pr => ({
        number: pr.number,
        title: pr.title,
        state: pr.state as GitHubPullRequest['state'],
        branch: pr.headRefName,
        base: pr.baseRefName,
        url: pr.url,
        isDraft: pr.isDraft === true,
        author: pr.author?.login ?? '',
        updatedAt: pr.updatedAt ?? '',
        body: pr.body ?? '',
        mergeStateStatus: pr.mergeStateStatus ?? 'UNKNOWN',
        reviewDecision: pr.reviewDecision ?? null,
      }))
    } catch { /* malformed gh output produces an empty section */ }
  }

  let runs: GitHubRun[] = []
  if (runResult.status === 0 && runResult.stdout) {
    try {
      const raw = JSON.parse(runResult.stdout) as Array<{ databaseId: number; name: string; status: string; conclusion: string | null; headBranch: string }>
      runs = raw.map(run => ({ id: run.databaseId, name: run.name, status: run.status as GitHubRun['status'], conclusion: run.conclusion as GitHubRun['conclusion'], branch: run.headBranch }))
    } catch { /* malformed gh output produces an empty section */ }
  }

  let issues = 0
  if (issueResult.status === 0 && issueResult.stdout) {
    try { issues = (JSON.parse(issueResult.stdout) as unknown[]).length } catch { /* keep zero */ }
  }
  return { owner, repo, prs, runs, issues }
}

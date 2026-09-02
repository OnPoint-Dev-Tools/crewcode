import { execFile, spawnSync } from 'child_process'
import type {
  GitHubMergeMethod,
  GitHubPullRequestCommit,
  GitHubPullRequestComment,
  GitHubPullRequestCreateContext,
  GitHubPullRequestCreateOptions,
  GitHubPullRequestDetail,
  GitHubPullRequestReviewOptions,
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

const GITHUB_COMMAND_TIMEOUT_MS = 15_000

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

export function ghAvailable(): boolean {
  try {
    return spawnSync('gh', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0
  } catch {
    return false
  }
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

export async function runGh(cwd: string, args: string[]): Promise<{ ok: boolean; output: string; error?: string }> {
  if (/^ssh:\/\//i.test(cwd)) return { ok: false, output: '', error: 'GitHub pull-request operations are not available for SSH workspaces yet' }
  const result = await runGitHubCommand('gh', args, cwd)
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

export function pullRequestMergeArgs(number: number, method: GitHubMergeMethod): string[] {
  assertPullRequestNumber(number)
  if (!['merge', 'squash', 'rebase'].includes(method)) throw new Error('Unsupported pull request merge method')
  return ['pr', 'merge', String(number), `--${method}`]
}

function assertPullRequestNumber(number: number): void {
  if (!Number.isInteger(number) || number < 1) throw new Error('Pull request number must be a positive integer')
}

export function pullRequestActionArgs(action: 'approve' | 'update-branch' | 'close', number: number): string[] {
  assertPullRequestNumber(number)
  if (action === 'approve') return ['pr', 'review', String(number), '--approve']
  return ['pr', action, String(number)]
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
  const fields = 'number,title,state,url,isDraft,author,body,headRefName,baseRefName,mergeStateStatus,reviewDecision,additions,deletions,files,commits,comments,reviews,statusCheckRollup'
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
    return {
      number: Number(raw.number), title: String(raw.title ?? ''), state: raw.state as GitHubPullRequestDetail['state'],
      url: String(raw.url ?? ''), isDraft: raw.isDraft === true, author: String(raw.author?.login ?? ''), body: String(raw.body ?? ''),
      head: String(raw.headRefName ?? ''), base: String(raw.baseRefName ?? ''), mergeStateStatus: String(raw.mergeStateStatus ?? 'UNKNOWN'),
      reviewDecision: raw.reviewDecision == null ? null : String(raw.reviewDecision), additions: Number(raw.additions ?? 0), deletions: Number(raw.deletions ?? 0),
      files: (Array.isArray(raw.files) ? raw.files : []).map((file: Record<string, unknown>) => ({ path: String(file.path ?? ''), additions: Number(file.additions ?? 0), deletions: Number(file.deletions ?? 0) })),
      commits, comments, checks: (Array.isArray(raw.statusCheckRollup) ? raw.statusCheckRollup : []).map((check: Record<string, unknown>) => normalizeCheck(check)),
    }
  } catch { return { error: `GitHub returned malformed pull request data for #${number}` } }
}

export async function getPullRequestDiff(
  cwd: string,
  number: number,
  runCommand: GitHubCommandRunner = runGitHubCommand,
): Promise<{ ok: boolean; patch: string; error?: string }> {
  if (/^ssh:\/\//i.test(cwd)) return { ok: false, patch: '', error: 'Pull-request review is not available for SSH workspaces yet' }
  try { assertPullRequestNumber(number) } catch (error) { return { ok: false, patch: '', error: error instanceof Error ? error.message : String(error) } }
  const result = await runCommand('gh', ['pr', 'diff', String(number), '--patch'], cwd)
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

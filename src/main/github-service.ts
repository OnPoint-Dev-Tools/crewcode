import { execFile, spawnSync } from 'child_process'

interface GitHubPullRequest {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  branch: string
  url: string
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

export function runGh(cwd: string, args: string[]): { ok: boolean; output: string; error?: string } {
  if (!ghAvailable()) return { ok: false, output: '', error: 'gh CLI not found in PATH' }
  const result = spawnSync('gh', args, { cwd, encoding: 'utf8', windowsHide: true })
  const output = ((result.stdout ?? '') + (result.stderr ?? '')).trim()
  if (result.status !== 0) return { ok: false, output, error: output || `gh ${args.join(' ')} failed` }
  return { ok: true, output }
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
    runCommand('gh', ['pr', 'list', '--json', 'number,title,headRefName,state,url', '--limit', '20'], cwd),
    runCommand('gh', ['run', 'list', '--json', 'databaseId,name,status,conclusion,headBranch', '--limit', '10'], cwd),
    runCommand('gh', ['issue', 'list', '--state', 'open', '--json', 'number', '--limit', '100'], cwd),
  ])

  let prs: GitHubPullRequest[] = []
  if (prResult.status === 0 && prResult.stdout) {
    try {
      const raw = JSON.parse(prResult.stdout) as Array<{ number: number; title: string; headRefName: string; state: string; url: string }>
      prs = raw.map(pr => ({ number: pr.number, title: pr.title, state: pr.state as GitHubPullRequest['state'], branch: pr.headRefName, url: pr.url }))
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

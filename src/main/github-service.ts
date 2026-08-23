import { spawnSync } from 'child_process'

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

export function ghAvailable(): boolean {
  try {
    return spawnSync('gh', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0
  } catch {
    return false
  }
}

export function getGhStatus(): GhStatusResult {
  if (!ghAvailable()) return { available: false, loggedIn: false, user: null, host: null, raw: '', error: 'gh CLI not found in PATH' }
  const result = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', windowsHide: true })
  const raw = (result.stdout ?? '') + (result.stderr ?? '')
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

export function getGitHubStatus(cwd: string): HeadlessGitHubStatus | { error: string } {
  if (!ghAvailable()) return { error: 'gh CLI not found' }
  const remoteResult = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', windowsHide: true })
  const remoteUrl = remoteResult.stdout?.trim() ?? ''
  if (!remoteUrl.includes('github.com')) return { error: 'not a GitHub repo' }
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/)
  if (!match) return { error: 'could not parse GitHub remote URL' }
  const [, owner, repo] = match

  let prs: GitHubPullRequest[] = []
  const prResult = spawnSync('gh', ['pr', 'list', '--json', 'number,title,headRefName,state,url', '--limit', '20'], { cwd, encoding: 'utf8', windowsHide: true })
  if (prResult.status === 0 && prResult.stdout) {
    try {
      const raw = JSON.parse(prResult.stdout) as Array<{ number: number; title: string; headRefName: string; state: string; url: string }>
      prs = raw.map(pr => ({ number: pr.number, title: pr.title, state: pr.state as GitHubPullRequest['state'], branch: pr.headRefName, url: pr.url }))
    } catch { /* malformed gh output produces an empty section */ }
  }

  let runs: GitHubRun[] = []
  const runResult = spawnSync('gh', ['run', 'list', '--json', 'databaseId,name,status,conclusion,headBranch', '--limit', '10'], { cwd, encoding: 'utf8', windowsHide: true })
  if (runResult.status === 0 && runResult.stdout) {
    try {
      const raw = JSON.parse(runResult.stdout) as Array<{ databaseId: number; name: string; status: string; conclusion: string | null; headBranch: string }>
      runs = raw.map(run => ({ id: run.databaseId, name: run.name, status: run.status as GitHubRun['status'], conclusion: run.conclusion as GitHubRun['conclusion'], branch: run.headBranch }))
    } catch { /* malformed gh output produces an empty section */ }
  }

  let issues = 0
  const issueResult = spawnSync('gh', ['issue', 'list', '--state', 'open', '--json', 'number', '--limit', '100'], { cwd, encoding: 'utf8', windowsHide: true })
  if (issueResult.status === 0 && issueResult.stdout) {
    try { issues = (JSON.parse(issueResult.stdout) as unknown[]).length } catch { /* keep zero */ }
  }
  return { owner, repo, prs, runs, issues }
}

import type { SuggestedCrewCheck } from './crew-verification'

export interface IntegrationLane {
  laneId: string
  label: string
  branch: string
  head: string
  worktreePath: string
  files: string[]
}

export interface IntegrationCheckResult {
  id: string
  label: string
  command: string
  script: string
  status: 'running' | 'passed' | 'failed' | 'interrupted'
  output: string
}

export interface CrewIntegrationRequest {
  repoPath: string
  integrationPath: string
  integrationCwd: string
  baseBranch: string
  baseHead: string
  lanes: IntegrationLane[]
  retentionRef: string
}

export type CrewIntegrationResult =
  | { ok: true; status: 'passed'; integrationHead: string; checks: IntegrationCheckResult[] }
  | { ok: false; status: 'stale'; error: string }
  | { ok: false; status: 'dirty'; files: string[]; error: string }
  | { ok: false; status: 'conflict'; laneId: string; branch: string; conflicts: string[]; error: string }
  | { ok: false; status: 'checks-failed'; checks: IntegrationCheckResult[]; error: string }
  | { ok: false; status: 'error'; error: string }

export interface IntegrationGitResult { code: number; stdout: string; stderr: string }
export type IntegrationGitRunner = (cwd: string, args: string[]) => Promise<IntegrationGitResult>
export type IntegrationCheckDiscovery = (cwd: string) => Promise<SuggestedCrewCheck[]>
export type IntegrationCheckRunner = (cwd: string, check: SuggestedCrewCheck) => Promise<{ code: number; output: string }>

const paths = (stdout: string): string[] => stdout.split('\n').map(line => line.trim()).filter(Boolean)

async function cleanup(request: CrewIntegrationRequest, run: IntegrationGitRunner): Promise<void> {
  await run(request.repoPath, ['worktree', 'remove', '--force', request.integrationPath])
  await run(request.repoPath, ['worktree', 'prune'])
}

/**
 * Build and check an exact candidate integration in a detached disposable
 * worktree. The base checkout is read-only throughout. A successful candidate is
 * retained by an internal ref so the exact checked commit can later fast-forward
 * the base atomically after another stale/dirty check.
 */
export async function verifyCrewIntegration(
  request: CrewIntegrationRequest,
  run: IntegrationGitRunner,
  discoverChecks: IntegrationCheckDiscovery,
  runCheck: IntegrationCheckRunner,
  onProgress?: (phase: 'combining' | 'checking') => void,
  onCheck?: (check: IntegrationCheckResult) => void,
): Promise<CrewIntegrationResult> {
  if (!request.lanes.length) return { ok: false, status: 'error', error: 'no lane commits to verify' }

  const dirty = await run(request.repoPath, ['status', '--porcelain'])
  if (dirty.code !== 0) return { ok: false, status: 'error', error: dirty.stderr.trim() || 'could not read base status' }
  const dirtyFiles = paths(dirty.stdout).map(line => line.slice(3).trim()).filter(file => file && file !== '.worktrees/' && !file.startsWith('.worktrees/'))
  if (dirtyFiles.length) return { ok: false, status: 'dirty', files: dirtyFiles, error: 'base checkout must be clean before integration verification' }

  const checkedOut = await run(request.repoPath, ['symbolic-ref', '--short', 'HEAD'])
  if (checkedOut.code !== 0 || checkedOut.stdout.trim() !== request.baseBranch) {
    return { ok: false, status: 'stale', error: `base checkout must have ${request.baseBranch} checked out` }
  }
  const base = await run(request.repoPath, ['rev-parse', request.baseBranch])
  if (base.code !== 0 || base.stdout.trim() !== request.baseHead) {
    return { ok: false, status: 'stale', error: `${request.baseBranch} moved; refresh and verify the new candidate` }
  }
  for (const lane of request.lanes) {
    const tip = await run(request.repoPath, ['rev-parse', lane.branch])
    if (tip.code !== 0 || tip.stdout.trim() !== lane.head) {
      return { ok: false, status: 'stale', error: `${lane.branch} moved; refresh and verify the new candidate` }
    }
  }

  await run(request.repoPath, ['update-ref', '-d', request.retentionRef])
  await cleanup(request, run)
  const add = await run(request.repoPath, ['worktree', 'add', '--detach', request.integrationPath, request.baseHead])
  if (add.code !== 0) return { ok: false, status: 'error', error: add.stderr.trim() || 'could not create integration worktree' }

  let retained = false
  try {
    onProgress?.('combining')
    for (const lane of request.lanes) {
      const merge = await run(request.integrationCwd, [
        '-c', 'user.name=CrewCode Integration',
        '-c', 'user.email=integration@crewcode.local',
        '-c', 'commit.gpgsign=false',
        'merge', '--no-edit', '--no-ff', lane.head,
      ])
      if (merge.code !== 0) {
        const conflicted = await run(request.integrationCwd, ['diff', '--name-only', '--diff-filter=U'])
        return {
          ok: false, status: 'conflict', laneId: lane.laneId, branch: lane.branch,
          conflicts: paths(conflicted.stdout),
          error: merge.stderr.trim() || `integration conflict while combining ${lane.branch}`,
        }
      }
    }

    onProgress?.('checking')
    const checks = await discoverChecks(request.integrationCwd)
    const results: IntegrationCheckResult[] = []
    for (const check of checks) {
      const running: IntegrationCheckResult = {
        id: check.id, label: check.label,
        command: [check.command, ...check.args].join(' '), script: check.script,
        status: 'running', output: '',
      }
      onCheck?.(running)
      const result = await runCheck(request.integrationCwd, check)
      const finished: IntegrationCheckResult = {
        ...running, status: result.code === 0 ? 'passed' : 'failed', output: result.output,
      }
      results.push(finished)
      onCheck?.(finished)
    }
    if (results.some(check => check.status === 'failed')) {
      return { ok: false, status: 'checks-failed', checks: results, error: 'combined integration checks failed' }
    }

    const head = await run(request.integrationCwd, ['rev-parse', 'HEAD'])
    if (head.code !== 0 || !head.stdout.trim()) return { ok: false, status: 'error', error: 'could not identify checked integration commit' }
    const integrationHead = head.stdout.trim()
    const retain = await run(request.repoPath, ['update-ref', request.retentionRef, integrationHead])
    if (retain.code !== 0) return { ok: false, status: 'error', error: retain.stderr.trim() || 'could not retain checked integration commit' }
    retained = true
    return { ok: true, status: 'passed', integrationHead, checks: results }
  } finally {
    await cleanup(request, run)
    if (!retained) await run(request.repoPath, ['update-ref', '-d', request.retentionRef])
  }
}

export async function applyCrewIntegration(
  request: Pick<CrewIntegrationRequest, 'repoPath' | 'baseBranch' | 'baseHead' | 'lanes' | 'retentionRef'> & { integrationHead: string },
  run: IntegrationGitRunner,
): Promise<{ ok: true } | { ok: false; status: 'dirty' | 'stale' | 'error'; error: string }> {
  const dirty = await run(request.repoPath, ['status', '--porcelain'])
  if (dirty.code !== 0) return { ok: false, status: 'error', error: dirty.stderr.trim() || 'could not read base status' }
  const dirtyFiles = paths(dirty.stdout).map(line => line.slice(3).trim()).filter(file => file && file !== '.worktrees/' && !file.startsWith('.worktrees/'))
  if (dirtyFiles.length) return { ok: false, status: 'dirty', error: 'base checkout changed after verification' }

  const checkedOut = await run(request.repoPath, ['symbolic-ref', '--short', 'HEAD'])
  if (checkedOut.code !== 0 || checkedOut.stdout.trim() !== request.baseBranch) return { ok: false, status: 'stale', error: `base checkout no longer has ${request.baseBranch} checked out` }
  const base = await run(request.repoPath, ['rev-parse', request.baseBranch])
  if (base.code !== 0 || base.stdout.trim() !== request.baseHead) return { ok: false, status: 'stale', error: `${request.baseBranch} moved after verification` }
  for (const lane of request.lanes) {
    const tip = await run(request.repoPath, ['rev-parse', lane.branch])
    if (tip.code !== 0 || tip.stdout.trim() !== lane.head) return { ok: false, status: 'stale', error: `${lane.branch} moved after verification` }
  }
  const retained = await run(request.repoPath, ['rev-parse', request.retentionRef])
  if (retained.code !== 0 || retained.stdout.trim() !== request.integrationHead) {
    return { ok: false, status: 'stale', error: 'the checked integration commit is no longer available' }
  }
  const merge = await run(request.repoPath, ['merge', '--ff-only', request.integrationHead])
  if (merge.code !== 0) return { ok: false, status: 'error', error: merge.stderr.trim() || 'could not apply checked integration' }
  await run(request.repoPath, ['update-ref', '-d', request.retentionRef])
  return { ok: true }
}

import type { SuggestedCrewCheck } from './crew-verification'

export interface IntegrationLane {
  laneId: string
  label: string
  branch: string
  head: string
  worktreePath: string
  files: string[]
}

export interface IntegrationCheckExecution {
  token: string
  pid?: number
  pidFile?: string
  state: 'running' | 'exited' | 'unknown'
  checkedAt?: number
  detail?: string
}

export interface IntegrationCheckResult {
  id: string
  label: string
  command: string
  script: string
  status: 'running' | 'passed' | 'failed' | 'interrupted'
  output: string
  execution?: IntegrationCheckExecution
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
export type IntegrationCheckRunner = (
  cwd: string,
  check: SuggestedCrewCheck,
  onExecution?: (execution: IntegrationCheckExecution) => void,
) => Promise<{ code: number; output: string }>

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

  // Verification only reads the committed base SHA and builds in a disposable
  // worktree. Uncommitted files in the user's checkout cannot affect that tree,
  // so they must not prevent producing verification evidence.
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
        const conflicts = paths(conflicted.stdout)
        const details = [merge.stdout.trim(), merge.stderr.trim()].filter(Boolean).join('\n')
        return {
          ok: false, status: 'conflict', laneId: lane.laneId, branch: lane.branch,
          conflicts,
          error: `Could not combine ${lane.branch}${conflicts.length ? `; conflicted files: ${conflicts.join(', ')}` : ''}.${details ? `\n${details}` : ''}`,
        }
      }
    }

    onProgress?.('checking')
    const checks = await discoverChecks(request.integrationCwd)
    const results: IntegrationCheckResult[] = []
    for (const check of checks) {
      let running: IntegrationCheckResult = {
        id: check.id, label: check.label,
        command: [check.command, ...check.args].join(' '), script: check.script,
        status: 'running', output: '',
      }
      onCheck?.(running)
      const result = await runCheck(request.integrationCwd, check, execution => {
        running = { ...running, execution }
        onCheck?.(running)
      })
      const finished: IntegrationCheckResult = {
        ...running, status: result.code === 0 ? 'passed' : 'failed', output: result.output,
        execution: running.execution ? { ...running.execution, state: 'exited', checkedAt: Date.now(), detail: 'check process exited' } : undefined,
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
): Promise<{ ok: true; warning?: string } | { ok: false; status: 'stale' | 'error'; error: string }> {
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

  const status = await run(request.repoPath, ['status', '--porcelain'])
  if (status.code !== 0) return { ok: false, status: 'error', error: status.stderr.trim() || 'could not read base status' }
  const dirtyFiles = paths(status.stdout)
    .map(line => line.slice(3).trim())
    .filter(file => file && file !== '.worktrees/' && !file.startsWith('.worktrees/'))
  let stashHead = ''
  if (dirtyFiles.length) {
    const stash = await run(request.repoPath, ['stash', 'push', '--include-untracked', '--message', `CrewCode integration ${request.integrationHead.slice(0, 10)}`])
    if (stash.code !== 0) return { ok: false, status: 'error', error: stash.stderr.trim() || 'could not temporarily preserve base checkout changes' }
    const saved = await run(request.repoPath, ['rev-parse', 'refs/stash'])
    if (saved.code !== 0 || !saved.stdout.trim()) return { ok: false, status: 'error', error: 'could not identify the temporary recovery stash' }
    stashHead = saved.stdout.trim()
  }

  const restore = async (): Promise<string | null> => {
    if (!stashHead) return null
    // `stash pop` requires a reflog selector rather than a raw stash commit.
    // Confirm the top entry is still ours before touching it, so concurrent user
    // activity cannot cause CrewCode to restore or drop the wrong stash.
    const current = await run(request.repoPath, ['rev-parse', 'refs/stash'])
    if (current.code !== 0 || current.stdout.trim() !== stashHead) {
      return `recovery stash ${stashHead} is no longer the top stash entry; it was left untouched`
    }
    const pop = await run(request.repoPath, ['stash', 'pop', '--index', 'stash@{0}'])
    return pop.code === 0 ? null : (pop.stderr.trim() || pop.stdout.trim() || `restore the retained stash ${stashHead}`)
  }

  const merge = await run(request.repoPath, ['merge', '--ff-only', request.integrationHead])
  if (merge.code !== 0) {
    const restoreError = await restore()
    return {
      ok: false, status: 'error',
      error: `${merge.stderr.trim() || 'could not apply checked integration'}${restoreError ? `; base changes remain recoverable in stash ${stashHead}: ${restoreError}` : ''}`,
    }
  }
  await run(request.repoPath, ['update-ref', '-d', request.retentionRef])
  const restoreError = await restore()
  return restoreError
    ? { ok: true, warning: `Integration was applied, but base changes could not be restored cleanly. Resolve the checkout conflicts; recovery stash ${stashHead} was retained. ${restoreError}` }
    : { ok: true }
}

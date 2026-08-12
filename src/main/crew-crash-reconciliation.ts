import { readFileSync } from 'fs'
import type { IntegrationCheckExecution, IntegrationGitRunner } from './crew-integration-verification'

export interface AppliedCheckoutValidation {
  ok: boolean
  error?: string
}

/** Probe a local PID without accepting the numeric PID alone as ownership. */
export function probeLocalCheckExecution(execution: IntegrationCheckExecution, now = Date.now()): IntegrationCheckExecution {
  if (!execution.pid) return { ...execution, state: 'unknown', checkedAt: now, detail: 'local process PID was not recorded' }
  try {
    if (process.platform === 'linux') {
      const environment = readFileSync(`/proc/${execution.pid}/environ`, 'utf8').split('\0')
      return environment.includes(`CREWCODE_CHECK_TOKEN=${execution.token}`)
        ? { ...execution, state: 'running', checkedAt: now, detail: 'local PID is alive and its custody token matches' }
        : { ...execution, state: 'unknown', checkedAt: now, detail: 'local PID exists but its custody token does not match' }
    }
    process.kill(execution.pid, 0)
    return { ...execution, state: 'unknown', checkedAt: now, detail: 'PID is alive, but this platform cannot verify its custody token' }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ESRCH'
      ? { ...execution, state: 'exited', checkedAt: now, detail: 'local check process is no longer running' }
      : { ...execution, state: 'unknown', checkedAt: now, detail: `local liveness probe failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * A matching branch ref alone is not enough to call a crashed apply successful:
 * HEAD must be attached to that branch and both the index and worktree must be
 * clean. This deliberately uses Git evidence rather than the prior subprocess
 * state, which disappeared with the old main process.
 */
export async function validateAppliedCheckout(
  repoPath: string,
  baseBranch: string,
  integrationHead: string,
  run: IntegrationGitRunner,
): Promise<AppliedCheckoutValidation> {
  const branch = await run(repoPath, ['symbolic-ref', '--short', 'HEAD'])
  if (branch.code !== 0 || branch.stdout.trim() !== baseBranch) {
    return { ok: false, error: `base ref reached ${integrationHead.slice(0, 10)}, but HEAD is not attached to ${baseBranch}` }
  }

  const head = await run(repoPath, ['rev-parse', 'HEAD'])
  if (head.code !== 0 || head.stdout.trim() !== integrationHead) {
    return { ok: false, error: 'base branch and checked-out HEAD do not identify the same integration commit' }
  }

  const status = await run(repoPath, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status.code !== 0) return { ok: false, error: status.stderr.trim() || 'could not validate the post-apply checkout and index' }
  const dirty = status.stdout.split('\n').map(line => line.trimEnd()).filter(Boolean)
  if (dirty.length) {
    return { ok: false, error: `base ref reached the integration commit, but the checkout or index is not clean: ${dirty.join(', ')}` }
  }

  const mergeHead = await run(repoPath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
  if (mergeHead.code === 0 && mergeHead.stdout.trim()) {
    return { ok: false, error: 'base ref reached the integration commit, but Git still reports an unfinished merge' }
  }
  return { ok: true }
}

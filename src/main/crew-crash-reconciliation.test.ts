import { spawn } from 'child_process'
import { describe, expect, it, vi } from 'vitest'
import { probeLocalCheckExecution, validateAppliedCheckout } from './crew-crash-reconciliation'
import type { IntegrationGitRunner } from './crew-integration-verification'

function runner(overrides: Record<string, { code: number; stdout?: string; stderr?: string }> = {}): IntegrationGitRunner {
  return vi.fn(async (_cwd, args) => {
    const key = args.join(' ')
    const value = overrides[key] ?? (
      key === 'symbolic-ref --short HEAD' ? { code: 0, stdout: 'main\n' }
        : key === 'rev-parse HEAD' ? { code: 0, stdout: 'integrated\n' }
          : key === 'status --porcelain=v1 --untracked-files=all' ? { code: 0, stdout: '' }
            : key === 'rev-parse -q --verify MERGE_HEAD' ? { code: 1, stdout: '' }
              : { code: 1, stdout: '', stderr: 'unexpected command' }
    )
    return { stdout: '', stderr: '', ...value }
  })
}

describe('check process liveness reconciliation', () => {
  it('requires the custody token instead of trusting a live numeric PID', async () => {
    const token = `probe-${Date.now()}`
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      env: { ...process.env, CREWCODE_CHECK_TOKEN: token },
      stdio: 'ignore',
    })
    expect(child.pid).toBeTruthy()
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      const matched = probeLocalCheckExecution({ token, pid: child.pid, state: 'unknown' }, 100)
      expect(matched.state).toBe(process.platform === 'linux' ? 'running' : 'unknown')
      const reused = probeLocalCheckExecution({ token: 'different-token', pid: child.pid, state: 'unknown' }, 101)
      expect(reused.state).toBe('unknown')
    } finally {
      child.kill('SIGKILL')
      await new Promise<void>(resolve => child.once('exit', () => resolve()))
    }
    expect(probeLocalCheckExecution({ token, pid: child.pid, state: 'unknown' }, 102).state).toBe('exited')
  })
})

describe('post-crash integration checkout validation', () => {
  it('accepts an attached, clean checkout with a clean index and no merge state', async () => {
    await expect(validateAppliedCheckout('/repo', 'main', 'integrated', runner())).resolves.toEqual({ ok: true })
  })

  it('does not infer applied when the branch ref moved but another checkout is attached', async () => {
    const result = await validateAppliedCheckout('/repo', 'main', 'integrated', runner({
      'symbolic-ref --short HEAD': { code: 0, stdout: 'other\n' },
    }))
    expect(result).toMatchObject({ ok: false })
    expect(result.error).toContain('HEAD is not attached')
  })

  it('rejects staged, unstaged, or untracked post-crash state', async () => {
    const result = await validateAppliedCheckout('/repo', 'main', 'integrated', runner({
      'status --porcelain=v1 --untracked-files=all': { code: 0, stdout: 'M  staged.ts\n M worktree.ts\n?? unknown.ts\n' },
    }))
    expect(result).toMatchObject({ ok: false })
    expect(result.error).toContain('checkout or index is not clean')
    expect(result.error).toContain('staged.ts')
  })

  it('rejects a leftover merge state', async () => {
    const result = await validateAppliedCheckout('/repo', 'main', 'integrated', runner({
      'rev-parse -q --verify MERGE_HEAD': { code: 0, stdout: 'merge-head\n' },
    }))
    expect(result.error).toContain('unfinished merge')
  })
})

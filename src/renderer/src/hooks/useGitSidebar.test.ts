import { afterEach, describe, expect, it, vi } from 'vitest'

import { act, flush, renderHook } from './hook-test-host'
import { useGitSidebar } from './useGitSidebar'

function apiStub() {
  return {
    worktreeCreate: vi.fn(async () => ({ ok: true, path: '/repo/.worktrees/feature' })),
    worktreeList: vi.fn(async () => ({ worktrees: [
      { id: 'feature-wt', path: '/repo/.worktrees/feature', branch: 'feature', head: 'abc', locked: false, dirty: 0 },
    ] })),
    gitCheckout: vi.fn(async () => ({ ok: true })),
    gitStatus: vi.fn(async () => ({ branch: 'main', staged: [], unstaged: [], untracked: [], ahead: 0, behind: 0 })),
    gitLog: vi.fn(async () => ({ commits: [] })),
    gitBranches: vi.fn(async () => ({ branches: [] })),
    ghStatus: vi.fn(async () => ({})),
    gitRemotes: vi.fn(async () => ({ isRepo: true, remotes: [], remoteUrls: [] })),
  }
}

describe('useGitSidebar isolated branch switching', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('opens a new branch in a worktree instead of checking out the shared directory', async () => {
    const api = apiStub()
    vi.stubGlobal('window', { electronAPI: api })
    const onSwitchWorktree = vi.fn()
    const onWorktreesChanged = vi.fn(async () => {})
    const hook = renderHook(useGitSidebar, {
      repoPath: '/repo',
      workspacePath: '/repo',
      mainBranch: 'main',
      currentWorktreeId: null,
      enabled: false,
      onSwitchWorktree,
      onWorktreesChanged,
    })

    act(() => hook.result.current.handlers.onCheckoutBranch?.('feature'))
    await flush()

    expect(api.worktreeCreate).toHaveBeenCalledWith('/repo', 'feature', undefined, undefined)
    expect(api.gitCheckout).not.toHaveBeenCalled()
    expect(onWorktreesChanged).toHaveBeenCalled()
    expect(onSwitchWorktree).toHaveBeenCalledWith('feature-wt')

    hook.unmount()
  })
})

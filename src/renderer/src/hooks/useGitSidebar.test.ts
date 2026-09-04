import { afterEach, describe, expect, it, vi } from 'vitest'

import { act, flush, renderHook } from './hook-test-host'
import { useGitSidebar } from './useGitSidebar'
import { NotificationsProvider, useNotifications } from './useNotifications'

vi.mock('../runtime/crewcode-client', () => ({
  getCrewCodeClient: () => window.electronAPI,
}))

function apiStub(): Record<string, any> {
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
    githubStatus: vi.fn(async () => ({})),
    githubPrCatalogue: vi.fn(async () => ({ viewer: 'viewer', items: [] })),
    gitRemotes: vi.fn(async () => ({ isRepo: true, remotes: [], remoteUrls: [] })),
    gitChangesVsRef: vi.fn(async () => ({ ok: true, files: [] })),
    gitPush: vi.fn(async () => ({ ok: true })),
  }
}

describe('useGitSidebar isolated branch switching', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

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

  it('adds committed comparison changes without making them stageable', async () => {
    const api = apiStub()
    api.gitStatus.mockResolvedValue({
      branch: 'feature', staged: [],
      unstaged: [{ path: 'local.ts', status: 'M', staged: false }],
      untracked: [], ahead: 1, behind: 0,
    })
    api.gitChangesVsRef.mockResolvedValue({
      ok: true,
      files: [
        { path: 'local.ts', status: 'M', staged: false },
        { path: 'committed.ts', status: 'A', staged: false },
      ],
    })
    vi.stubGlobal('window', { electronAPI: api })
    const hook = renderHook(useGitSidebar, {
      repoPath: '/repo/.worktrees/feature',
      workspacePath: '/repo',
      mainBranch: 'main',
      comparisonRef: 'develop',
      currentWorktreeId: 'feature-wt',
      enabled: false,
      onSwitchWorktree: vi.fn(),
    })

    await act(async () => { await hook.result.current.refresh() })

    expect(api.gitChangesVsRef).toHaveBeenCalledWith('/repo/.worktrees/feature', 'develop')
    expect(hook.result.current.state.comparisonRef).toBe('develop')
    expect(hook.result.current.state.changes).toEqual([
      expect.objectContaining({ path: 'local.ts', staged: false }),
      expect.objectContaining({ path: 'committed.ts', staged: false, stageable: false }),
    ])
    hook.unmount()
  })

  it('publishes successful user-triggered Git actions as live notifications', async () => {
    const api = apiStub()
    api.gitStatus.mockResolvedValue({ branch: 'dev', staged: [], unstaged: [], untracked: [], ahead: 1, behind: 0 })
    vi.stubGlobal('window', { electronAPI: api })
    const hook = renderHook((props: Parameters<typeof useGitSidebar>[0]) => ({
      git: useGitSidebar(props),
      notices: useNotifications().notices,
    }), {
      repoPath: '/repo',
      workspacePath: '/repo',
      mainBranch: 'main',
      currentWorktreeId: null,
      enabled: false,
      onSwitchWorktree: vi.fn(),
    }, NotificationsProvider)

    await act(async () => { await hook.result.current.git.refresh() })
    act(() => hook.result.current.git.handlers.onPush?.())
    await flush()

    expect(api.gitPush).toHaveBeenCalledWith('/repo')
    expect(hook.result.current.notices[0]).toMatchObject({ type: 'success', message: 'Git: pushed on dev' })
    hook.unmount()
  })

  it('silently refreshes pull requests created outside CrewCode', async () => {
    vi.useFakeTimers()
    const api = apiStub()
    api.githubStatus.mockResolvedValue({ owner: 'crew', repo: 'code', prs: [], runs: [] })
    api.githubPrCatalogue.mockResolvedValue({
      viewer: 'viewer',
      items: [{
        number: 12,
        title: 'External contribution',
        state: 'OPEN',
        url: 'https://github.com/crew/code/pull/12',
        isDraft: false,
        author: 'another-user',
        body: 'Created on GitHub',
        head: 'contributor/fix',
        base: 'main',
        createdAt: '2026-09-04T10:00:00Z',
        updatedAt: '2026-09-04T10:00:00Z',
        reviewDecision: null,
        assignees: [],
        reviewers: [],
        labels: [],
      }],
    })
    vi.stubGlobal('window', { electronAPI: api })
    const hook = renderHook(useGitSidebar, {
      repoPath: '/repo',
      workspacePath: '/repo',
      mainBranch: 'main',
      currentWorktreeId: null,
      enabled: true,
      onSwitchWorktree: vi.fn(),
    })

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })

    expect(api.githubPrCatalogue).toHaveBeenCalledWith('/repo')
    expect(hook.result.current.state.prs).toEqual([
      expect.objectContaining({ num: 12, author: 'another-user', status: 'open' }),
    ])
    hook.unmount()
    vi.useRealTimers()
  })
})

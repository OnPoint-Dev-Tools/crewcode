import { describe, it, expect, vi } from 'vitest'

import { renderHook, act } from './hook-test-host'
import { useCrewSession } from './useCrewSession'
import type { CrewGitDriver, CrewAgentLane } from '../orchestrator/crew-session'

const TAB = 'tab1'

/** A git driver that always succeeds, allocating a worktree id per branch. */
function okGit(): CrewGitDriver & { provisionLane: ReturnType<typeof vi.fn>; archiveLane: ReturnType<typeof vi.fn> } {
  let n = 0
  return {
    provisionLane: vi.fn(async (_ws: string, branch: string) => {
      n += 1
      return { worktreeId: `wt-${n}`, path: `/repo/.worktrees/${branch}` }
    }),
    archiveLane: vi.fn(async () => ({ ok: true as const })),
  }
}

function mount(git: CrewGitDriver, onReleaseLane?: (l: CrewAgentLane) => void) {
  return renderHook(
    (p: { git: CrewGitDriver; onReleaseLane?: (l: CrewAgentLane) => void }) =>
      useCrewSession(p),
    { git, onReleaseLane },
  )
}

describe('useCrewSession — isolated + git launch', () => {
  it('provisions a worktree per lane via the git driver, then activates', async () => {
    const git = okGit()
    const h = mount(git)

    await act(async () => {
      h.result.current.begin({ wsId: 'ws1', hostTabId: TAB, basePath: '/repo', baseBranch: 'main' })
      h.result.current.addLane(TAB, 'pi')
      h.result.current.addLane(TAB, 'codex')
    })

    await act(async () => { await h.result.current.launch(TAB) })

    const s = h.result.current.sessions[TAB]
    expect(s.state).toBe('active')
    expect(git.provisionLane).toHaveBeenCalledTimes(2)
    expect(s.lanes.every(l => l.status === 'ready')).toBe(true)
    expect(s.lanes.map(l => l.worktreeId)).toEqual(['wt-1', 'wt-2'])
    h.unmount()
  })

  it('forks each isolated lane onto its own derived branch from baseBranch', async () => {
    const git = okGit()
    const h = mount(git)
    await act(async () => {
      h.result.current.begin({ wsId: 'ws1', hostTabId: TAB, basePath: '/repo', baseBranch: 'main' })
      h.result.current.addLane(TAB, 'pi')
    })
    await act(async () => { await h.result.current.launch(TAB) })

    // provisionLane is called (wsId, branch, fromRef=baseBranch).
    const [, branch, fromRef] = git.provisionLane.mock.calls[0]
    expect(branch).toMatch(/^crew\//)
    expect(fromRef).toBe('main')
    h.unmount()
  })

  it('marks the session error and surfaces the message when a lane fails to provision', async () => {
    const git: CrewGitDriver = {
      provisionLane: vi.fn(async () => ({ error: 'worktree add failed' })),
      archiveLane: vi.fn(async () => ({ ok: true as const })),
    }
    const h = mount(git)
    await act(async () => {
      h.result.current.begin({ wsId: 'ws1', hostTabId: TAB, basePath: '/repo', baseBranch: 'main' })
      h.result.current.addLane(TAB, 'pi')
    })

    let res!: { ok: true } | { error: string }
    await act(async () => { res = await h.result.current.launch(TAB) })

    expect('error' in res && res.error).toContain('worktree add failed')
    expect(h.result.current.sessions[TAB].state).toBe('error')
    h.unmount()
  })
})

describe('useCrewSession — shared mode', () => {
  it('launches without touching the git driver (no worktrees to create)', async () => {
    const git = okGit()
    const h = mount(git)
    await act(async () => {
      h.result.current.begin({ wsId: 'ws1', hostTabId: TAB, basePath: '/repo', baseBranch: 'main', mode: 'shared' })
      h.result.current.addLane(TAB, 'pi')
      h.result.current.addLane(TAB, 'codex')
    })
    await act(async () => { await h.result.current.launch(TAB) })

    const s = h.result.current.sessions[TAB]
    expect(s.state).toBe('active')
    expect(git.provisionLane).not.toHaveBeenCalled()
    // Every shared lane points at the base path/branch.
    expect(s.lanes.every(l => l.path === '/repo' && l.branch === 'main')).toBe(true)
    h.unmount()
  })
})

describe('useCrewSession — archive & orphan prevention', () => {
  it('releases every lane agent before removing worktrees, then closes', async () => {
    const git = okGit()
    const released: string[] = []
    const h = mount(git, (l) => released.push(l.laneId))

    await act(async () => {
      h.result.current.begin({ wsId: 'ws1', hostTabId: TAB, basePath: '/repo', baseBranch: 'main' })
      h.result.current.addLane(TAB, 'pi')
      h.result.current.addLane(TAB, 'codex')
    })
    await act(async () => { await h.result.current.launch(TAB) })
    await act(async () => { await h.result.current.archive(TAB) })

    const s = h.result.current.sessions[TAB]
    expect(released).toHaveLength(2)               // both agents stopped
    expect(git.archiveLane).toHaveBeenCalledTimes(2)
    expect(s.state).toBe('closed')
    expect(s.lanes.every(l => l.status === 'done')).toBe(true)
    h.unmount()
  })

  it('discard archives a live crew and drops it from the registry', async () => {
    const git = okGit()
    const h = mount(git)
    await act(async () => {
      h.result.current.begin({ wsId: 'ws1', hostTabId: TAB, basePath: '/repo', baseBranch: 'main' })
      h.result.current.addLane(TAB, 'pi')
    })
    await act(async () => { await h.result.current.launch(TAB) })
    await act(async () => { await h.result.current.discard(TAB) })

    expect(h.result.current.sessions[TAB]).toBeUndefined()
    expect(git.archiveLane).toHaveBeenCalledTimes(1)
    h.unmount()
  })
})

describe('useCrewSession — registry & guards', () => {
  it('exposes provisioned lanes across all crews in the global roster', async () => {
    const git = okGit()
    const h = mount(git)
    await act(async () => {
      h.result.current.begin({ wsId: 'ws1', hostTabId: TAB, basePath: '/repo', baseBranch: 'main', mode: 'shared' })
      h.result.current.addLane(TAB, 'pi')
      h.result.current.addLane(TAB, 'codex')
    })
    await act(async () => { await h.result.current.launch(TAB) })

    expect(h.result.current.roster.map(r => r.agentId).sort()).toEqual(['codex', 'pi'])
    h.unmount()
  })

  it('refuses to begin a second crew on a tab that already hosts a live one', async () => {
    const git = okGit()
    const h = mount(git)
    let first!: string
    await act(async () => {
      const s = h.result.current.begin({ wsId: 'ws1', hostTabId: TAB, basePath: '/repo', baseBranch: 'main' })
      first = s.id
      h.result.current.addLane(TAB, 'pi')
    })
    await act(async () => { await h.result.current.launch(TAB) })

    let second!: string
    await act(async () => {
      // begin on the same tab returns the existing live session unchanged.
      second = h.result.current.begin({ wsId: 'ws1', hostTabId: TAB, basePath: '/repo', baseBranch: 'main' }).id
    })
    expect(second).toBe(first)
    h.unmount()
  })
})

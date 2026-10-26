import { afterEach, describe, expect, it, vi } from 'vitest'
import { flush, renderHook } from './hook-test-host'
import { useDelegatedThreads, type DelegatedThreadsDeps } from './useDelegatedThreads'
import type { DelegationRendererRequest, DelegationResult } from '../../../shared/delegation-types'
import type { Session } from '../types'

function mount(isolation: 'worktree' | 'shared') {
  const parent = { id: 'parent', tabId: 'chat', agentId: 'pi', model: 'm', delegationEnabled: true,
    delegationPlacement: { isolation, path: '/chosen-checkout', base: 'main' } } as Session
  let handler!: (request: DelegationRendererRequest & { id: string }) => void
  let answer!: (result: DelegationResult<unknown>) => void
  vi.stubGlobal('window', { electronAPI: {
    onDelegationRequest: (cb: typeof handler) => { handler = cb; return () => {} },
    delegationRespond: (_id: string, result: DelegationResult<unknown>) => answer(result),
  } })
  const deps: DelegatedThreadsDeps = {
    allSessions: () => [parent], tabIdForSession: () => 'chat', messagesForSession: () => [],
    isRunning: () => true, completedAtForSession: () => undefined,
    addDelegated: vi.fn(() => ({ ...parent, id: 'child', origin: 'delegated' as const })),
    sendToSession: vi.fn(async () => {}), setThreadClosed: vi.fn(), focusSession: vi.fn(),
    providers: () => [{ id: 'pi', name: 'Pi', available: true, models: ['m'] }],
    createWorktree: vi.fn(async () => ({ ok: true as const, path: '/isolated', branch: 'new-branch', base: 'main' })),
    repoPathForSession: () => '/repo', spawnCohort: () => ({ runId: 'one', duringWake: false }),
  }
  const hook = renderHook(() => useDelegatedThreads(deps), {})
  const create = (requested: 'worktree' | 'shared') => new Promise<DelegationResult<unknown>>(resolve => {
    answer = resolve
    handler({ id: 'request', kind: 'create', sessionId: 'parent', request: {
      title: 'task', prompt: 'do work', mode: 'build', isolation: requested,
    } })
  })
  return { deps, parent, create, unmount: hook.unmount }
}
afterEach(() => vi.unstubAllGlobals())
describe('delegation placement enforcement', () => {
  it('pins shared children to the chosen checkout even when the agent requests isolation', async () => {
    const h = mount('shared')
    expect((await h.create('worktree')).ok).toBe(true)
    expect(h.deps.createWorktree).not.toHaveBeenCalled()
    expect(h.deps.addDelegated).toHaveBeenCalledWith('chat', expect.objectContaining({ checkoutPath: '/chosen-checkout' }))
    h.unmount()
  })
  it('creates isolated children even when the agent requests the shared checkout', async () => {
    const h = mount('worktree')
    expect((await h.create('shared')).ok).toBe(true)
    expect(h.deps.createWorktree).toHaveBeenCalledWith('parent', 'task')
    expect(h.deps.addDelegated).toHaveBeenCalledWith('chat', expect.objectContaining({ worktreePath: '/isolated' }))
    h.unmount()
  })
  it('does not launch a child when interrupted during worktree creation', async () => {
    const h = mount('worktree')
    let finish!: (value: { ok: true; path: string; branch: string }) => void
    h.deps.createWorktree = () => new Promise(resolve => { finish = resolve })
    const result = h.create('shared')
    await flush()
    h.deps.isRunning = () => false
    finish({ ok: true, path: '/preserved', branch: 'preserved' })
    expect((await result).ok).toBe(false)
    expect(h.deps.addDelegated).not.toHaveBeenCalled()
    expect(h.deps.sendToSession).not.toHaveBeenCalled()
    h.unmount()
  })
  it('refuses creation before the owner has chosen placement', async () => {
    const h = mount('shared')
    h.parent.delegationPlacement = undefined
    expect((await h.create('shared')).ok).toBe(false)
    expect(h.deps.addDelegated).not.toHaveBeenCalled()
    h.unmount()
  })
})

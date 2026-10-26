import { describe, expect, it, vi } from 'vitest'
import { act, flush, renderHook } from './hook-test-host'
import { useDelegationPlacement } from './useDelegationPlacement'
import type { Session } from '../types'

const session = { id: 'parent', delegationEnabled: true } as Session
function mount() {
  const save = vi.fn()
  const hook = renderHook((props: { session: Session; path: string; branch: string }) =>
    useDelegationPlacement(props.session, props.path, props.branch, true, save),
    { session, path: '/repo', branch: 'main' })
  return { ...hook, save }
}

describe('CrewCode delegation placement', () => {
  it('holds the first send until the exact choice has been saved', async () => {
    const h = mount()
    const dispatched = vi.fn()
    let wait!: Promise<boolean>
    act(() => { wait = h.result.current.ensure(); void wait.then(ok => { if (ok) dispatched() }) })
    expect(h.result.current.request?.source).toBe('CrewCode')
    expect(dispatched).not.toHaveBeenCalled()
    act(() => h.result.current.respond({ requestId: h.result.current.request!.requestId, action: 'submit', optionId: 'worktree' }))
    expect(h.save).toHaveBeenCalledWith({ isolation: 'worktree', path: '/repo', base: 'main' })
    expect(dispatched).not.toHaveBeenCalled()
    h.rerender({ session: { ...session, delegationPlacement: h.save.mock.calls[0][0] }, path: '/repo', branch: 'main' })
    await flush()
    expect(await wait).toBe(true)
    expect(dispatched).toHaveBeenCalledOnce()
    expect(h.result.current.request).toBeNull()
    h.unmount()
  })

  it.each(['stop', 'session', 'path', 'branch', 'unmount', 'toggle', 'cancel'])(
    'withdraws the send on %s, without saving or dispatching', async reason => {
      const h = mount()
      let wait!: Promise<boolean>
      act(() => { wait = h.result.current.ensure() })
      if (reason === 'unmount') h.unmount()
      else if (reason === 'stop') act(() => h.result.current.cancel())
      else if (reason === 'cancel') act(() => h.result.current.respond({ requestId: h.result.current.request!.requestId, action: 'cancel' }))
      else h.rerender({
        session: reason === 'session' ? { ...session, id: 'other' } : reason === 'toggle' ? { ...session, delegationEnabled: false } : session,
        path: reason === 'path' ? '/other' : '/repo', branch: reason === 'branch' ? 'other' : 'main',
      })
      expect(await wait).toBe(false)
      expect(h.save).not.toHaveBeenCalled()
      if (reason !== 'unmount') h.unmount()
    },
  )

  it('reuses the session choice and asks again when its checkout changes', async () => {
    const h = mount()
    const saved: Session = { ...session, delegationPlacement: { isolation: 'shared', path: '/repo', base: 'main' } }
    h.rerender({ session: saved, path: '/repo', branch: 'main' })
    expect(await h.result.current.ensure()).toBe(true)
    h.rerender({ session: saved, path: '/other', branch: 'main' })
    let wait!: Promise<boolean>
    act(() => { wait = h.result.current.ensure() })
    expect(h.result.current.request).not.toBeNull()
    act(() => h.result.current.cancel())
    expect(await wait).toBe(false)
    h.unmount()
  })
})

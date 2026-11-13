import { describe, expect, it } from 'vitest'
import { act, renderHook } from './hook-test-host'
import { usePendingChatSend } from './usePendingChatSend'

describe('pending chat send UI', () => {
  it('clears the running indicator on Stop before the startup RPC settles', () => {
    const hook = renderHook(usePendingChatSend, 'chat')
    let token!: ReturnType<typeof hook.result.current.begin>
    act(() => { token = hook.result.current.begin() })
    expect(hook.result.current.pending).toBe(true)
    act(() => hook.result.current.cancel())
    expect(hook.result.current.pending).toBe(false)
    act(() => hook.result.current.finish(token))
    expect(hook.result.current.pending).toBe(false)
    hook.unmount()
  })

  it('does not let the stopped send clear a replacement send indicator', () => {
    const hook = renderHook(usePendingChatSend, 'chat')
    let stopped!: ReturnType<typeof hook.result.current.begin>
    let replacement!: ReturnType<typeof hook.result.current.begin>
    act(() => { stopped = hook.result.current.begin() })
    act(() => hook.result.current.cancel())
    act(() => { replacement = hook.result.current.begin() })
    act(() => hook.result.current.finish(stopped))
    expect(hook.result.current.pending).toBe(true)
    act(() => hook.result.current.finish(replacement))
    expect(hook.result.current.pending).toBe(false)
    hook.unmount()
  })

  it('does not show or cancel a hidden chat send in a different chat', () => {
    const hook = renderHook<string, ReturnType<typeof usePendingChatSend>>(usePendingChatSend, 'first')
    act(() => { hook.result.current.begin() })
    hook.rerender('second')
    expect(hook.result.current.pending).toBe(false)
    act(() => hook.result.current.cancel())
    hook.rerender('first')
    expect(hook.result.current.pending).toBe(true)
    hook.unmount()
  })
})

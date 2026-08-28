import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { NotificationsProvider } from './useNotifications'
import { bridgeRuntimeId, useBridgeRegistry } from './useBridgeRegistry'
import { bridgeActivity, useBridgeActivityStore } from '../stores/bridge-activity-store'

// The activity store is a module singleton — reset it so state can't leak.
beforeEach(() => { bridgeActivity.reset() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

function renderRegistry(setMessagesForTab = vi.fn()) {
  const result = { current: undefined as unknown as ReturnType<typeof useBridgeRegistry> }

  function Probe(): null {
    result.current = useBridgeRegistry({ setMessagesForTab })
    return null
  }

  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      createElement(NotificationsProvider, null, createElement(Probe)),
    )
  })

  return {
    result,
    unmount: () => act(() => renderer.unmount()),
  }
}

describe('bridge runtime identity', () => {
  it('keeps remote ids stable across browser runtimes without weakening desktop uniqueness', () => {
    expect(bridgeRuntimeId('thread', 'claude', true, 1)).toBe(bridgeRuntimeId('thread', 'claude', true, 2))
    expect(bridgeRuntimeId('thread', 'claude', false, 1)).not.toBe(bridgeRuntimeId('thread', 'claude', false, 2))
  })
})

describe('useBridgeRegistry navigation keepalive', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('routes provider events emitted before React commits bridge map state', async () => {
    let emitEvent!: (ev: unknown) => void
    const setMessagesForTab = vi.fn((_tabId: string, updater: (messages: unknown[]) => unknown[]) => updater([]))
    vi.stubGlobal('window', {
      electronAPI: {
        onBridgeEvent: vi.fn((cb: (ev: unknown) => void) => { emitEvent = cb; return vi.fn() }),
        bridgeStart: vi.fn(async (opts: { bridgeId: string }) => {
          emitEvent({ type: 'turn_start', bridgeId: opts.bridgeId, turnId: 'fast-turn' })
          emitEvent({ type: 'text_delta', bridgeId: opts.bridgeId, turnId: 'fast-turn', delta: 'fast reply' })
          emitEvent({ type: 'turn_end', bridgeId: opts.bridgeId, turnId: 'fast-turn' })
          return { ok: true }
        }),
        bridgeStop: vi.fn(),
        bridgeSetMode: vi.fn(),
      },
    })

    const hook = renderRegistry(setMessagesForTab)
    await act(async () => {
      await hook.result.current.ensureBridge('sess-fast', 'codex', 'codex', '/repo', undefined, 'medium', 'build')
    })

    expect(setMessagesForTab).toHaveBeenCalled()
    expect(setMessagesForTab.mock.calls.every(call => call[0] === 'sess-fast')).toBe(true)
    hook.unmount()
  })

  it('deduplicates the same recovered Brain history event', async () => {
    let emitEvent!: (ev: unknown) => void
    let messages: unknown[] = []
    const setMessagesForTab = vi.fn((_tabId: string, updater: (current: unknown[]) => unknown[]) => { messages = updater(messages) })
    vi.stubGlobal('window', {
      electronAPI: {
        onBridgeEvent: vi.fn((cb: (ev: unknown) => void) => { emitEvent = cb; return vi.fn() }),
        bridgeStart: vi.fn(async () => ({ ok: true })),
        bridgeStop: vi.fn(),
        bridgeSetMode: vi.fn(),
      },
    })
    const hook = renderRegistry(setMessagesForTab)
    await act(async () => { await hook.result.current.ensureBridge('sess-history', 'codex', 'codex', '/repo') })
    const bridgeId = hook.result.current.getBridgeId('sess-history', 'codex')!
    const event = { type: 'history_agent', bridgeId, turnId: 'recovered-1', text: 'finished remotely' }

    act(() => { emitEvent(event); emitEvent(event) })
    expect(messages).toHaveLength(1)
    hook.unmount()
  })

  it('does not stop a bridge that is still starting unless explicitly forced', async () => {
    const start = deferred<{ ok: boolean }>()
    const bridgeStop = vi.fn()
    vi.stubGlobal('window', {
      electronAPI: {
        onBridgeEvent: vi.fn(() => vi.fn()),
        bridgeStart: vi.fn(() => start.promise),
        bridgeStop,
        bridgeSetMode: vi.fn(),
      },
    })

    const hook = renderRegistry()
    let ensureP!: Promise<{ bridgeId: string } | { error: string }>
    await act(async () => {
      ensureP = hook.result.current.ensureBridge('sess-1', 'pi', 'pi', '/repo', undefined, 'medium', 'build')
      await Promise.resolve()
    })

    act(() => hook.result.current.releaseTab('sess-1'))
    expect(bridgeStop).not.toHaveBeenCalled()
    expect(hook.result.current.isBridgeRunning('sess-1', 'pi')).toBe(true)

    await act(async () => {
      start.resolve({ ok: true })
      await ensureP
    })

    act(() => hook.result.current.releaseTab('sess-1', { stopRunning: true }))
    expect(bridgeStop).toHaveBeenCalledTimes(1)

    hook.unmount()
  })

  it('returns rejected browser prompt RPCs as semantic failures', async () => {
    vi.stubGlobal('window', {
      electronAPI: {
        onBridgeEvent: vi.fn(() => vi.fn()),
        bridgeStart: vi.fn(async () => ({ ok: true })),
        bridgePrompt: vi.fn(async () => { throw new Error('Brain session does not own this terminal or agent resource') }),
        bridgeStop: vi.fn(),
        bridgeSetMode: vi.fn(),
      },
    })

    const hook = renderRegistry()
    await act(async () => {
      await hook.result.current.ensureBridge('sess-1', 'codex', 'codex', '/repo')
    })
    const bridgeId = hook.result.current.getBridgeId('sess-1', 'codex')!
    await expect(hook.result.current.prompt(bridgeId, 'hello')).resolves.toEqual({
      ok: false,
      error: 'Brain session does not own this terminal or agent resource',
    })
    hook.unmount()
  })

  it('keeps an accepted browser prompt stoppable until a terminal bridge event arrives', async () => {
    let emitEvent!: (ev: unknown) => void
    vi.stubGlobal('window', {
      electronAPI: {
        onBridgeEvent: vi.fn((cb: (ev: unknown) => void) => { emitEvent = cb; return vi.fn() }),
        bridgeStart: vi.fn(async () => ({ ok: true })),
        // Browser RPC acknowledges prompt acceptance before provider execution
        // has necessarily finished.
        bridgePrompt: vi.fn(async () => ({ ok: true })),
        bridgeStop: vi.fn(),
        bridgeSetMode: vi.fn(),
      },
    })

    const hook = renderRegistry()
    await act(async () => {
      await hook.result.current.ensureBridge('sess-1', 'claude', 'claude', '/repo', undefined, 'medium', 'build')
    })
    const bridgeId = hook.result.current.getBridgeId('sess-1', 'claude')!

    await act(async () => {
      await hook.result.current.prompt(bridgeId, 'keep working')
    })
    expect(hook.result.current.isBridgeRunning('sess-1', 'claude')).toBe(true)
    expect(useBridgeActivityStore.getState().runningByScope['sess-1']).toBe(true)

    act(() => emitEvent({ type: 'turn_end', bridgeId, turnId: 'turn-1' }))
    expect(hook.result.current.isBridgeRunning('sess-1', 'claude')).toBe(false)
    expect(useBridgeActivityStore.getState().runningByScope['sess-1']).toBeUndefined()

    hook.unmount()
  })

  it('keeps the bridge marked running after a queued follow-up resolves early', async () => {
    // A follow-up sent mid-turn resolves immediately ({ok:true} from the
    // provider queue) while the first prompt's IPC is still pending. The
    // running flag must not be cleared by the follow-up's resolution, or the
    // composer flips idle mid-turn and the next send goes out unqueued.
    const firstTurn = deferred<{ ok: boolean }>()
    let emitEvent!: (ev: unknown) => void
    const bridgePrompt = vi.fn((_id: string, _text: string, options?: { streamingBehavior?: string }) =>
      options?.streamingBehavior === 'followUp' ? Promise.resolve({ ok: true }) : firstTurn.promise)
    vi.stubGlobal('window', {
      electronAPI: {
        onBridgeEvent: vi.fn((cb: (ev: unknown) => void) => { emitEvent = cb; return vi.fn() }),
        bridgeStart: vi.fn(async () => ({ ok: true })),
        bridgeStop: vi.fn(),
        bridgeSetMode: vi.fn(),
        bridgePrompt,
      },
    })

    const hook = renderRegistry()
    await act(async () => {
      await hook.result.current.ensureBridge('sess-1', 'claude', 'claude', '/repo', undefined, 'medium', 'build')
    })
    const bridgeId = hook.result.current.getBridgeId('sess-1', 'claude')!

    let firstP!: Promise<{ ok: boolean; error?: string }>
    await act(async () => {
      firstP = hook.result.current.prompt(bridgeId, 'first')
      await Promise.resolve()
    })
    expect(hook.result.current.isBridgeRunning('sess-1', 'claude')).toBe(true)

    await act(async () => {
      await hook.result.current.prompt(bridgeId, 'second', { streamingBehavior: 'followUp' })
    })
    expect(hook.result.current.isBridgeRunning('sess-1', 'claude')).toBe(true)

    await act(async () => {
      firstTurn.resolve({ ok: true })
      await firstP
    })
    // Prompt promise settlement is only an acknowledgement; the terminal event
    // remains authoritative for whether the request can still be stopped.
    expect(hook.result.current.isBridgeRunning('sess-1', 'claude')).toBe(true)
    act(() => emitEvent({ type: 'turn_end', bridgeId, turnId: 'turn-1' }))
    expect(hook.result.current.isBridgeRunning('sess-1', 'claude')).toBe(false)

    hook.unmount()
  })

  it('tracks bridge follow-up queue events and removes queued items via IPC', async () => {
    let emitEvent!: (ev: unknown) => void
    const bridgeRemoveFollowUp = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('window', {
      electronAPI: {
        onBridgeEvent: vi.fn((cb: (ev: unknown) => void) => { emitEvent = cb; return vi.fn() }),
        bridgeStart: vi.fn(async () => ({ ok: true })),
        bridgeStop: vi.fn(),
        bridgeSetMode: vi.fn(),
        bridgeRemoveFollowUp,
      },
    })

    const hook = renderRegistry()
    await act(async () => {
      await hook.result.current.ensureBridge('sess-1', 'claude', 'claude', '/repo', undefined, 'medium', 'build')
    })
    const bridgeId = hook.result.current.getBridgeId('sess-1', 'claude')!
    // The queue now lives in bridge-activity-store; ChatPane subscribes to it.
    const queued = () => useBridgeActivityStore.getState().followUpsByBridge[bridgeId] ?? []

    act(() => emitEvent({ type: 'follow_up_queued', bridgeId, followUpId: 'fu-1', text: 'do X next' }))
    act(() => emitEvent({ type: 'follow_up_queued', bridgeId, followUpId: 'fu-2', text: 'then Y' }))
    expect(queued()).toEqual([
      { id: 'fu-1', text: 'do X next' },
      { id: 'fu-2', text: 'then Y' },
    ])

    // Drain event (reason 'sent') removes the entry.
    act(() => emitEvent({ type: 'follow_up_removed', bridgeId, followUpId: 'fu-1', reason: 'sent' }))
    expect(queued()).toEqual([{ id: 'fu-2', text: 'then Y' }])

    // User cancel goes through the IPC and drops the entry locally too.
    await act(async () => {
      await hook.result.current.removeQueuedFollowUp('sess-1', 'claude', 'fu-2')
    })
    expect(bridgeRemoveFollowUp).toHaveBeenCalledWith(bridgeId, 'fu-2')
    expect(queued()).toEqual([])

    hook.unmount()
  })

  it('releaseScope drops only the exact session scope, not prefix-sharing siblings', async () => {
    // Regression: session `tab` and its sibling `tab::s2` live in the same tab.
    // Deleting `tab` must not kill `tab::s2` (whose bridge key `tab::s2:pi`
    // prefix-matches `tab:`), or the sibling chat the user is in freezes.
    const bridgeStop = vi.fn()
    vi.stubGlobal('window', {
      electronAPI: {
        onBridgeEvent: vi.fn(() => vi.fn()),
        bridgeStart: vi.fn(async () => ({ ok: true })),
        bridgeStop,
        bridgeSetMode: vi.fn(),
      },
    })

    const hook = renderRegistry()
    await act(async () => {
      await hook.result.current.ensureBridge('tab', 'pi', 'pi', '/repo', undefined, 'medium', 'build')
      await hook.result.current.ensureBridge('tab::s2', 'pi', 'pi', '/repo', undefined, 'medium', 'build')
    })
    const tabBridge     = hook.result.current.getBridgeId('tab', 'pi')!
    const siblingBridge = hook.result.current.getBridgeId('tab::s2', 'pi')!

    act(() => hook.result.current.releaseScope('tab', { stopRunning: true }))
    expect(bridgeStop).toHaveBeenCalledWith(tabBridge)
    expect(bridgeStop).not.toHaveBeenCalledWith(siblingBridge)
    // Sibling bridge is still live and addressable.
    expect(hook.result.current.getBridgeId('tab::s2', 'pi')).toBe(siblingBridge)

    hook.unmount()
  })

  it('starts bridges with provider-specific resume keys and session-scoped replay keys', async () => {
    const bridgeStart = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('window', {
      electronAPI: {
        onBridgeEvent: vi.fn(() => vi.fn()),
        bridgeStart,
        bridgeStop: vi.fn(),
        bridgeSetMode: vi.fn(),
      },
    })

    const hook = renderRegistry()
    await act(async () => {
      await hook.result.current.ensureBridge('sess-1', 'openrouter', 'openrouter', '/repo', 'openai/gpt-5.5', 'medium', 'build')
    })

    expect(bridgeStart).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: 'sess-1:openrouter',
      conversationScopeKey: 'sess-1',
    }))

    hook.unmount()
  })
})

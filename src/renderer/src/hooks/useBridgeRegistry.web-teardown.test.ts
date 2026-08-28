import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

import { installCrewCodeRuntime, type CrewCodeClient } from '../runtime/crewcode-client'
import { markClaimedWebBridgeRoutes, rememberWebBridgeRoutes } from '../runtime/web-bridge-routes'
import { useMessagesStore } from '../stores/chat-messages-store'
import { NotificationsProvider } from './useNotifications'
import { useBridgeRegistry } from './useBridgeRegistry'

describe('web bridge registry execution custody', () => {
  it('idempotently reasserts a claimed Brain bridge without stopping it on page lifecycle', async () => {
    const bridgeStop = vi.fn()
    const bridgeStart = vi.fn(async () => ({ ok: true }))
    let emitBridgeEvent!: (event: unknown) => void
    const client = {
      onBridgeEvent: vi.fn((listener: (event: unknown) => void) => { emitBridgeEvent = listener; return vi.fn() }),
      bridgeStart,
      bridgeStop,
      bridgeSetMode: vi.fn(),
    } as unknown as CrewCodeClient
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => null), setItem: vi.fn() })
    vi.stubGlobal('window', {})
    installCrewCodeRuntime({ kind: 'web', client })
    useMessagesStore.getState().setMessagesByTab({})
    rememberWebBridgeRoutes([{
      bridgeId: 'br-remote-chat-codex-remote',
      tabId: 'remote-chat',
      cwd: '/workspace',
      provider: 'codex',
    }])
    markClaimedWebBridgeRoutes(['br-remote-chat-codex-remote'])

    const result = { current: undefined as unknown as ReturnType<typeof useBridgeRegistry> }
    function Probe(): null {
      result.current = useBridgeRegistry({ setMessagesForTab: useMessagesStore.getState().setMessagesForTab })
      return null
    }

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(NotificationsProvider, null, createElement(Probe)))
    })
    await act(async () => {
      await result.current.ensureBridge('remote-chat', 'codex', 'codex', '/workspace')
    })
    expect(result.current.getBridgeId('remote-chat', 'codex')).toBe('br-remote-chat-codex-remote')
    // This attach RPC is idempotent while Brain is alive and recreates only the
    // provider bridge (not the interrupted prompt) if Brain restarted.
    expect(bridgeStart).toHaveBeenCalledWith(expect.objectContaining({
      bridgeId: 'br-remote-chat-codex-remote',
      provider: 'codex',
      cwd: '/workspace',
      conversationScopeKey: 'remote-chat',
      freshSession: false,
    }))
    useMessagesStore.getState().setMessagesForTab('remote-chat', () => [{
      kind: 'agent',
      blocks: [],
      text: 'reply completed',
      time: '12:00',
      turnId: 'recovered-turn',
      streaming: true,
    }, {
      kind: 'agent',
      blocks: [],
      text: ' while the link was closed',
      time: '12:01',
      turnId: 'recovered-turn',
      streaming: true,
    }])
    act(() => emitBridgeEvent({
      type: 'history_agent',
      bridgeId: 'br-remote-chat-codex-remote',
      turnId: 'recovered-turn',
      text: 'reply completed while the link was closed',
    }))
    act(() => emitBridgeEvent({
      type: 'text_delta',
      bridgeId: 'br-remote-chat-codex-remote',
      turnId: 'recovered-turn',
      delta: ' More arrived after reclaim.',
    }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    expect(useMessagesStore.getState().messagesByTab['remote-chat']).toHaveLength(1)
    expect(useMessagesStore.getState().messagesByTab['remote-chat']?.at(-1)).toMatchObject({
      kind: 'agent',
      text: 'reply completed while the link was closed More arrived after reclaim.',
      streaming: true,
    })
    act(() => renderer.unmount())

    expect(bridgeStop).not.toHaveBeenCalled()
  })
})

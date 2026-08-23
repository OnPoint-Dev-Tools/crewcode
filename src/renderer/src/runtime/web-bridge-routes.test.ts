import { beforeEach, describe, expect, it, vi } from 'vitest'

const values = new Map<string, string>()

beforeEach(() => {
  values.clear()
  vi.resetModules()
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
  })
})

describe('web bridge recovery routes', () => {
  it('survives a full browser module reload without storing authority', async () => {
    const first = await import('./web-bridge-routes')
    first.rememberWebBridgeRoutes([{ bridgeId: 'br-thread-codex-remote', tabId: 'thread', cwd: '/workspace', provider: 'codex' }])

    vi.resetModules()
    const reopened = await import('./web-bridge-routes')
    expect(reopened.webBridgeRoutes()).toEqual([{ bridgeId: 'br-thread-codex-remote', tabId: 'thread', cwd: '/workspace', provider: 'codex' }])
    // Persisted routing is not execution ownership. A fresh encrypted page must
    // receive this id in bridge.claim's confirmed result before prompting it.
    expect(reopened.claimedWebBridgeRoutes()).toEqual([])
    reopened.markClaimedWebBridgeRoutes(['br-thread-codex-remote'])
    expect(reopened.claimedWebBridgeRoutes()).toEqual(reopened.webBridgeRoutes())
    reopened.clearClaimedWebBridgeRoutes()
    expect(reopened.claimedWebBridgeRoutes()).toEqual([])
    expect([...values.values()].join(' ')).not.toContain('ticket')
    expect([...values.values()].join(' ')).not.toContain('token')
  })
})

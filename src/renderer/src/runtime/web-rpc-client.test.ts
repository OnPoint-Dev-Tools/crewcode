import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebCrewCodeClient, exchangePairingToken, savedWebSession, webRpc } from './web-rpc-client'

const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  vi.stubGlobal('window', { prompt: () => null })
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  vi.restoreAllMocks()
})

describe('web RPC client', () => {
  it('exchanges and stores a pairing session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ sessionToken: 'session' }), { status: 200 })))
    expect(await exchangePairingToken('pair')).toBe('session')
    expect(savedWebSession()).toBe('session')
  })

  it('sends versioned authenticated RPC envelopes', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { id: string }
      return Promise.resolve(new Response(JSON.stringify({ protocolVersion: 1, id: request.id, ok: true, result: [{ id: 'one' }] }), { status: 200 }))
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await webRpc('secret', 'workspaces.list', {})).toEqual([{ id: 'one' }])
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.authorization).toBe('Bearer secret')
    expect(JSON.parse(init.body)).toMatchObject({ protocolVersion: 1, method: 'workspaces.list', params: {} })
  })

  it('sends only MCP registry ids when starting a remote bridge', async () => {
    const rpc = vi.fn<(method: string, params: Record<string, unknown>) => void>()
    const client = createWebCrewCodeClient({
      rpc: async <T,>(method: string, params: Record<string, unknown>) => {
        rpc(method, params)
        return { ok: true } as T
      },
      subscribe: () => () => undefined,
    })

    await client.bridgeStart({
      bridgeId: 'bridge-1', provider: 'hermes', cwd: '/repo',
      mcpServers: [{ id: 'filesystem', name: 'Filesystem', command: 'browser-must-not-send-this', env: { SECRET: 'no' } }],
    })

    expect(rpc).toHaveBeenCalledWith('bridge.start', expect.objectContaining({ mcpServerIds: ['filesystem'] }))
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty('mcpServers')
  })

  it('maps supported client calls and rejects unavailable features', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { id: string; method: string }
      const result = request.method === 'voice.availability'
        ? {
            off: { configured: true, available: true },
            fake: { configured: false, available: false },
            openai: { configured: false, available: false },
            xai: { configured: false, available: false },
            local: { configured: false, available: false },
          }
        : request.method === 'mcp.list'
          ? { path: '/brain/.crewcode/mcp.json', exists: true, servers: [], errors: [] }
          : []
      return Promise.resolve(new Response(JSON.stringify({ protocolVersion: 1, id: request.id, ok: true, result }), { status: 200 }))
    }))
    const client = createWebCrewCodeClient('session')
    expect(await client.workspacesList()).toEqual([])
    expect(await client.agentRegistry()).toEqual([])
    expect(await client.agentListModels('claude')).toEqual([])
    expect(await client.mcpList()).toMatchObject({ exists: true, servers: [] })
    expect(await client.workspacesPickFolder()).toMatchObject({ canceled: true })
    expect(await client.keybindsWrite({})).toEqual({ ok: true })
    expect(client.onRemoteStatus(() => undefined)).toEqual(expect.any(Function))
    expect(client.onPluginsChanged(() => undefined)).toEqual(expect.any(Function))
    expect(client.onNotificationClick(() => undefined)).toEqual(expect.any(Function))
    expect(client.onDelegationRequest(() => undefined)).toEqual(expect.any(Function))
    expect(client.onKeybindsChanged(() => undefined)).toEqual(expect.any(Function))
    expect(await client.delegationDisable('session')).toEqual({ ok: true })
    expect(await client.delegationEnable('session', { allowFullAccess: false, parentMode: 'build', maxConcurrent: 1, remote: false }))
      .toMatchObject({ ok: false })
    expect(client.editorWatchAdd('/workspace', 'file.ts')).toBeUndefined()
    expect(client.editorWatchRemove('/workspace', 'file.ts')).toBeUndefined()
    expect(await client.voiceProviderAvailability()).toMatchObject({
      off: { available: true },
      openai: { available: false },
      local: { available: false },
    })
    await expect(client.pluginsList()).rejects.toEqual(expect.objectContaining({ code: 'UNSUPPORTED' }))
  })
})

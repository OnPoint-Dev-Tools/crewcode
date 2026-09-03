import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBrainAttachedCrewCodeClient, createWebCrewCodeClient, exchangePairingToken, savedWebSession, webRpc } from './web-rpc-client'
import type { CrewCodeClient } from './crewcode-client'

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

  it('forwards a CrewCoder mode without exposing any extra process configuration', async () => {
    const rpc = vi.fn<(method: string, params: Record<string, unknown>) => void>()
    const client = createWebCrewCodeClient({
      rpc: async <T,>(method: string, params: Record<string, unknown>) => {
        rpc(method, params)
        return { ok: true } as T
      },
      subscribe: () => () => undefined,
    })

    await client.bridgeStart({
      bridgeId: 'crew-1', provider: 'crewcoder', cwd: '/repo', crewcoderMode: 'extension', crewcoderApprovalMode: 'full-access',
    })

    expect(rpc).toHaveBeenCalledWith('bridge.start', expect.objectContaining({
      provider: 'crewcoder', crewcoderMode: 'extension', crewcoderApprovalMode: 'full-access',
    }))
  })

  it('maps desktop thread keys into the Brain browser conversation namespace', async () => {
    const rpc = vi.fn<(method: string, params: Record<string, unknown>) => void>()
    const client = createWebCrewCodeClient({
      rpc: async <T,>(method: string, params: Record<string, unknown>) => {
        rpc(method, params)
        return { ok: true } as T
      },
      subscribe: () => () => undefined,
    })

    await client.bridgeHandoff('target-bridge', 'thread:source-session', { fromProvider: 'claude', toProvider: 'codex' })
    await client.bridgeStart({
      bridgeId: 'target-bridge', provider: 'codex', cwd: '/repo', conversationScopeKey: 'thread:source-session',
    })
    await client.bridgeResetSession('source-session:codex', 'web:source-session')

    expect(rpc).toHaveBeenCalledWith('bridge.handoff', {
      bridgeId: 'target-bridge',
      sourceConversationKey: 'source-session',
      options: { fromProvider: 'claude', toProvider: 'codex' },
    })
    expect(rpc).toHaveBeenCalledWith('bridge.start', expect.objectContaining({ conversationScopeKey: 'source-session' }))
    expect(rpc).toHaveBeenCalledWith('bridge.resetSession', {
      sessionKey: 'source-session:codex',
      conversationScopeKey: 'source-session',
    })
  })

  it('routes Brain-backed Electron work through Brain RPC while keeping native desktop methods', async () => {
    const rpc = vi.fn<(method: string, params: Record<string, unknown>) => void>()
    const local = {
      brainDesktopRpc: async <T,>(method: string, params: Record<string, unknown>) => {
        rpc(method, params)
        return { ok: true } as T
      },
      onBrainDesktopEvent: () => () => undefined,
      minimize: () => undefined,
      agentGetKey: async () => { throw new Error('local key store must not be used') },
    } as unknown as CrewCodeClient

    const client = createBrainAttachedCrewCodeClient(local)
    await client.workspacesList()
    await client.continuityStateGet()
    await client.continuityDesktopSeed?.({ 'crewcode:sessionsByTab': '{"chat":[]}' })
    client.minimize()
    await client.agentGetKey('codex')

    expect(rpc).toHaveBeenCalledWith('workspaces.list', {})
    expect(rpc).toHaveBeenCalledWith('continuity.get', {})
    expect(rpc).toHaveBeenCalledWith('desktop.continuity.seedCatalogue', { values: { 'crewcode:sessionsByTab': '{"chat":[]}' } })
    expect(rpc).toHaveBeenCalledWith('desktop.agent.getKey', { id: 'codex' })
  })

  it('can override read-only contextBridge methods without violating Proxy invariants', async () => {
    const rpc = vi.fn<(method: string, params: Record<string, unknown>) => void>()
    const localWorkspacesList = vi.fn(async () => [])
    const localTranscriptsMtimes = vi.fn(async () => ({}))
    const local = {
      brainDesktopRpc: async <T,>(method: string, params: Record<string, unknown>) => {
        rpc(method, params)
        return (method === 'workspaces.list' ? [] : {}) as T
      },
      onBrainDesktopEvent: () => () => undefined,
      workspacesList: localWorkspacesList,
      transcriptsMtimes: localTranscriptsMtimes,
    }
    Object.freeze(local)

    const client = createBrainAttachedCrewCodeClient(local as unknown as CrewCodeClient)
    await expect(client.workspacesList()).resolves.toEqual([])
    await expect(client.transcriptsMtimes()).resolves.toEqual({})

    expect(rpc).toHaveBeenCalledWith('workspaces.list', {})
    expect(rpc).toHaveBeenCalledWith('transcripts.mtimes', {})
    expect(localWorkspacesList).not.toHaveBeenCalled()
    expect(localTranscriptsMtimes).not.toHaveBeenCalled()
  })

  it('maps default-branch comparison calls through the web client', async () => {
    const rpc = vi.fn<(method: string, params: Record<string, unknown>) => void>()
    const client = createWebCrewCodeClient({
      rpc: async <T,>(method: string, params: Record<string, unknown>) => {
        rpc(method, params)
        return { ok: true } as T
      },
      subscribe: () => () => undefined,
    })

    await client.gitChangesVsRef('/repo', 'develop')
    await client.gitDiffVsRef('/repo', 'develop', 'src/app.ts')

    expect(rpc).toHaveBeenNthCalledWith(1, 'git.changesVsRef', { cwd: '/repo', ref: 'develop' })
    expect(rpc).toHaveBeenNthCalledWith(2, 'git.diffVsRef', { cwd: '/repo', ref: 'develop', path: 'src/app.ts' })
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
          : request.method === 'delegation.enable'
            ? { ok: true, credentials: { endpoint: 'http://127.0.0.1:1', token: 'token' } }
            : request.method === 'delegation.disable'
              ? { ok: true }
              : request.method === 'plugins.list'
                ? { root: '/brain/plugins', plugins: [], errors: [], contributions: {}, declaredContributions: {} }
          : []
      return Promise.resolve(new Response(JSON.stringify({ protocolVersion: 1, id: request.id, ok: true, result }), { status: 200 }))
    }))
    const client = createWebCrewCodeClient('session')
    expect(await client.workspacesList()).toEqual([])
    expect(await client.agentRegistry()).toEqual([])
    expect(await client.agentListModels('claude')).toEqual([])
    expect(await client.transcriptsCatalogue?.()).toEqual([])
    expect(await client.mcpList()).toMatchObject({ exists: true, servers: [] })
    expect(await client.workspacesPickFolder()).toMatchObject({ canceled: true })
    expect(await client.keybindsWrite({})).toEqual({ ok: true })
    expect(client.onRemoteStatus(() => undefined)).toEqual(expect.any(Function))
    expect(client.onPluginsChanged(() => undefined)).toEqual(expect.any(Function))
    expect(client.onNotificationClick(() => undefined)).toEqual(expect.any(Function))
    const disposeYuheard = client.onYuheardState(() => undefined)
    expect(disposeYuheard).toEqual(expect.any(Function))
    expect(() => disposeYuheard()).not.toThrow()
    expect(client.onDelegationRequest(() => undefined)).toEqual(expect.any(Function))
    expect(client.onKeybindsChanged(() => undefined)).toEqual(expect.any(Function))
    expect(client.trayConfigure).toBeUndefined()
    expect(await client.delegationDisable('session')).toEqual({ ok: true })
    expect(await client.delegationEnable('session', { allowFullAccess: false, parentMode: 'build', maxConcurrent: 1, remote: false }))
      .toMatchObject({ ok: true, credentials: { token: 'token' } })
    expect(client.editorWatchAdd('/workspace', 'file.ts')).toBeUndefined()
    expect(client.editorWatchRemove('/workspace', 'file.ts')).toBeUndefined()
    expect(await client.voiceProviderAvailability()).toMatchObject({
      off: { available: true },
      openai: { available: false },
      local: { available: false },
    })
    expect(await client.pluginsList()).toMatchObject({ root: '/brain/plugins', plugins: [] })
  })
})

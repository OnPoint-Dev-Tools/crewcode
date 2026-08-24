import { describe, expect, it, vi } from 'vitest'
import type { BrainAccessScope } from '../../../shared/hub-relay-types'
import { connectHubRelayTransport, type OpenHubRelayTransport } from './hub-relay-client'
import type { WebClientTransport, WebEventEnvelope } from './web-rpc-client'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

function connection(label: string, scopes: BrainAccessScope[] = ['workspace:read']) {
  const ended = deferred<{ code: number; reason: string; error: Error }>()
  const eventListeners = new Set<(event: WebEventEnvelope) => void>()
  const rpc = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => `${label}:${method}`)
  const transport: WebClientTransport = {
    rpc: <T,>(method: string, params?: unknown) => rpc(method, params) as Promise<T>,
    subscribe(listener) {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    },
  }
  const value: OpenHubRelayTransport = {
    transport,
    grantedScopes: scopes,
    closed: ended.promise,
    close: vi.fn(),
  }
  return {
    value,
    rpc,
    disconnect: (reason = 'network lost') => ended.resolve({ code: 1006, reason, error: new Error(reason) }),
    event: (event: WebEventEnvelope) => { for (const listener of eventListeners) listener(event) },
  }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('managed Hub relay transport', () => {
  it('uploads attachments as ordered bounded chunks through relay RPC', async () => {
    const first = connection('first', ['workspace:write'])
    first.rpc.mockImplementation(async (method, params) => {
      if (method === 'attachments.begin') return { uploadId: 'upload-1', chunkBytes: 3 }
      if (method === 'attachments.finish') return { rel: '.crewcode/attachments/file.txt' }
      if (method === 'attachments.chunk') return { received: (Number((params as { sequence: number }).sequence) + 1) * 3 }
      return `first:${method}`
    })
    const managed = await connectHubRelayTransport('machine', ['workspace:write'], { open: vi.fn().mockResolvedValue(first.value) })

    await expect(managed.transport.uploadAttachment?.('/workspace', '../file.txt', new TextEncoder().encode('abcdefg').buffer))
      .resolves.toBe('.crewcode/attachments/file.txt')
    expect(first.rpc.mock.calls.filter(([method]) => method === 'attachments.chunk').map(([, params]) => params))
      .toEqual([
        { uploadId: 'upload-1', sequence: 0, data: 'YWJj' },
        { uploadId: 'upload-1', sequence: 1, data: 'ZGVm' },
        { uploadId: 'upload-1', sequence: 2, data: 'Zw==' },
      ])
    expect(first.rpc).toHaveBeenCalledWith('attachments.finish', {
      uploadId: 'upload-1', sha256: '7d1a54127b222502f5b79b5fb0803061152a44f92b37e23c6527baf665d4da9a',
    })
  })

  it('requires explicit fresh-ticket reconnection and never queues disconnected RPC', async () => {
    const first = connection('first')
    const second = connection('second', ['workspace:read', 'terminal'])
    const open = vi.fn()
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value)
    const managed = await connectHubRelayTransport('machine', ['workspace:read'], { open })
    const statuses: string[] = []
    managed.onStatus(status => statuses.push(status.state))

    expect(await managed.transport.rpc('workspaces.list', {})).toBe('first:workspaces.list')
    await managed.transport.rpc('bridge.start', { bridgeId: 'durable-agent' })
    first.disconnect()
    await settle()
    await expect(managed.transport.rpc('workspaces.list', {})).rejects.toThrow('reconnect before retrying')
    expect(open).toHaveBeenCalledTimes(1)

    await managed.reconnect()
    expect(open).toHaveBeenCalledTimes(2)
    expect(second.rpc).toHaveBeenCalledWith('bridge.claim', { bridgeIds: ['durable-agent'] })
    expect(managed.grantedScopes).toEqual(['workspace:read', 'terminal'])
    expect(await managed.transport.rpc('workspaces.list', {})).toBe('second:workspaces.list')
    expect(statuses).toEqual(['connected', 'disconnected', 'connecting', 'connected'])
  })

  it('drops stale ownership when a restarted Brain cannot reclaim a resource', async () => {
    const first = connection('first')
    const second = connection('second')
    const third = connection('third')
    second.rpc.mockImplementation(async method => method === 'bridge.claim' ? { claimed: [] } : `second:${method}`)
    const open = vi.fn()
      .mockResolvedValueOnce(first.value)
      .mockResolvedValueOnce(second.value)
      .mockResolvedValueOnce(third.value)
    const managed = await connectHubRelayTransport('machine', ['agent'], { open })

    await managed.transport.rpc('bridge.start', { bridgeId: 'lost-on-brain-restart' })
    first.disconnect('brain restarted')
    await settle()
    await managed.reconnect()
    expect(second.rpc).toHaveBeenCalledWith('bridge.claim', { bridgeIds: ['lost-on-brain-restart'] })

    second.disconnect('network lost again')
    await settle()
    await managed.reconnect()
    expect(third.rpc).not.toHaveBeenCalledWith('bridge.claim', expect.anything())
  })

  it('buffers reclaimed events until App installs its event subscriber', async () => {
    const first = connection('first')
    const managed = await connectHubRelayTransport('machine', ['agent'], { open: vi.fn().mockResolvedValue(first.value) })
    const event = { channel: 'bridge', event: { type: 'text_delta', bridgeId: 'detached', turnId: 'turn', delta: 'recovered reply' } } as const

    first.event(event)
    const listener = vi.fn()
    managed.transport.subscribe(listener)
    await settle()

    expect(listener).toHaveBeenCalledWith(event)
  })

  it('keeps event subscriptions attached across a reconnect', async () => {
    const first = connection('first')
    const second = connection('second')
    const open = vi.fn().mockResolvedValueOnce(first.value).mockResolvedValueOnce(second.value)
    const managed = await connectHubRelayTransport('machine', ['workspace:read'], { open })
    const listener = vi.fn()
    managed.transport.subscribe(listener)
    const event = { channel: 'pty', event: { type: 'data', paneId: 'one', data: 'hello' } } as const

    first.event(event)
    first.disconnect()
    await settle()
    await managed.reconnect()
    second.event(event)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

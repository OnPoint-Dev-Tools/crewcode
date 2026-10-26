import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeStartOpts, RequestUserFn } from './bridge-types'
const spawn = vi.hoisted(() => vi.fn())
vi.mock('./agent-spawn', () => ({ spawnAgentProcess: spawn }))
import { createCodexBridge } from './codex-bridge'

async function mount(mode: BridgeStartOpts['mode'], requestUser?: RequestUserFn) {
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 42, killed: false, kill: vi.fn() })
  const replies: Array<{ id: number | string; result?: Record<string, unknown>; error?: { message: string } }> = []
  proc.stdin.on('data', chunk => {
    const message = JSON.parse(String(chunk))
    if (!message.method) { replies.push(message); return }
    if (message.id === undefined) return
    queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: message.id, result: message.method === 'thread/start' ? { thread: { id: 'thread' } } : {} }) + '\n'))
  })
  spawn.mockResolvedValue({ proc, dir: '/repo', remote: false })
  const bridge = await createCodexBridge('codex', { bridgeId: 'browser', provider: 'codex', cwd: '/repo', mode }, () => {}, requestUser)
  const ask = async (method: string, params: Record<string, unknown>, id: string | number = 'browser-request') => {
    proc.stdout.write(JSON.stringify({ id, method, params }) + '\n')
    await new Promise(resolve => setImmediate(resolve))
    return replies.find(reply => reply.id === id)
  }
  return { bridge, proc, replies, ask }
}
afterEach(() => vi.clearAllMocks())
describe('Codex browser access RPC', () => {
  it('answers a string-id consent request with the MCP response contract', async () => {
    const h = await mount('full')
    expect(await h.ask('mcpServer/elicitation/request', { mode: 'form', serverName: 'browser', requestedSchema: { type: 'object', properties: {} } }))
      .toEqual({ id: 'browser-request', result: { action: 'accept', content: {} } })
    h.proc.emit('close', 0)
  })
  it('grants only the requested sandbox extension for one turn after acceptance', async () => {
    const request = vi.fn().mockResolvedValue({ action: 'accept' })
    const h = await mount('full', request)
    const permissions = { network: { enabled: true } }
    expect(await h.ask('item/permissions/requestApproval', { permissions, cwd: '/repo' }))
      .toEqual({ id: 'browser-request', result: { permissions, scope: 'turn' } })
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ title: 'Codex sandbox access requested' }), expect.any(AbortSignal))
    h.proc.emit('close', 0)
  })
  it('refuses sandbox extension in a read-only mode', async () => {
    const request = vi.fn().mockResolvedValue({ action: 'accept' })
    const h = await mount('ask', request)
    expect(await h.ask('item/permissions/requestApproval', { permissions: { network: { enabled: true } } }))
      .toEqual({ id: 'browser-request', result: { permissions: {}, scope: 'turn' } })
    expect(request).not.toHaveBeenCalled()
    h.proc.emit('close', 0)
  })
  it('withdraws unresolved permission cards on Stop without sending a late grant', async () => {
    let signal: AbortSignal | undefined
    let resolve!: (answer: { requestId: string; action: 'accept' }) => void
    const h = await mount('build', (_request, nextSignal) => { signal = nextSignal; return new Promise(r => { resolve = r }) })
    expect(await h.ask('mcpServer/elicitation/request', { mode: 'form', requestedSchema: { type: 'object', properties: {} } })).toBeUndefined()
    await h.bridge.abort()
    expect(signal?.aborted).toBe(true)
    resolve({ requestId: 'request', action: 'accept' })
    await new Promise(r => setImmediate(r))
    expect(h.replies).toEqual([])
    h.proc.emit('close', 0)
  })
  it('reports unknown methods explicitly instead of implying user denial', async () => {
    const h = await mount('build')
    expect(await h.ask('future/request', {})).toMatchObject({ error: { message: 'Unsupported Codex server request: future/request' } })
    h.proc.emit('close', 0)
  })
})

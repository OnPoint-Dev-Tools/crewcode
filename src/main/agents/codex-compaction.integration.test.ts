import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BridgeEvent } from './bridge-types'
const spawn = vi.hoisted(() => vi.fn())
vi.mock('./agent-spawn', () => ({ spawnAgentProcess: spawn }))
import { createCodexBridge } from './codex-bridge'

async function mount(config: Record<string, unknown> = {}) {
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 42, killed: false, kill: vi.fn() })
  const notify = (method: string, params: Record<string, unknown>) => proc.stdout.write(JSON.stringify({ method, params }) + '\n')
  const calls: string[] = []
  proc.stdin.on('data', chunk => {
    const request = JSON.parse(String(chunk))
    if (request.id === undefined) return
    calls.push(request.method)
    const result = request.method === 'config/read' ? { config }
      : request.method === 'thread/start' ? { thread: { id: 'thread' } } : {}
    queueMicrotask(() => proc.stdout.write(JSON.stringify({ id: request.id, result }) + '\n'))
  })
  spawn.mockResolvedValue({ proc, dir: '/repo', remote: false })
  const events: BridgeEvent[] = []
  const bridge = await createCodexBridge('codex', { bridgeId: 'b', provider: 'codex', cwd: '/repo', model: 'custom' }, event => events.push(event))
  return { bridge, events, proc, notify, calls }
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })
describe('native Codex /compact', () => {
  it('waits for the native completion rather than the RPC acknowledgement', async () => {
    const h = await mount({ model_auto_compact_token_limit: 630000 })
    let settled = false
    const compacting = h.bridge.compact!().then(result => { settled = true; return result })
    await new Promise(resolve => setImmediate(resolve))
    expect(h.calls).toContain('thread/compact/start')
    expect(settled).toBe(false)
    expect((await h.bridge.prompt('overlap')).ok).toBe(false)
    h.notify('item/completed', { item: { type: 'contextCompaction' }, turnId: 'compact-turn' })
    expect(await compacting).toMatchObject({ ok: true, compacted: true })
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'compaction_event', status: 'completed', automatic: false, resetContext: true }))
    await h.bridge.prompt('continue')
    h.notify('turn/started', { turn: { id: 'next-turn' } })
    h.notify('thread/tokenUsage/updated', { tokenUsage: { modelContextWindow: 1000000, last: { inputTokens: 2000 } } })
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'usage_update', usage: expect.objectContaining({ compactionPolicy: expect.objectContaining({ thresholdTokens: 630000 }) }) }))
    h.proc.emit('close', 0)
  })
  it('fails a pending manual operation when the provider exits', async () => {
    const h = await mount()
    const compacting = h.bridge.compact!()
    h.proc.emit('close', 1)
    expect((await compacting).ok).toBe(false)
    expect(h.events).not.toContainEqual(expect.objectContaining({ type: 'compaction_event', status: 'completed' }))
  })
})

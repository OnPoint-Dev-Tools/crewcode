import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => unknown

async function loadStore(userData: string) {
  vi.resetModules()
  const handlers = new Map<string, Handler>()
  const onHandlers = new Map<string, Handler>()
  const ipcMain = {
    handle: vi.fn((channel: string, fn: Handler) => { handlers.set(channel, fn) }),
    on:     vi.fn((channel: string, fn: Handler) => { onHandlers.set(channel, fn) }),
  }
  const app = { getPath: vi.fn(() => userData) }
  vi.doMock('electron', () => ({ default: { app, ipcMain }, app, ipcMain }))
  const mod = await import('./transcript-store')
  mod.registerTranscriptIpc()
  return {
    save:    (scopeId: string, messages: unknown[]) => handlers.get('transcripts:save')!(null, scopeId, messages),
    loadAll: () => handlers.get('transcripts:loadAll')!() as Record<string, unknown[]>,
    mtimes:  () => handlers.get('transcripts:mtimes')!() as Record<string, number>,
    remove:  (scopeId: string) => handlers.get('transcripts:remove')!(null, scopeId),
    saveSyncBatch: (entries: unknown) => {
      const event: { returnValue?: boolean } = {}
      onHandlers.get('transcripts:saveSyncBatch')!(event, entries)
      return event.returnValue
    },
  }
}

function tempUserData(name: string): string {
  return mkdtempSync(join(tmpdir(), `crewcode-transcripts-${name}-`))
}

function transcriptFiles(userData: string): string[] {
  const dir = join(userData, 'transcripts')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.startsWith('transcript.') && f.endsWith('.json'))
}

describe('transcript-store', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('round-trips a saved transcript through loadAll, one file per scope', async () => {
    const userData = tempUserData('roundtrip')
    const store = await loadStore(userData)

    store.save('thread:lil-buddy-chat-x:codex', [{ kind: 'user', text: 'testing ping' }])
    store.save('thread:other:pi', [{ kind: 'agent', text: 'alive' }])

    await vi.waitFor(() => expect(transcriptFiles(userData)).toHaveLength(2))
    expect(store.loadAll()).toEqual({
      'thread:lil-buddy-chat-x:codex': [{ kind: 'user', text: 'testing ping' }],
      'thread:other:pi': [{ kind: 'agent', text: 'alive' }],
    })
  })

  it('overwrites the same scope in place rather than growing files', async () => {
    const userData = tempUserData('overwrite')
    const store = await loadStore(userData)

    store.save('scope-a', [{ kind: 'user', text: 'one' }])
    store.save('scope-a', [{ kind: 'user', text: 'one' }, { kind: 'agent', text: 'two' }])

    await vi.waitFor(() => {
      expect(transcriptFiles(userData)).toHaveLength(1)
      expect(store.loadAll()['scope-a']).toHaveLength(2)
    })
  })

  it('removes a scope file on explicit delete', async () => {
    const userData = tempUserData('remove')
    const store = await loadStore(userData)

    store.save('scope-a', [{ kind: 'user', text: 'bye' }])
    // save() goes through the last-wins async queue, so the file is not on disk
    // synchronously — asserting straight after the call is a race.
    await vi.waitFor(() => expect(transcriptFiles(userData)).toHaveLength(1))

    store.remove('scope-a')
    expect(transcriptFiles(userData)).toHaveLength(0)
    expect(store.loadAll()['scope-a']).toBeUndefined()
  })

  it('persists a synchronous teardown batch and reports success', async () => {
    const userData = tempUserData('syncbatch')
    const store = await loadStore(userData)

    const ok = store.saveSyncBatch([
      { scopeId: 'scope-a', messages: [{ kind: 'user', text: 'a' }] },
      { scopeId: 'scope-b', messages: [{ kind: 'user', text: 'b' }] },
    ])

    expect(ok).toBe(true)
    expect(store.loadAll()).toEqual({
      'scope-a': [{ kind: 'user', text: 'a' }],
      'scope-b': [{ kind: 'user', text: 'b' }],
    })
  })

  it('serves repeated mtime requests from memory instead of reparsing every shard', async () => {
    const userData = tempUserData('mtime-cache')
    const store = await loadStore(userData)
    store.saveSyncBatch([{ scopeId: 'scope-a', messages: [{ kind: 'user', text: 'a' }] }])

    const first = store.mtimes()
    expect(first['scope-a']).toBeTypeOf('number')

    const file = join(userData, 'transcripts', transcriptFiles(userData)[0])
    writeFileSync(file, '{ corrupt after cache warmup', 'utf8')
    expect(store.mtimes()).toEqual(first)

    store.remove('scope-a')
    expect(store.mtimes()['scope-a']).toBeUndefined()
  })

  it('skips a corrupt shard instead of failing the whole load', async () => {
    const userData = tempUserData('corrupt')
    const store = await loadStore(userData)
    store.save('scope-a', [{ kind: 'user', text: 'good' }])
    await vi.waitFor(() => expect(store.loadAll()['scope-a']).toEqual([{ kind: 'user', text: 'good' }]))

    writeFileSync(join(userData, 'transcripts', 'transcript.deadbeef.json'), '{ not json', 'utf8')

    expect(store.loadAll()).toEqual({ 'scope-a': [{ kind: 'user', text: 'good' }] })
  })
})

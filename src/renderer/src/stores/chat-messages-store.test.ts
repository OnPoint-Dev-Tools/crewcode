import { beforeEach, describe, expect, it, vi } from 'vitest'

function installLocalStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
    removeItem: vi.fn((key: string) => { values.delete(key) }),
    clear: vi.fn(() => { values.clear() }),
  }
  vi.stubGlobal('localStorage', storage)
  return storage
}

interface ElectronApiStub {
  transcriptsLoadAll: ReturnType<typeof vi.fn>
  transcriptsSave: ReturnType<typeof vi.fn>
  transcriptsRemove: ReturnType<typeof vi.fn>
  transcriptsSaveSyncBatch: ReturnType<typeof vi.fn>
}

function installLifecycleGlobals(electronAPI?: ElectronApiStub) {
  const windowListeners: Record<string, Array<() => void>> = {}
  const documentListeners: Record<string, Array<() => void>> = {}
  const windowStub = {
    electronAPI,
    addEventListener: vi.fn((event: string, cb: () => void) => {
      ;(windowListeners[event] ??= []).push(cb)
    }),
  }
  const documentStub = {
    visibilityState: 'visible',
    addEventListener: vi.fn((event: string, cb: () => void) => {
      ;(documentListeners[event] ??= []).push(cb)
    }),
  }
  vi.stubGlobal('window', windowStub)
  vi.stubGlobal('document', documentStub)
  return { windowListeners, documentListeners, documentStub }
}

function installElectronApi(loadAll: Record<string, unknown[]> = {}): ElectronApiStub {
  return {
    transcriptsLoadAll: vi.fn(() => Promise.resolve(loadAll)),
    transcriptsSave: vi.fn(() => Promise.resolve({ ok: true })),
    transcriptsRemove: vi.fn(() => Promise.resolve({ ok: true })),
    transcriptsSaveSyncBatch: vi.fn(() => true),
  }
}

async function loadStore() {
  vi.resetModules()
  return import('./chat-messages-store')
}

function persistedMessages(storage: ReturnType<typeof installLocalStorage>) {
  const raw = storage.getItem('crewcode:messagesByTab')
  return raw ? JSON.parse(raw) : {}
}

describe('chat-messages-store persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('defers the localStorage cache write off the input-critical path', async () => {
    const storage = installLocalStorage()
    installLifecycleGlobals()
    const { useMessagesStore } = await loadStore()

    useMessagesStore.getState().setMessagesForTab('session-1', messages => [
      ...messages,
      { kind: 'user', text: 'do not lose this', time: '4:30 PM' },
    ])

    expect(persistedMessages(storage)['session-1']).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1300)
    expect(persistedMessages(storage)['session-1']).toEqual([
      { kind: 'user', text: 'do not lose this', time: '4:30 PM' },
    ])
  })

  it('sheds the coldest scopes on quota and always keeps the newest conversation', async () => {
    const storage = installLocalStorage()
    installLifecycleGlobals()
    // Reject any payload carrying more than one scope, forcing the shed path.
    storage.setItem.mockImplementation((key: string, value: string) => {
      if (key === 'crewcode:messagesByTab' && Object.keys(JSON.parse(value)).length > 1) {
        const err = new DOMException('quota', 'QuotaExceededError')
        throw err
      }
    })
    const { useMessagesStore } = await loadStore()

    // 'old' is touched first, so 'new' is the most recent and must win.
    useMessagesStore.getState().setMessagesForTab('old', () => [
      { kind: 'user', text: 'stale', time: '1:00 PM' },
    ])
    useMessagesStore.getState().setMessagesForTab('new', () => [
      { kind: 'user', text: 'freshest', time: '2:00 PM' },
    ])
    await vi.advanceTimersByTimeAsync(1300)

    const written = storage.setItem.mock.calls.filter(([k]) => k === 'crewcode:messagesByTab')
    const lastOk = JSON.parse(written[written.length - 1][1] as string)
    expect(Object.keys(lastOk)).toEqual(['new'])
    expect(lastOk.new).toEqual([{ kind: 'user', text: 'freshest', time: '2:00 PM' }])
  })

  it('writes the L1 cache in a single pass and bounds each scope tail', async () => {
    // Guards the ~2s-per-tool-call stall: persist() must not re-serialize the
    // whole map per scope, and must not hoard messages the DOM pager never renders.
    const storage = installLocalStorage()
    installLifecycleGlobals()
    const { useMessagesStore } = await loadStore()

    for (const scope of ['a', 'b', 'c']) {
      useMessagesStore.getState().setMessagesForTab(scope, () =>
        Array.from({ length: 200 }, (_, i) => ({
          kind: 'user' as const, text: `${scope}-${i}`, time: '1:00 PM',
        })),
      )
    }
    await vi.advanceTimersByTimeAsync(1300)

    const writes = storage.setItem.mock.calls.filter(([k]) => k === 'crewcode:messagesByTab')
    expect(writes).toHaveLength(1)

    const cached = JSON.parse(writes[0][1] as string)
    for (const scope of ['a', 'b', 'c']) {
      expect(cached[scope]).toHaveLength(60)
      // The bounded tail must be the *newest* messages, not the oldest.
      expect(cached[scope][59]).toMatchObject({ text: `${scope}-199` })
    }
  })

  it('stops shedding on a non-quota storage failure instead of spinning', async () => {
    const storage = installLocalStorage()
    installLifecycleGlobals()
    storage.setItem.mockImplementation(() => { throw new Error('storage disabled') })
    const { useMessagesStore } = await loadStore()

    for (const scope of ['a', 'b', 'c']) {
      useMessagesStore.getState().setMessagesForTab(scope, () => [
        { kind: 'user', text: scope, time: '1:00 PM' },
      ])
    }
    await vi.advanceTimersByTimeAsync(1300)

    // One attempt, then bail — a non-quota error is not fixed by dropping scopes.
    const attempts = storage.setItem.mock.calls.filter(([k]) => k === 'crewcode:messagesByTab')
    expect(attempts).toHaveLength(1)
  })

  it('persists the final settled assistant text on the deferred cache flush', async () => {
    const storage = installLocalStorage()
    installLifecycleGlobals()
    const { useMessagesStore } = await loadStore()

    useMessagesStore.getState().setMessagesForTab('session-1', () => [
      { kind: 'agent', blocks: [], text: 'partial', time: '4:31 PM', streaming: true },
    ])
    useMessagesStore.getState().setMessagesForTab('session-1', messages => messages.map(message =>
      message.kind === 'agent' ? { ...message, text: 'complete answer', streaming: true } : message,
    ))
    expect(persistedMessages(storage)['session-1']).toBeUndefined()

    useMessagesStore.getState().setMessagesForTab('session-1', messages => messages.map(message =>
      message.kind === 'agent' ? { ...message, text: 'complete answer', streaming: false } : message,
    ))
    await vi.advanceTimersByTimeAsync(1300)

    expect(persistedMessages(storage)['session-1'][0]).toMatchObject({
      kind: 'agent',
      text: 'complete answer',
      streaming: false,
    })
  })

  it('flushes debounced token updates on pagehide', async () => {
    const storage = installLocalStorage()
    const { windowListeners } = installLifecycleGlobals()
    const { useMessagesStore } = await loadStore()

    useMessagesStore.getState().setMessagesForTab('session-1', () => [
      { kind: 'agent', blocks: [], text: 'partial', time: '4:32 PM', streaming: true },
    ])
    useMessagesStore.getState().setMessagesForTab('session-1', messages => messages.map(message =>
      message.kind === 'agent' ? { ...message, text: 'newer token text', streaming: true } : message,
    ))
    expect(persistedMessages(storage)['session-1']).toBeUndefined()

    windowListeners.pagehide[0]()

    expect(persistedMessages(storage)['session-1'][0].text).toBe('newer token text')
  })

  it('writes settled turns through to the on-disk transcript store', async () => {
    installLocalStorage()
    const api = installElectronApi()
    installLifecycleGlobals(api)
    const { useMessagesStore } = await loadStore()

    useMessagesStore.getState().setMessagesForTab('session-1', () => [
      { kind: 'user', text: 'persist me to disk', time: '5:00 PM' },
    ])
    await vi.advanceTimersByTimeAsync(1300)

    expect(api.transcriptsSave).toHaveBeenCalledWith('session-1', [
      { kind: 'user', text: 'persist me to disk', time: '5:00 PM' },
    ])
  })

  it('does no localStorage or transcript IPC work while a turn is live', async () => {
    const storage = installLocalStorage()
    const api = installElectronApi()
    installLifecycleGlobals(api)
    const { useMessagesStore } = await loadStore()

    useMessagesStore.getState().setMessagesForTab('session-1', () => [
      { kind: 'thinking', turnId: 'turn-1', segmentId: 'thinking-1', text: 'one', chunks: ['one'], time: '5:00 PM', streaming: true },
    ])
    useMessagesStore.getState().setMessagesForTab('session-1', messages => [
      ...messages,
      { kind: 'toolcall', turnId: 'turn-1', toolCallId: 'tool-1', toolName: 'read', args: {}, status: 'running', time: '5:00 PM' },
    ])
    await vi.advanceTimersByTimeAsync(10_000)

    expect(storage.setItem).not.toHaveBeenCalled()
    expect(api.transcriptsSave).not.toHaveBeenCalled()

    useMessagesStore.getState().setMessagesForTab('session-1', messages => messages.map(message => {
      if (message.kind === 'thinking') return { ...message, streaming: false }
      if (message.kind === 'toolcall') return { ...message, status: 'completed' as const }
      return message
    }))
    await vi.advanceTimersByTimeAsync(1300)

    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(api.transcriptsSave).toHaveBeenCalledTimes(1)
  })

  it('uses the synchronous batch on teardown so the last debounced turn reaches disk', async () => {
    installLocalStorage()
    const api = installElectronApi()
    const { windowListeners } = installLifecycleGlobals(api)
    const { useMessagesStore } = await loadStore()

    // Settled turn flushes (and clears dirty); a following token delta is only
    // debounced, so it's still dirty when teardown fires.
    useMessagesStore.getState().setMessagesForTab('session-1', () => [
      { kind: 'agent', blocks: [], text: 'partial', time: '5:01 PM', streaming: true },
    ])
    useMessagesStore.getState().setMessagesForTab('session-1', messages => messages.map(message =>
      message.kind === 'agent' ? { ...message, text: 'final token text', streaming: true } : message,
    ))

    windowListeners.pagehide[0]()

    expect(api.transcriptsSaveSyncBatch).toHaveBeenCalledTimes(1)
    const batch = api.transcriptsSaveSyncBatch.mock.calls[0][0] as Array<{ scopeId: string; messages: { text: string }[] }>
    expect(batch[0].scopeId).toBe('session-1')
    expect(batch[0].messages[0].text).toBe('final token text')
    expect(batch[0].messages[0]).toMatchObject({ streaming: false })
  })

  it('hydrates scopes missing from localStorage from the disk store on launch', async () => {
    vi.useRealTimers() // hydration awaits a resolved IPC promise
    installLocalStorage() // empty L1 cache
    const api = installElectronApi({
      'disk-only-session': [{ kind: 'agent', blocks: [], text: 'recovered from disk', time: '5:02 PM' }],
    })
    installLifecycleGlobals(api)
    const { useMessagesStore } = await loadStore()

    await vi.waitFor(() => {
      expect(useMessagesStore.getState().messagesByTab['disk-only-session']).toBeDefined()
    })
    expect(useMessagesStore.getState().messagesByTab['disk-only-session'][0]).toMatchObject({
      text: 'recovered from disk',
    })
  })

  it('hydration never clobbers an in-memory scope that is already longer', async () => {
    vi.useRealTimers()
    installLocalStorage()
    // Disk has a single (stale) message; the live store already has two.
    const api = installElectronApi({
      'session-1': [{ kind: 'user', text: 'old disk copy', time: '5:03 PM' }],
    })
    installLifecycleGlobals(api)
    const { useMessagesStore } = await loadStore()

    useMessagesStore.getState().setMessagesForTab('session-1', () => [
      { kind: 'user', text: 'fresh turn one', time: '5:03 PM' },
      { kind: 'agent', blocks: [], text: 'fresh turn two', time: '5:03 PM' },
    ])

    await vi.waitFor(() => expect(api.transcriptsLoadAll).toHaveBeenCalled())
    // Give hydration a tick to (not) apply.
    await Promise.resolve()

    expect(useMessagesStore.getState().messagesByTab['session-1']).toHaveLength(2)
  })

  // The L1 payload is assembled from a per-scope serialization cache keyed by
  // `Message[]` identity. A stale entry would silently persist an old tail, so
  // pin that every scope's newest content actually reaches storage.
  it('persists fresh content for every scope when only one scope changed', async () => {
    const storage = installLocalStorage()
    installLifecycleGlobals()
    const { useMessagesStore } = await loadStore()

    useMessagesStore.getState().setMessagesForTab('session-a', () => [
      { kind: 'user', text: 'alpha original', time: '6:00 PM' },
    ])
    useMessagesStore.getState().setMessagesForTab('session-b', () => [
      { kind: 'user', text: 'beta original', time: '6:00 PM' },
    ])

    // Touch only session-a; session-b must still serialize to its own content.
    useMessagesStore.getState().setMessagesForTab('session-a', () => [
      { kind: 'user', text: 'alpha updated', time: '6:01 PM' },
    ])
    await vi.advanceTimersByTimeAsync(1300)

    const persisted = persistedMessages(storage)
    expect(persisted['session-a']?.[0]?.text).toBe('alpha updated')
    expect(persisted['session-b']?.[0]?.text).toBe('beta original')
  })

  it('reserializes a scope whose array identity changed but length did not', async () => {
    const storage = installLocalStorage()
    installLifecycleGlobals()
    const { useMessagesStore } = await loadStore()

    useMessagesStore.getState().setMessagesForTab('session-1', () => [
      { kind: 'agent', blocks: [], text: 'partial', time: '6:02 PM', streaming: true },
    ])
    // Same length, new array + new text: a reference-keyed cache must miss.
    useMessagesStore.getState().setMessagesForTab('session-1', messages => messages.map(message =>
      message.kind === 'agent' ? { ...message, text: 'final text', streaming: false } : message,
    ))
    await vi.advanceTimersByTimeAsync(1300)

    expect(persistedMessages(storage)['session-1']?.[0]?.text).toBe('final text')
  })
})

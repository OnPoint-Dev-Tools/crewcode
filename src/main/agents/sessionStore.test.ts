import { mkdtempSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadStore(userData: string) {
  vi.resetModules()
  vi.doMock('electron', () => ({
    default: { app: { getPath: vi.fn(() => userData) } },
    app:     { getPath: vi.fn(() => userData) },
  }))
  return import('./sessionStore')
}

function tempUserData(name: string): string {
  return mkdtempSync(join(tmpdir(), `crewcode-sessions-${name}-`))
}

function readRaw(userData: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(userData, 'agent-sessions.json'), 'utf8'))
}

describe('sessionStore usage snapshots', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('persists and reloads a context-usage baseline', async () => {
    const userData = tempUserData('roundtrip')
    const store = await loadStore(userData)

    store.setUsageSnapshot('tab:claude', { contextTokens: 42_000, contextWindow: 200_000, model: 'claude' })
    expect(store.getUsageSnapshot('tab:claude')).toEqual({
      contextTokens: 42_000,
      contextWindow: 200_000,
      model: 'claude',
    })

    // A fresh module load (app restart) must still see the baseline from disk.
    const reloaded = await loadStore(userData)
    expect(reloaded.getUsageSnapshot('tab:claude')).toEqual({
      contextTokens: 42_000,
      contextWindow: 200_000,
      model: 'claude',
    })
  })

  it('ignores snapshots without a positive context-token count', async () => {
    const userData = tempUserData('empty')
    const store = await loadStore(userData)

    store.setUsageSnapshot('tab:codex', { contextWindow: 200_000 })
    store.setUsageSnapshot('tab:codex', { contextTokens: 0 })
    expect(store.getUsageSnapshot('tab:codex')).toBeUndefined()
  })

  it('floors fractional token counts and drops unknown window/model', async () => {
    const userData = tempUserData('floor')
    const store = await loadStore(userData)

    store.setUsageSnapshot('tab:pi', { contextTokens: 1234.7 })
    expect(store.getUsageSnapshot('tab:pi')).toEqual({ contextTokens: 1234 })
  })

  it('clears only the usage baseline after authoritative compaction', async () => {
    const userData = tempUserData('compaction-reset')
    const store = await loadStore(userData)

    store.setSessionId('tab:crewcoder', 'sess-1')
    store.setUsageSnapshot('tab:crewcoder', { contextTokens: 170_000, contextWindow: 200_000 })
    store.clearUsageSnapshot('tab:crewcoder')

    expect(store.getSessionId('tab:crewcoder')).toBe('sess-1')
    expect(store.getUsageSnapshot('tab:crewcoder')).toBeUndefined()

    store.setUsageSnapshot('tab:crewcoder', { contextTokens: 24_000, contextWindow: 200_000 })
    expect(store.getUsageSnapshot('tab:crewcoder')).toEqual({ contextTokens: 24_000, contextWindow: 200_000 })
  })

  it('clears the usage baseline when the session id is cleared', async () => {
    const userData = tempUserData('clear')
    const store = await loadStore(userData)

    store.setSessionId('tab:claude', 'sess-1')
    store.setUsageSnapshot('tab:claude', { contextTokens: 99_000, contextWindow: 200_000 })

    store.clearSessionId('tab:claude')

    expect(store.getSessionId('tab:claude')).toBeUndefined()
    expect(store.getUsageSnapshot('tab:claude')).toBeUndefined()
    const raw = readRaw(userData) as { usage?: Record<string, unknown> }
    expect(raw.usage?.['tab:claude']).toBeUndefined()
  })

  it('returns secret-free provider and model hints for transcript recovery', async () => {
    const userData = tempUserData('catalogue-hints')
    const store = await loadStore(userData)
    store.setSessionId('workspace-chat:codex', 'opaque-native-secret')
    store.setUsageSnapshot('workspace-chat:codex', { contextTokens: 12_000, model: 'gpt-5.6-sol' })

    expect(store.getSessionHints(['workspace-chat', 'other-chat'])).toEqual({
      'workspace-chat': { agentId: 'codex', model: 'gpt-5.6-sol' },
    })
    expect(JSON.stringify(store.getSessionHints(['workspace-chat']))).not.toContain('opaque-native-secret')
  })
})

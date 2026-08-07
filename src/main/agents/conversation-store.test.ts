import { existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function loadStore(userData: string) {
  vi.resetModules()
  vi.doMock('electron', () => ({
    default: { app: { getPath: vi.fn(() => userData) } },
    app:     { getPath: vi.fn(() => userData) },
  }))
  return import('./conversation-store')
}

function tempUserData(name: string): string {
  return mkdtempSync(join(tmpdir(), `crewcode-conversations-${name}-`))
}

function conversationFiles(userData: string): string[] {
  const dir = join(userData, 'conversations')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(file => file.startsWith('agent-conversations.') && file.endsWith('.json'))
}

describe('conversation-store', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('saves each session to its own conversation file', async () => {
    const userData = tempUserData('shards')
    const store = await loadStore(userData)

    store.saveConversation('session-a', [{ role: 'user', content: 'hello' }])
    store.saveConversation('session-b', [{ role: 'assistant', content: 'hi' }])

    const files = conversationFiles(userData)
    expect(files).toHaveLength(2)
    expect(files.every(file => file !== 'agent-conversations.json')).toBe(true)
    const payloads = files.map(file => JSON.parse(readFileSync(join(userData, 'conversations', file), 'utf8')))
    expect(payloads).toEqual(expect.arrayContaining([
      { conversations: { 'session-a': [{ role: 'user', content: 'hello' }] } },
      { conversations: { 'session-b': [{ role: 'assistant', content: 'hi' }] } },
    ]))
    expect(store.loadConversation('session-a')).toEqual([{ role: 'user', content: 'hello' }])
    expect(store.loadConversation('session-b')).toEqual([{ role: 'assistant', content: 'hi' }])
  })

  it('still reads the previous custom shard schema', async () => {
    const userData = tempUserData('current-shard-compat')
    const first = await loadStore(userData)
    first.saveConversation('session-a', [{ role: 'user', content: 'initial' }])
    const shard = conversationFiles(userData)[0]
    writeFileSync(join(userData, 'conversations', shard), JSON.stringify({
      sessionId: 'session-a',
      messages: [{ role: 'assistant', content: 'custom shard' }],
    }), 'utf8')

    const second = await loadStore(userData)

    expect(second.loadConversation('session-a')).toEqual([{ role: 'assistant', content: 'custom shard' }])
    expect(JSON.parse(readFileSync(join(userData, 'conversations', shard), 'utf8'))).toEqual({
      conversations: { 'session-a': [{ role: 'assistant', content: 'custom shard' }] },
    })
  })

  it('migrates the legacy monolithic file without keeping it as the live store', async () => {
    const userData = tempUserData('migration')
    writeFileSync(join(userData, 'agent-conversations.json'), JSON.stringify({
      conversations: {
        legacyA: [{ role: 'user', content: 'old' }],
        legacyB: [{ role: 'assistant', content: 'reply' }],
      },
    }), 'utf8')
    const store = await loadStore(userData)

    expect(store.loadConversation('legacyA')).toEqual([{ role: 'user', content: 'old' }])
    expect(store.loadConversation('legacyB')).toEqual([{ role: 'assistant', content: 'reply' }])
    expect(conversationFiles(userData)).toHaveLength(2)
    expect(existsSync(join(userData, 'conversations', '.agent-conversations-migrated'))).toBe(true)
  })

  it('recovers from legacy when a migration marker exists but a shard is missing', async () => {
    const userData = tempUserData('lazy-recovery')
    writeFileSync(join(userData, 'agent-conversations.json'), JSON.stringify({
      conversations: {
        legacyA: [{ role: 'user', content: 'still here' }],
      },
    }), 'utf8')
    const conversationsDir = join(userData, 'conversations')
    const first = await loadStore(userData)
    expect(first.loadConversation('legacyA')).toEqual([{ role: 'user', content: 'still here' }])
    const shard = conversationFiles(userData)[0]
    unlinkSync(join(conversationsDir, shard))

    const second = await loadStore(userData)

    expect(second.loadConversation('legacyA')).toEqual([{ role: 'user', content: 'still here' }])
    expect(conversationFiles(userData)).toHaveLength(1)
  })

  it('clears only the requested session shard without resurrecting legacy data', async () => {
    const userData = tempUserData('clear')
    writeFileSync(join(userData, 'agent-conversations.json'), JSON.stringify({
      conversations: {
        'session-a': [{ role: 'user', content: 'old remove me' }],
        'session-b': [{ role: 'assistant', content: 'old keep me' }],
      },
    }), 'utf8')
    const store = await loadStore(userData)
    store.saveConversation('session-a', [{ role: 'user', content: 'remove me' }])
    store.saveConversation('session-b', [{ role: 'assistant', content: 'keep me' }])

    store.clearConversation('session-a')

    expect(store.loadConversation('session-a')).toEqual([])
    expect(store.loadConversation('session-b')).toEqual([{ role: 'assistant', content: 'keep me' }])
    const remaining = conversationFiles(userData)
    expect(remaining).toHaveLength(1)
    const payload = JSON.parse(readFileSync(join(userData, 'conversations', remaining[0]), 'utf8'))
    expect(payload).toEqual({ conversations: { 'session-b': [{ role: 'assistant', content: 'keep me' }] } })
  })
})

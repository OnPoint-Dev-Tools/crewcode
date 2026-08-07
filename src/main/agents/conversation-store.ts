import electron from 'electron'
import { createHash } from 'crypto'
import { basename, join } from 'path'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'

const { app } = electron

// Persists the message history for stateless HTTP providers (ollama, openrouter)
// so a thread survives idle-stop and app restart with full model context — the
// providers themselves keep no server-side session, so we replay the stored
// history on the next prompt. Keyed by the bridge's stable conversation key.
// System prompts are NOT stored — they're re-derived from the current mode.

export interface StoredMessage {
  role:    'user' | 'assistant'
  content: string
}

interface LegacyConversationStore {
  // session id → ordered message history
  conversations: Record<string, StoredMessage[]>
}

interface CurrentShardConversationFile {
  sessionId: string
  messages:  StoredMessage[]
}

// Soft cap so a runaway thread can't grow the file unbounded. Keeps the most
// recent turns, which is what matters for context.
const MAX_MESSAGES = 400
const LEGACY_FILE = 'agent-conversations.json'
const CONVERSATIONS_DIR = 'conversations'
const MIGRATION_MARKER = '.agent-conversations-migrated'
const CLEARED_SESSIONS_FILE = '.agent-conversations-cleared.json'

const cache = new Map<string, StoredMessage[]>()
let migrationChecked = false
let legacyCache: LegacyConversationStore | null = null
let clearedCache: Set<string> | null = null

function userDataDir(): string {
  const dir = process.env.CREWCODE_DATA_DIR || app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function legacyStorePath(): string {
  return join(userDataDir(), LEGACY_FILE)
}

function conversationsDir(): string {
  const dir = join(userDataDir(), CONVERSATIONS_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function migrationMarkerPath(): string {
  return join(conversationsDir(), MIGRATION_MARKER)
}

function clearedSessionsPath(): string {
  return join(conversationsDir(), CLEARED_SESSIONS_FILE)
}

function conversationFileName(sessionId: string): string {
  // Conversation keys can contain path separators, provider prefixes, or other
  // OS-hostile characters. A stable digest gives one safe file per session.
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 24)
  return `agent-conversations.${digest}.json`
}

function conversationPath(sessionId: string): string {
  return join(conversationsDir(), conversationFileName(sessionId))
}

function normalizeMessages(value: unknown): StoredMessage[] {
  if (!Array.isArray(value)) return []
  return value.filter((message): message is StoredMessage => {
    if (!message || typeof message !== 'object') return false
    const candidate = message as Partial<StoredMessage>
    return (candidate.role === 'user' || candidate.role === 'assistant')
      && typeof candidate.content === 'string'
  })
}

function readLegacyStore(): LegacyConversationStore {
  if (legacyCache) return legacyCache
  const p = legacyStorePath()
  if (!existsSync(p)) {
    legacyCache = { conversations: {} }
    return legacyCache
  }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as LegacyConversationStore
    legacyCache = parsed && typeof parsed === 'object' && parsed.conversations
      ? parsed
      : { conversations: {} }
  } catch {
    legacyCache = { conversations: {} }
  }
  return legacyCache
}

function readClearedSessions(): Set<string> {
  if (clearedCache) return clearedCache
  const p = clearedSessionsPath()
  if (!existsSync(p)) {
    clearedCache = new Set()
    return clearedCache
  }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    clearedCache = new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    clearedCache = new Set()
  }
  return clearedCache
}

function markCleared(sessionId: string): void {
  const cleared = readClearedSessions()
  cleared.add(sessionId)
  writeFileSync(clearedSessionsPath(), JSON.stringify([...cleared]), 'utf8')
}

function unmarkCleared(sessionId: string): void {
  const cleared = readClearedSessions()
  if (!cleared.delete(sessionId)) return
  writeFileSync(clearedSessionsPath(), JSON.stringify([...cleared]), 'utf8')
}

function writeConversationFile(sessionId: string, messages: StoredMessage[]): void {
  const trimmed = messages.length > MAX_MESSAGES ? messages.slice(-MAX_MESSAGES) : messages
  // Keep the exact legacy shape, but with only this session's key. That makes a
  // shard a literal slice of the old agent-conversations.json monolith.
  const payload: LegacyConversationStore = { conversations: { [sessionId]: trimmed } }
  writeFileSync(conversationPath(sessionId), JSON.stringify(payload), 'utf8')
  cache.set(sessionId, trimmed.slice())
  unmarkCleared(sessionId)
}

function ensureLegacyMigrated(): void {
  if (migrationChecked) return
  migrationChecked = true

  const marker = migrationMarkerPath()
  const legacy = readLegacyStore()
  if (existsSync(marker)) return

  for (const [sessionId, messages] of Object.entries(legacy.conversations)) {
    if (!sessionId || readClearedSessions().has(sessionId)) continue
    const p = conversationPath(sessionId)
    // Do not overwrite newer sharded files if the app was already partially
    // migrated. The legacy file is kept as a backup, not the source of truth.
    if (!existsSync(p)) writeConversationFile(sessionId, normalizeMessages(messages))
  }
  writeFileSync(marker, JSON.stringify({ migratedAt: new Date().toISOString(), legacyFile: basename(legacyStorePath()) }), 'utf8')
}

function readConversationFile(sessionId: string): StoredMessage[] {
  ensureLegacyMigrated()
  if (cache.has(sessionId)) return cache.get(sessionId)!.slice()

  const p = conversationPath(sessionId)
  if (!existsSync(p)) {
    const legacyMessages = readClearedSessions().has(sessionId)
      ? []
      : normalizeMessages(readLegacyStore().conversations[sessionId])
    if (legacyMessages.length > 0) {
      // Lazy fallback covers installs that already wrote the migration marker
      // before a shard existed or where a shard was lost/corrupted.
      writeConversationFile(sessionId, legacyMessages)
      return legacyMessages.slice()
    }
    cache.set(sessionId, [])
    return []
  }

  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as LegacyConversationStore | CurrentShardConversationFile
    if ('conversations' in parsed) {
      const messages = normalizeMessages(parsed.conversations?.[sessionId])
      cache.set(sessionId, messages)
      return messages.slice()
    }
    const messages = normalizeMessages(parsed.messages)
    if (messages.length > 0) {
      writeConversationFile(sessionId, messages)
      return messages.slice()
    }
    cache.set(sessionId, messages)
    return messages.slice()
  } catch {
    const legacyMessages = readClearedSessions().has(sessionId)
      ? []
      : normalizeMessages(readLegacyStore().conversations[sessionId])
    if (legacyMessages.length > 0) {
      writeConversationFile(sessionId, legacyMessages)
      return legacyMessages.slice()
    }
    cache.set(sessionId, [])
    return []
  }
}

export function loadConversation(sessionId: string): StoredMessage[] {
  return readConversationFile(sessionId)
}

export function saveConversation(sessionId: string, messages: StoredMessage[]): void {
  ensureLegacyMigrated()
  writeConversationFile(sessionId, messages)
}

export function clearConversation(sessionId: string): void {
  ensureLegacyMigrated()
  cache.delete(sessionId)
  markCleared(sessionId)
  const p = conversationPath(sessionId)
  if (!existsSync(p)) return
  try { unlinkSync(p) } catch { /* best effort */ }
}

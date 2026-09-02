import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, promises as fsp } from 'fs'
import { dirname, join } from 'path'
import { titleFromFirstMessage } from '../shared/chat-title'
import type { ContinuityTranscriptEntry } from '../shared/continuity-state-types'

type TranscriptMessage = Record<string, unknown>

interface TranscriptFile {
  scopeId: string
  messages: TranscriptMessage[]
}

export interface TranscriptBatchEntry {
  scopeId: string
  messages: unknown[]
}

export interface RecentTranscriptSummary {
  scopeId: string
  updatedAt: number
  firstUserText: string | null
}

const FILE_PREFIX = 'transcript.'
// Startup may hydrate up to 32 L1 scopes over one relay connection. Keep their
// combined plaintext below 3 MiB so encryption/base64 framing and the other
// startup RPCs retain headroom inside the Hub's shared 8 MiB burst budget.
const MAX_SCOPE_LOAD_BYTES = 96 * 1024
const MAX_CATALOGUE_ENTRIES = 2_000
const SCOPE_HEADER_BYTES = 4 * 1024
const TITLE_HINT_MAX = 80

function decodeJsonString(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(`"${raw}"`) as unknown
    return typeof parsed === 'string' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** First user prompt from the shard header only — never a transcript body. */
function titleHintFromHeader(header: string): string | undefined {
  const match = header.match(/"kind"\s*:\s*"user"[\s\S]{0,800}?"text"\s*:\s*"((?:\\.|[^"\\])*)"/)
    ?? header.match(/"role"\s*:\s*"user"[\s\S]{0,800}?"text"\s*:\s*"((?:\\.|[^"\\])*)"/)
  if (!match) return undefined
  const text = decodeJsonString(match[1]!)?.trim()
  if (!text) return undefined
  const title = titleFromFirstMessage(text).trim()
  return title ? title.slice(0, TITLE_HINT_MAX) : undefined
}

function normalizeMessages(value: unknown): TranscriptMessage[] {
  if (!Array.isArray(value)) return []
  return value.filter((message): message is TranscriptMessage => !!message && typeof message === 'object')
}

function boundedMessageTail(value: unknown): TranscriptMessage[] {
  const messages = normalizeMessages(value)
  const tail: TranscriptMessage[] = []
  let bytes = 2
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    let encoded: string
    try { encoded = JSON.stringify(messages[index]) } catch { continue }
    const nextBytes = Buffer.byteLength(encoded) + (tail.length ? 1 : 0)
    if (nextBytes > MAX_SCOPE_LOAD_BYTES) continue
    if (bytes + nextBytes > MAX_SCOPE_LOAD_BYTES) break
    tail.unshift(messages[index]!)
    bytes += nextBytes
  }
  return tail
}

function messageIdentity(message: TranscriptMessage): string {
  const kind = typeof message.kind === 'string' ? message.kind : typeof message.role === 'string' ? message.role : 'message'
  if (typeof message.activityRunId === 'string') return `${kind}:activity:${message.activityRunId}`
  if (typeof message.toolCallId === 'string') return `${kind}:tool:${message.toolCallId}`
  if (typeof message.id === 'string') return `${kind}:id:${message.id}`
  if (typeof message.turnId === 'string') {
    const segment = typeof message.segmentId === 'string' ? `:${message.segmentId}` : ''
    return `${kind}:turn:${message.turnId}${segment}`
  }
  // Renderer-generated user/system rows intentionally have no persistent id.
  // Their display clock is local to each client, so including it would turn
  // one Brain event into separate desktop and browser rows. Occurrence suffixes
  // still distinguish intentional repeated messages with the same content.
  const { time: _displayTime, ...content } = message
  return `${kind}:value:${JSON.stringify(content)}`
}

/**
 * Full-array saves from two owner clients may be based on different snapshots.
 * Merge by stable message identity so a later stale save cannot erase a turn
 * that the Brain already observed. Occurrence suffixes preserve intentional
 * repeated user/system rows with otherwise identical content.
 */
export function mergeTranscriptMessages(current: TranscriptMessage[], incoming: TranscriptMessage[]): TranscriptMessage[] {
  const next = current.map(message => ({ ...message }))
  const indexByIdentity = new Map<string, number>()
  const currentOccurrences = new Map<string, number>()
  for (let index = 0; index < next.length; index += 1) {
    const base = messageIdentity(next[index]!)
    const occurrence = currentOccurrences.get(base) ?? 0
    currentOccurrences.set(base, occurrence + 1)
    indexByIdentity.set(`${base}#${occurrence}`, index)
  }
  const incomingOccurrences = new Map<string, number>()
  for (const message of incoming) {
    const base = messageIdentity(message)
    const occurrence = incomingOccurrences.get(base) ?? 0
    incomingOccurrences.set(base, occurrence + 1)
    const identity = `${base}#${occurrence}`
    const existingIndex = indexByIdentity.get(identity)
    if (existingIndex === undefined) {
      indexByIdentity.set(identity, next.length)
      next.push(message)
    } else {
      next[existingIndex] = message
    }
  }
  return next
}

/** Transport-neutral transcript persistence used by the authenticated web API. */
export class TranscriptService {
  private readonly directory: string
  private mtimeByScope: Record<string, number> | null = null

  constructor(dataDir: string) {
    this.directory = join(dataDir, 'transcripts')
    mkdirSync(this.directory, { recursive: true })
  }

  private pathFor(scopeId: string): string {
    const digest = createHash('sha256').update(scopeId).digest('hex').slice(0, 24)
    return join(this.directory, `${FILE_PREFIX}${digest}.json`)
  }

  loadScope(scopeId: string): TranscriptMessage[] {
    if (!scopeId) return []
    try {
      const parsed = JSON.parse(readFileSync(this.pathFor(scopeId), 'utf8')) as TranscriptFile
      return parsed?.scopeId === scopeId ? boundedMessageTail(parsed.messages) : []
    } catch {
      return []
    }
  }

  loadAll(): Record<string, TranscriptMessage[]> {
    const transcripts: Record<string, TranscriptMessage[]> = {}
    const mtimes: Record<string, number> = {}
    for (const name of this.entries()) {
      try {
        const fullPath = join(this.directory, name)
        const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as TranscriptFile
        if (!parsed || typeof parsed.scopeId !== 'string') continue
        transcripts[parsed.scopeId] = normalizeMessages(parsed.messages)
        mtimes[parsed.scopeId] = statSync(fullPath).mtimeMs
      } catch { /* skip corrupt shards */ }
    }
    this.mtimeByScope = mtimes
    return transcripts
  }

  mtimes(): Record<string, number> {
    if (!this.mtimeByScope) this.loadAll()
    return { ...(this.mtimeByScope ?? {}) }
  }

  /** Metadata-only catalogue for recovery after a renderer catalogue was lost.
   * Reads only the small scope-id header plus file metadata, never message bodies. */
  async catalogue(limit = MAX_CATALOGUE_ENTRIES): Promise<ContinuityTranscriptEntry[]> {
    const boundedLimit = Math.max(0, Math.min(MAX_CATALOGUE_ENTRIES, Math.floor(limit)))
    if (boundedLimit === 0) return []
    let names: string[]
    try { names = (await fsp.readdir(this.directory)).filter(name => name.startsWith(FILE_PREFIX) && name.endsWith('.json')) } catch { return [] }
    const entries = await Promise.all(names.map(async name => {
      const fullPath = join(this.directory, name)
      let handle: Awaited<ReturnType<typeof fsp.open>> | null = null
      try {
        handle = await fsp.open(fullPath, 'r')
        const header = Buffer.alloc(SCOPE_HEADER_BYTES)
        const { bytesRead } = await handle.read(header, 0, header.byteLength, 0)
        const match = header.subarray(0, bytesRead).toString('utf8').match(/^\{"scopeId":("(?:\\.|[^"\\])*")/)
        if (!match) return null
        const scopeId = JSON.parse(match[1]!) as unknown
        if (typeof scopeId !== 'string' || !scopeId) return null
        const stat = await handle.stat()
        const titleHint = titleHintFromHeader(header.subarray(0, bytesRead).toString('utf8'))
        return { scopeId, updatedAt: stat.mtimeMs, ...(titleHint ? { titleHint } : {}) } satisfies ContinuityTranscriptEntry
      } catch {
        return null
      } finally {
        await handle?.close().catch(() => undefined)
      }
    }))
    return entries
      .filter((entry): entry is ContinuityTranscriptEntry => entry !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, boundedLimit)
  }

  /** Small metadata-only view for mobile dashboards; never returns transcript bodies. */
  recent(limit = 5): RecentTranscriptSummary[] {
    const boundedLimit = Math.max(0, Math.min(20, Math.floor(limit)))
    if (boundedLimit === 0) return []
    const summaries: RecentTranscriptSummary[] = []
    for (const name of this.entries()) {
      try {
        const fullPath = join(this.directory, name)
        const parsed = JSON.parse(readFileSync(fullPath, 'utf8')) as TranscriptFile
        if (!parsed || typeof parsed.scopeId !== 'string') continue
        const messages = normalizeMessages(parsed.messages)
        const firstUser = messages.find(message => message.kind === 'user' || message.role === 'user')
        const text = typeof firstUser?.text === 'string'
          ? firstUser.text
          : typeof firstUser?.content === 'string' ? firstUser.content : ''
        summaries.push({
          scopeId: parsed.scopeId,
          updatedAt: statSync(fullPath).mtimeMs,
          firstUserText: text.trim() ? text.trim().slice(0, 240) : null,
        })
      } catch { /* skip corrupt shards */ }
    }
    return summaries.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, boundedLimit)
  }

  save(scopeId: string, messages: unknown): { ok?: true; error?: string } {
    if (!scopeId) return { error: 'missing scope' }
    mkdirSync(dirname(this.pathFor(scopeId)), { recursive: true })
    let current: TranscriptMessage[] = []
    const path = this.pathFor(scopeId)
    if (existsSync(path)) {
      try { current = normalizeMessages((JSON.parse(readFileSync(path, 'utf8')) as TranscriptFile).messages) } catch { /* replace corrupt shard */ }
    }
    const payload: TranscriptFile = { scopeId, messages: mergeTranscriptMessages(current, normalizeMessages(messages)) }
    writeFileSync(path, JSON.stringify(payload), 'utf8')
    ;(this.mtimeByScope ??= {})[scopeId] = Date.now()
    return { ok: true }
  }

  saveBatch(entries: TranscriptBatchEntry[]): { ok: true } {
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (entry && typeof entry.scopeId === 'string') this.save(entry.scopeId, entry.messages)
    }
    return { ok: true }
  }

  remove(scopeId: string): { ok: true } {
    if (scopeId) {
      const path = this.pathFor(scopeId)
      if (existsSync(path)) { try { unlinkSync(path) } catch { /* best effort */ } }
      if (this.mtimeByScope) delete this.mtimeByScope[scopeId]
    }
    return { ok: true }
  }

  private entries(): string[] {
    try {
      return readdirSync(this.directory).filter(name => name.startsWith(FILE_PREFIX) && name.endsWith('.json'))
    } catch {
      return []
    }
  }
}

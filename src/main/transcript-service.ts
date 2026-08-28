import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

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

function normalizeMessages(value: unknown): TranscriptMessage[] {
  if (!Array.isArray(value)) return []
  return value.filter((message): message is TranscriptMessage => !!message && typeof message === 'object')
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
    const payload: TranscriptFile = { scopeId, messages: normalizeMessages(messages) }
    writeFileSync(this.pathFor(scopeId), JSON.stringify(payload), 'utf8')
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

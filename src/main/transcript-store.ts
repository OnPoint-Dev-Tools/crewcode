import electron from 'electron'
import { createHash } from 'crypto'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, promises as fsp } from 'fs'

const { app, ipcMain } = electron

// Authoritative, unbounded on-disk store for the rich renderer chat transcript
// (the full `Message[]` the chat UI renders). The renderer also keeps a bounded
// localStorage copy for instant paint, but localStorage has a hard ~5MB
// per-origin quota that silently dropped recent messages once exceeded; disk has
// no such limit, so this is the source of truth. One file per scope, named by a
// digest of the scope id (scope ids contain `::`/`/` and provider suffixes that
// are OS-hostile). Messages are stored opaquely — main never inspects their
// shape, so the renderer Message type stays renderer-only.

type TranscriptMessage = Record<string, unknown>

interface TranscriptFile {
  scopeId:  string
  messages: TranscriptMessage[]
}

interface SyncBatchEntry {
  scopeId:  string
  messages: TranscriptMessage[]
}

const TRANSCRIPTS_DIR = 'transcripts'
const FILE_PREFIX = 'transcript.'

// Transcript files are app-owned, so keep their activity timestamps in memory
// after the launch scan. Re-reading and JSON-parsing every shard per Mission
// Control refresh blocked Browser main for 1.2–1.3 seconds on tool events.
let mtimeByScope: Record<string, number> | null = null

function userDataDir(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function transcriptsDir(): string {
  const dir = join(userDataDir(), TRANSCRIPTS_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function transcriptPath(scopeId: string): string {
  const digest = createHash('sha256').update(scopeId).digest('hex').slice(0, 24)
  return join(transcriptsDir(), `${FILE_PREFIX}${digest}.json`)
}

function normalizeMessages(value: unknown): TranscriptMessage[] {
  if (!Array.isArray(value)) return []
  return value.filter((m): m is TranscriptMessage => !!m && typeof m === 'object')
}

function readAll(): Record<string, TranscriptMessage[]> {
  const out: Record<string, TranscriptMessage[]> = {}
  const mtimes: Record<string, number> = {}
  let entries: string[]
  try { entries = readdirSync(transcriptsDir()) } catch { return out }
  for (const name of entries) {
    if (!name.startsWith(FILE_PREFIX) || !name.endsWith('.json')) continue
    try {
      const full = join(transcriptsDir(), name)
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as TranscriptFile
      if (parsed && typeof parsed.scopeId === 'string') {
        out[parsed.scopeId] = normalizeMessages(parsed.messages)
        mtimes[parsed.scopeId] = statSync(full).mtimeMs
      }
    } catch { /* skip a corrupt shard rather than fail the whole load */ }
  }
  mtimeByScope = mtimes
  return out
}

function readScope(scopeId: string): TranscriptMessage[] {
  if (!scopeId) return []
  try {
    const parsed = JSON.parse(readFileSync(transcriptPath(scopeId), 'utf8')) as TranscriptFile
    // Local Electron IPC has no encrypted relay frame limit. Return the complete
    // shard so a later full-array save cannot overwrite history that the renderer
    // never received. The Brain-facing TranscriptService applies its transport cap
    // and merges bounded client saves into the complete authoritative shard.
    return parsed?.scopeId === scopeId ? normalizeMessages(parsed.messages) : []
  } catch {
    return []
  }
}

// Per-scope last-write epoch (ms). The transcript file is rewritten whenever a
// scope's messages change, so its mtime is a real "last used" timestamp — unlike
// the messages' time-of-day-only strings, which carry no date.
function readMtimes(): Record<string, number> {
  if (mtimeByScope) return { ...mtimeByScope }

  const out: Record<string, number> = {}
  let entries: string[]
  try { entries = readdirSync(transcriptsDir()) } catch { return out }
  for (const name of entries) {
    if (!name.startsWith(FILE_PREFIX) || !name.endsWith('.json')) continue
    const full = join(transcriptsDir(), name)
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as TranscriptFile
      if (parsed && typeof parsed.scopeId === 'string') out[parsed.scopeId] = statSync(full).mtimeMs
    } catch { /* one-time legacy scan skips corrupt shards */ }
  }
  mtimeByScope = out
  return { ...out }
}

function writeScope(scopeId: string, messages: unknown): void {
  if (!scopeId) return
  const payload: TranscriptFile = { scopeId, messages: normalizeMessages(messages) }
  writeFileSync(transcriptPath(scopeId), JSON.stringify(payload), 'utf8')
  ;(mtimeByScope ??= {})[scopeId] = Date.now()
}

// Last-wins async write queue for the streaming save path. During a live turn
// the renderer rewrites the same scope every flush; only the newest payload per
// scope matters, and draining sequentially off the IPC handler keeps a multi-MB
// file write from blocking main-process event delivery (PTY data, window events)
// on every save. The stringify itself still runs on this thread — the queue
// bounds how often, not whether, it runs.
const pendingWrites = new Map<string, TranscriptMessage[]>()
let draining = false

async function drainWrites(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (pendingWrites.size > 0) {
      const next = pendingWrites.entries().next().value as [string, TranscriptMessage[]]
      pendingWrites.delete(next[0])
      const payload: TranscriptFile = { scopeId: next[0], messages: normalizeMessages(next[1]) }
      try {
        await fsp.writeFile(transcriptPath(next[0]), JSON.stringify(payload), 'utf8')
        ;(mtimeByScope ??= {})[next[0]] = Date.now()
      } catch { /* per-scope best effort; the next save for this scope retries */ }
    }
  } finally {
    draining = false
  }
}

function removeScope(scopeId: string): void {
  if (!scopeId) return
  const p = transcriptPath(scopeId)
  if (existsSync(p)) { try { unlinkSync(p) } catch { /* best effort */ } }
  if (mtimeByScope) delete mtimeByScope[scopeId]
}

export function registerTranscriptIpc(): void {
  ipcMain.handle('transcripts:loadAll', () => readAll())
  ipcMain.handle('transcripts:load', (_event, scopeId: string) => readScope(scopeId))

  // Real per-scope last-activity epochs for Mission Control's "N ago" labels.
  ipcMain.handle('transcripts:mtimes', () => readMtimes())

  ipcMain.handle('transcripts:save', (_e, scopeId: string, messages: TranscriptMessage[]) => {
    if (!scopeId) return { error: 'missing scope' }
    pendingWrites.set(scopeId, messages)
    void drainWrites()
    return { ok: true }
  })

  ipcMain.handle('transcripts:remove', (_e, scopeId: string) => {
    removeScope(scopeId)
    return { ok: true }
  })

  // Synchronous batch used only on window teardown (pagehide/beforeunload), where
  // an async invoke could be dropped before it lands. Blocks the renderer briefly
  // so the last settled turn is guaranteed to disk.
  ipcMain.on('transcripts:saveSyncBatch', (e, entries: SyncBatchEntry[]) => {
    try {
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (entry && typeof entry.scopeId === 'string') {
          // Teardown data supersedes anything still queued for this scope; drop
          // the queued payload so a stale async write can't land after it. (A
          // write already in flight for the same scope is a millisecond-scale
          // race; launch hydration prefers the longer L1 copy, so worst case is
          // one flush of staleness, not data loss.)
          pendingWrites.delete(entry.scopeId)
          writeScope(entry.scopeId, entry.messages)
        }
      }
      e.returnValue = true
    } catch {
      e.returnValue = false
    }
  })
}

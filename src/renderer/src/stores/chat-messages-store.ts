/**
 * Central store for chat messages, keyed by scope id (sessionId or `crew/<laneId>`).
 *
 * Lives outside React so the hot streaming write path (a token per delta) can
 * mutate state imperatively without re-rendering App.tsx and cascading through
 * the unmemoized shell (terminals, editor, sidebar). Components subscribe to the
 * narrowest slice they need via the selector hooks below.
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { Message } from '../types'

const STORAGE_KEY = 'crewcode:messagesByTab'

/** Shared empty slice so scopes with no messages keep a stable reference and
 *  don't trigger spurious re-renders through the selector. */
const EMPTY: Message[] = []

function loadInitial(): Record<string, Message[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, Message[]>) : {}
  } catch {
    return {}
  }
}

type Updater = Record<string, Message[]> | ((prev: Record<string, Message[]>) => Record<string, Message[]>)

interface MessagesState {
  messagesByTab: Record<string, Message[]>
  // Dispatch-compatible so existing `setMessagesByTab(prev => ...)` call sites work unchanged.
  setMessagesByTab: (value: Updater) => void
  setMessagesForTab: (tabId: string, updater: (prev: Message[]) => Message[]) => void
}

export const useMessagesStore = create<MessagesState>((set) => ({
  messagesByTab: loadInitial(),
  setMessagesByTab: (value) =>
    set((s) => ({
      messagesByTab: typeof value === 'function' ? value(s.messagesByTab) : value,
    })),
  setMessagesForTab: (tabId, updater) =>
    set((s) => {
      const prevMessages = s.messagesByTab[tabId] ?? EMPTY
      const nextMessages = updater(prevMessages)
      if (nextMessages === prevMessages) return s
      return { messagesByTab: { ...s.messagesByTab, [tabId]: nextMessages } }
    }),
}))

// ─── Persistence ─────────────────────────────────────────────────────────────
// Two layers, both stripping live `streaming`/`pending` flags so a reload never
// restores a frozen "in-progress" turn:
//
//   L1 — localStorage (this file). A bounded, synchronous cache that paints the
//        transcript instantly on launch. localStorage has a hard ~5MB per-origin
//        quota; the map used to grow past it and `setItem` threw QuotaExceededError,
//        which the old code swallowed — silently dropping EVERY new turn from then
//        on (the "recent messages vanish on restart" bug). L1 now caps each scope's
//        tail and, on quota, evicts the least-recently-touched scopes so the newest
//        conversation always wins the remaining space.
//
//   L2 — on-disk transcript store (main process, `transcript-store.ts`). The
//        authoritative, unbounded source of truth: one file per scope, full rich
//        history. Hydrated into the store on launch (backfilling anything L1
//        evicted) and written back on the same settle/debounce cadence, with a
//        synchronous batch on window teardown so an abrupt quit can't drop the
//        last turn. Because L2 exists, an L1 eviction is no longer data loss.

// Tail L1 retains per scope. The DOM pager only renders the most recent rows and
// L2 holds the full history, so trimming the localStorage tail is lossless.
// Sized just above the pager's PAGE_SIZE (50): retaining 300 hoarded megabytes
// of tool-result blobs that were never rendered, and made every write O(huge).
const MAX_PERSISTED_MESSAGES_PER_SCOPE = 60

// L1 is a fast-paint cache, not storage. Bound it hard so a write is cheap and
// can't push localStorage (~5MB/origin) into its quota-thrash path.
const MAX_PERSISTED_SCOPES = 8
const L1_BYTE_BUDGET = 2_000_000
const PER_SCOPE_BYTE_CAP = 400_000

// Bumped whenever a scope's message array changes, so quota eviction can drop
// cold conversations first and never sacrifice the active/most-recent thread.
// A monotonic counter, NOT Date.now(): two scopes touched inside the same
// millisecond would tie, and the tiebreak could shed the newest conversation.
const scopeLastTouched = new Map<string, number>()
let touchSeq = 0

function hasLiveMessage(messages: Message[]): boolean {
  // The live marker is almost always in the latest turn; scan backwards so token
  // writes don't walk an entire long transcript before every debounce reset.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (msg.kind === 'thinking' && msg.streaming === true) return true
    if (msg.kind === 'agent' && msg.streaming === true) return true
    if (msg.kind === 'toolcall' && (msg.status === 'pending' || msg.status === 'running')) return true
  }
  return false
}

function durabilityToken(messages: Message[]): string {
  return `${messages.length}:${hasLiveMessage(messages) ? 'live' : 'settled'}`
}

function initialDurabilityByScope(map: Record<string, Message[]>): Map<string, string> {
  return new Map(Object.entries(map).map(([scope, messages]) => [scope, durabilityToken(messages)]))
}

function needsStrip(msg: Message): boolean {
  if (msg.kind === 'thinking' || msg.kind === 'agent') return msg.streaming === true
  if (msg.kind === 'toolcall') return msg.status === 'pending' || msg.status === 'running'
  return false
}

// Settled transcripts are the common case (only the tail of a live turn ever
// carries a live flag), so avoid rebuilding the whole array — this ran on every
// structural message and allocated a full copy of the transcript each time.
function stripLiveFlags(messages: Message[]): Message[] {
  let firstLive = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (needsStrip(messages[i])) { firstLive = i; break }
  }
  if (firstLive === -1) return messages

  const next = messages.slice()
  for (let i = 0; i <= firstLive; i += 1) {
    const msg = next[i]
    if (msg.kind === 'thinking' && msg.streaming) next[i] = { ...msg, streaming: false }
    else if (msg.kind === 'agent' && msg.streaming) next[i] = { ...msg, streaming: false }
    else if (msg.kind === 'toolcall' && (msg.status === 'pending' || msg.status === 'running')) {
      next[i] = { ...msg, status: 'completed' as const }
    }
  }
  return next
}

// L1 (localStorage) — bounded tail. L2 (disk) keeps the full history.
function sanitizeForPersist(messages: Message[]): Message[] {
  const bounded = messages.length > MAX_PERSISTED_MESSAGES_PER_SCOPE
    ? messages.slice(-MAX_PERSISTED_MESSAGES_PER_SCOPE)
    : messages
  return stripLiveFlags(bounded)
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException &&
    (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22)
}

/**
 * Serialized-tail cache, keyed by the scope's `Message[]` identity.
 *
 * A write touches ONE scope, but the payload needs all of them. Re-stringifying
 * every scope each time made an L1 write cost O(all conversations) — measured at
 * 20-28ms per structural message (i.e. per tool call), which is a dropped frame
 * or two of visible jank. Message arrays are replaced immutably on every change,
 * so reference equality proves a scope's serialization is still valid. A
 * WeakMap keeps entries alive exactly as long as the array is reachable.
 */
const serializedByMessages = new WeakMap<Message[], string | null>()

/**
 * Serialize one scope's bounded tail exactly once. A handful of huge tool
 * results can blow the per-scope cap on their own, so halve the tail until it
 * fits rather than letting one conversation consume the whole L1 budget.
 */
function serializeScope(messages: Message[]): string | null {
  const cached = serializedByMessages.get(messages)
  if (cached !== undefined) return cached

  let tail = sanitizeForPersist(messages)
  let json = JSON.stringify(tail)
  while (json.length > PER_SCOPE_BYTE_CAP && tail.length > 4) {
    tail = tail.slice(Math.ceil(tail.length / 2))
    json = JSON.stringify(tail)
  }
  const result = json.length > PER_SCOPE_BYTE_CAP ? null : json
  serializedByMessages.set(messages, result)
  return result
}

/**
 * Write the L1 fast-paint cache.
 *
 * This used to stringify the ENTIRE message map, and on quota (the steady state,
 * since that's why eviction exists) re-stringify it once per evicted scope —
 * O(scopes) multi-megabyte serializations plus a synchronous `setItem` each,
 * measured at >2s of blocked main thread per call. Now: each scope is serialized
 * once, the payload is assembled by string concat under an explicit byte budget
 * newest-first, and a retry only re-joins strings we already have.
 *
 * L2 (disk) holds full history and backfills on launch, so a scope that misses
 * the budget loses nothing but its instant-paint cache.
 */
function persist(map: Record<string, Message[]>): void {
  const newestFirst = Object.keys(map).sort(
    (a, b) => (scopeLastTouched.get(b) ?? 0) - (scopeLastTouched.get(a) ?? 0),
  )

  const parts: string[] = []
  let bytes = 0
  for (const scope of newestFirst) {
    if (parts.length >= MAX_PERSISTED_SCOPES) break
    const messages = map[scope]
    if (!messages?.length) continue
    const json = serializeScope(messages)
    if (json === null) continue
    if (parts.length > 0 && bytes + json.length > L1_BYTE_BUDGET) break
    parts.push(`${JSON.stringify(scope)}:${json}`)
    bytes += json.length
  }

  if (parts.length === 0) {
    try { localStorage.setItem(STORAGE_KEY, '{}') } catch { /* nothing to cache */ }
    return
  }

  // `parts` is newest-first, so shedding from the tail drops the coldest scope.
  for (let keep = parts.length; keep > 0; keep -= 1) {
    try {
      localStorage.setItem(STORAGE_KEY, `{${parts.slice(0, keep).join(',')}}`)
      return
    } catch (err) {
      // Non-quota failures (serialization, disabled storage) won't be fixed by
      // shedding scopes — stop rather than spin.
      if (!isQuotaError(err)) return
    }
  }
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* storage unavailable */ }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
let diskTimer: ReturnType<typeof setTimeout> | null = null
let diskDueAt = 0
const durabilityByScope = initialDurabilityByScope(useMessagesStore.getState().messagesByTab)

// Token-stream deltas may debounce lazily; structural changes (append/remove/
// turn settle) schedule a flush right away (bounded-idle, see flushDisk). Hard
// durability on quit is the teardown sync batch, not this cadence — but do not
// starve the structural flush either.
const DELTA_FLUSH_MS = 2000

// ── L2: on-disk transcript store ────────────────────────────────────────────
// Scopes whose threads changed since the last disk write. Suppressed during
// hydration so loading from disk doesn't immediately echo back as writes.
const dirtyScopes = new Set<string>()
let hydrating = false

function transcriptApi() {
  return typeof window !== 'undefined' ? window.electronAPI : undefined
}

/** Defer work to an idle slice so serialization doesn't land mid-frame. Falls
 *  back to running inline where requestIdleCallback is unavailable (tests). */
function runWhenIdle(run: () => void, timeout: number): void {
  const ric = typeof window !== 'undefined' ? window.requestIdleCallback : undefined
  if (ric) ric(run, { timeout })
  else run()
}

function flushDiskNow(sync: boolean): void {
  if (dirtyScopes.size === 0) return
  const api = transcriptApi()
  if (!api?.transcriptsSave) { dirtyScopes.clear(); return }
  const map = useMessagesStore.getState().messagesByTab
  // Never structured-clone a growing transcript mid-turn. Normal teardown still
  // includes live scopes; otherwise they remain dirty until their turn settles.
  const scopes = [...dirtyScopes].filter(scopeId => sync || !hasLiveMessage(map[scopeId] ?? EMPTY))
  if (scopes.length === 0) return
  const entries = scopes.map((scopeId) => ({ scopeId, messages: stripLiveFlags(map[scopeId] ?? EMPTY) }))
  for (const scopeId of scopes) dirtyScopes.delete(scopeId)
  if (sync && api.transcriptsSaveSyncBatch) {
    try { api.transcriptsSaveSyncBatch(entries) } catch { /* teardown best-effort */ }
    return
  }
  for (const { scopeId, messages } of entries) api.transcriptsSave(scopeId, messages)
}

let diskIdlePending = false

/** Write changed scopes' full history to disk. On teardown use the synchronous
 *  batch so an async invoke can't be dropped before the renderer dies.
 *
 *  The async path defers to bounded idle: the IPC structured-clone of a full
 *  transcript is the single largest renderer-thread cost during streaming, and
 *  running it mid-frame made background agent streams hiccup the visible tab.
 *  The idle timeout bounds staleness, and teardown's sync flush covers quit. */
function flushDisk(sync: boolean): void {
  if (dirtyScopes.size === 0) return
  if (sync) { flushDiskNow(true); return }
  if (diskIdlePending) return
  diskIdlePending = true
  runWhenIdle(() => { diskIdlePending = false; flushDiskNow(false) }, 500)
}

function scheduleL1Persist(delay = 1200): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    const map = useMessagesStore.getState().messagesByTab
    // localStorage stringify/setItem is synchronous. If any turn is live, wait
    // for its settle event rather than stealing a streaming frame.
    if (Object.values(map).some(hasLiveMessage)) return
    runWhenIdle(() => persist(useMessagesStore.getState().messagesByTab), 2000)
  }, delay)
}

/** Earliest-deadline scheduling: a structural change can pull the write earlier,
 *  but a burst of them can never push it out (no debounce starvation). */
function scheduleDiskFlush(delay = DELTA_FLUSH_MS): void {
  const due = Date.now() + delay
  if (diskTimer) {
    if (due >= diskDueAt) return
    clearTimeout(diskTimer)
  }
  diskDueAt = due
  diskTimer = setTimeout(() => {
    diskTimer = null
    diskDueAt = 0
    flushDisk(false)
  }, delay)
}

useMessagesStore.subscribe((state, prev) => {
  if (state.messagesByTab === prev.messagesByTab) return

  // Mark only scopes whose array changed. Token deltas replace one scope array;
  // avoid rebuilding/scanning the entire message map on every streamed chunk.
  let changedLive = false
  let changedSettled = false
  for (const scope in state.messagesByTab) {
    if (state.messagesByTab[scope] !== prev.messagesByTab[scope]) {
      touchSeq += 1
      scopeLastTouched.set(scope, touchSeq)
      if (!hydrating) dirtyScopes.add(scope)
      const messages = state.messagesByTab[scope] ?? EMPTY
      const nextToken = durabilityToken(messages)
      durabilityByScope.set(scope, nextToken)
      if (hasLiveMessage(messages)) changedLive = true
      else changedSettled = true
    }
  }
  for (const scope in prev.messagesByTab) {
    if (!(scope in state.messagesByTab)) {
      durabilityByScope.delete(scope)
      scopeLastTouched.delete(scope)
      changedSettled = true
    }
  }

  if (hydrating) return

  // Growing turns stay memory-only. Synchronous localStorage serialization and
  // full-transcript IPC cloning were the visible hitch on every structural row.
  if (changedLive && persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (changedSettled) {
    scheduleDiskFlush(0)
    scheduleL1Persist()
  }
})

// On launch, backfill from the authoritative disk store. L1 painted instantly
// from localStorage; disk fills any scope L1 evicted and restores full history
// for scopes L1 trimmed. Never clobber an in-memory scope that is already longer
// (a turn that arrived — and is only in L1 — during this async load wins).
export async function hydrateMessagesFromBackend(): Promise<void> {
  const api = transcriptApi()
  if (!api?.transcriptsLoadAll) return
  let disk: Record<string, Message[]>
  try { disk = await api.transcriptsLoadAll() } catch { return }
  if (!disk || Object.keys(disk).length === 0) return

  hydrating = true
  try {
    useMessagesStore.getState().setMessagesByTab((prev) => {
      const next = { ...prev }
      let changed = false
      for (const [scope, messages] of Object.entries(disk)) {
        if (!Array.isArray(messages) || messages.length === 0) continue
        if ((prev[scope]?.length ?? 0) <= messages.length) {
          next[scope] = messages
          changed = true
        }
      }
      return changed ? next : prev
    })
  } finally {
    hydrating = false
  }
}

// Flush pending token deltas before the window tears down or gets backgrounded.
// Electron app close does not reliably give React time to finish debounced work;
// disk uses the synchronous batch here so the last turn is guaranteed to land.
function flushAllOnTeardown(): void {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (diskTimer) {
    clearTimeout(diskTimer)
    diskTimer = null
  }
  diskDueAt = 0
  persist(useMessagesStore.getState().messagesByTab)
  flushDisk(true)
}
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushAllOnTeardown)
  window.addEventListener('pagehide', flushAllOnTeardown)
  void hydrateMessagesFromBackend()
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAllOnTeardown()
  })
}

// ─── Selector hooks ──────────────────────────────────────────────────────────

/** Subscribe to a single scope's messages. A streaming token re-renders only the
 *  components reading that scope, not the whole tree. */
export function useMessagesForScope(scopeId: string): Message[] {
  return useMessagesStore((s) => s.messagesByTab[scopeId] ?? EMPTY)
}

/** Per-scope message counts. Stable across streaming tokens (text grows but the
 *  count doesn't), so recency/drawer consumers don't re-render per delta. */
export function useMessagesForScopes(scopeIds: string[]): Record<string, Message[]> {
  return useMessagesStore(
    useShallow((s) => {
      const scoped: Record<string, Message[]> = {}
      for (const id of scopeIds) scoped[id] = s.messagesByTab[id] ?? EMPTY
      return scoped
    }),
  )
}

export function useScopeCounts(): Record<string, number> {
  return useMessagesStore(
    useShallow((s) => {
      const counts: Record<string, number> = {}
      for (const k in s.messagesByTab) counts[k] = s.messagesByTab[k].length
      return counts
    }),
  )
}

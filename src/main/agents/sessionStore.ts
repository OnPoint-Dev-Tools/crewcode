import electron from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

const { app } = electron

// Persists upstream session ids per (tabId, agentId) so chat threads survive
// app restarts. The key is the same composite the renderer uses for bridge
// registration so a one-to-one mapping holds across the IPC boundary.

// Minimal context snapshot persisted per session so the context meter survives
// app restarts. Without this the running baseline (`entry.lastUsage`) is
// memory-only and resets to 0 on resume, collapsing the meter on the first new
// turn even though the conversation context is unchanged.
export interface UsageSnapshot {
  contextTokens?: number
  contextWindow?: number
  model?: string
}

interface StoreShape {
  // "tabId:agentId" → upstream session id (provider-specific opaque string)
  sessions: Record<string, string>
  // "tabId:agentId" → last known context usage for the meter baseline
  usage?: Record<string, UsageSnapshot>
}

function storePath(): string {
  const dir = process.env.CREWCODE_DATA_DIR || app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'agent-sessions.json')
}

let cache: StoreShape | null = null

function read(): StoreShape {
  if (cache) return cache
  const p = storePath()
  if (!existsSync(p)) { cache = { sessions: {} }; return cache }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as StoreShape
    cache = parsed && typeof parsed === 'object' && parsed.sessions ? parsed : { sessions: {} }
  } catch {
    cache = { sessions: {} }
  }
  return cache
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function write(store: StoreShape): void {
  cache = store
  writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8')
}

export function getSessionId(tabAgentKey: string): string | undefined {
  return read().sessions[tabAgentKey]
}

export function setSessionId(tabAgentKey: string, sessionId: string): void {
  const store = read()
  if (store.sessions[tabAgentKey] === sessionId) return
  store.sessions[tabAgentKey] = sessionId
  write(store)
}

export function clearSessionId(tabAgentKey: string): void {
  const store = read()
  const hadSession = tabAgentKey in store.sessions
  const hadUsage = !!store.usage && tabAgentKey in store.usage
  if (!hadSession && !hadUsage) return
  delete store.sessions[tabAgentKey]
  if (store.usage) delete store.usage[tabAgentKey]
  write(store)
}

export function getUsageSnapshot(tabAgentKey: string): UsageSnapshot | undefined {
  return read().usage?.[tabAgentKey]
}

export function setUsageSnapshot(tabAgentKey: string, snapshot: UsageSnapshot): void {
  // Only persist meaningful context numbers; a snapshot without context tokens
  // would seed a useless baseline and risk masking a genuine fresh session.
  if (!isPositive(snapshot.contextTokens)) return
  const next: UsageSnapshot = { contextTokens: Math.floor(snapshot.contextTokens) }
  if (isPositive(snapshot.contextWindow)) next.contextWindow = Math.floor(snapshot.contextWindow)
  if (typeof snapshot.model === 'string' && snapshot.model) next.model = snapshot.model

  const store = read()
  const existing = store.usage?.[tabAgentKey]
  if (existing
    && existing.contextTokens === next.contextTokens
    && existing.contextWindow === next.contextWindow
    && existing.model === next.model) return
  store.usage = { ...(store.usage ?? {}), [tabAgentKey]: next }
  write(store)
}

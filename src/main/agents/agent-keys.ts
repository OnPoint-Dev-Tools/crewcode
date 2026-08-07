import electron from 'electron'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'

const { app } = electron

// Persists API keys for hosted agent providers (e.g. OpenRouter) so they
// survive restarts. Kept in main — never localStorage — and written 0600 so the
// secret isn't world-readable. Mirrors sessionStore's cache-and-write shape.

interface KeyStore {
  // provider id → API key
  keys: Record<string, string>
}

function storePath(): string {
  const dir = process.env.CREWCODE_DATA_DIR || app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'agent-keys.json')
}

let cache: KeyStore | null = null

function read(): KeyStore {
  if (cache) return cache
  const p = storePath()
  if (!existsSync(p)) { cache = { keys: {} }; return cache }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as KeyStore
    cache = parsed && typeof parsed === 'object' && parsed.keys ? parsed : { keys: {} }
  } catch {
    cache = { keys: {} }
  }
  return cache
}

function write(store: KeyStore): void {
  cache = store
  const p = storePath()
  writeFileSync(p, JSON.stringify(store, null, 2), 'utf8')
  // Restrict to the owner — best effort (no-op semantics on Windows).
  try { chmodSync(p, 0o600) } catch { /* ignore */ }
}

export function getAgentKey(provider: string): string | null {
  const key = read().keys[provider]
  return typeof key === 'string' && key.length > 0 ? key : null
}

export function hasAgentKey(provider: string): boolean {
  return getAgentKey(provider) !== null
}

/** Set (non-empty) or clear (null/empty) the key for a provider. */
export function setAgentKey(provider: string, key: string | null): void {
  const store = read()
  const next: KeyStore = { keys: { ...store.keys } }
  const trimmed = (key ?? '').trim()
  if (trimmed) next.keys[provider] = trimmed
  else delete next.keys[provider]
  write(next)
}

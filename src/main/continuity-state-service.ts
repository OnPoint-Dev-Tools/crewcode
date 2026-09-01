import { randomBytes } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { ContinuityStateSnapshot } from '../shared/continuity-state-types'

const ALLOWED_KEYS = new Set([
  'crewcode:sessionsByTab',
  'crewcode:activeSessionByTab',
  'crewcode:workspaceTabs:v1',
  'crewcode:activeWorkspaceId',
])
const MAX_VALUE_BYTES = 2 * 1024 * 1024

interface PersistedContinuityState {
  version: 1
  revision: number
  updatedAt: number
  values: Record<string, string>
}

function emptyState(): PersistedContinuityState {
  return { version: 1, revision: 0, updatedAt: 0, values: {} }
}

/** Small owner-only catalogue for renderer navigation state; transcripts remain separate. */
export class ContinuityStateService {
  private state: PersistedContinuityState
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    this.state = this.load()
  }

  snapshot(): ContinuityStateSnapshot {
    return JSON.parse(JSON.stringify(this.state)) as ContinuityStateSnapshot
  }

  update(values: unknown): ContinuityStateSnapshot {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('continuity values must be an object')
    const patch: Record<string, string> = {}
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      if (!ALLOWED_KEYS.has(key) || typeof value !== 'string') throw new Error(`continuity key is not allowed: ${key}`)
      if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new Error(`continuity value exceeds ${MAX_VALUE_BYTES} bytes: ${key}`)
      // Validate JSON-bearing keys before persisting them. activeWorkspaceId is
      // intentionally a plain opaque id.
      if (key !== 'crewcode:activeWorkspaceId') JSON.parse(value)
      patch[key] = value
    }
    if (Object.keys(patch).length === 0) return this.snapshot()
    this.state = {
      version: 1,
      revision: this.state.revision + 1,
      updatedAt: this.now(),
      values: { ...this.state.values, ...patch },
    }
    this.persist()
    return this.snapshot()
  }

  private load(): PersistedContinuityState {
    if (!existsSync(this.path)) return emptyState()
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<PersistedContinuityState>
      if (value.version !== 1 || !Number.isSafeInteger(value.revision) || !Number.isFinite(value.updatedAt) || !value.values || typeof value.values !== 'object') return emptyState()
      const values: Record<string, string> = {}
      for (const [key, entry] of Object.entries(value.values)) {
        if (ALLOWED_KEYS.has(key) && typeof entry === 'string' && Buffer.byteLength(entry) <= MAX_VALUE_BYTES) values[key] = entry
      }
      return { version: 1, revision: Number(value.revision), updatedAt: Number(value.updatedAt), values }
    } catch { return emptyState() }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, this.path)
    try { chmodSync(this.path, 0o600) } catch { /* Windows */ }
  }
}

export function continuityStatePath(dataDir: string): string {
  return join(dataDir, 'continuity-state.json')
}

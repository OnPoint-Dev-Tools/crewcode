import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'

interface PairingCredential {
  digest: Buffer
  expiresAt: number
  used: boolean
}

interface DeviceSession {
  id: string
  digest: Buffer
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  revokedAt?: number
}

interface PersistedAuthFile {
  version: 1
  sessions: Array<Omit<DeviceSession, 'digest'> & { digest: string }>
}

export interface RemoteAccessSessionInfo {
  id: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
  status: 'active' | 'expired' | 'revoked'
  revokedAt?: number
}

export interface RemoteAccessAuthOptions {
  storePath?: string
  sessionTtlMs?: number
  idleTtlMs?: number
  now?: () => number
}

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60_000
const DEFAULT_IDLE_TTL_MS = 7 * 24 * 60 * 60_000
const LAST_SEEN_PERSIST_INTERVAL_MS = 60_000

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function matches(value: string, expected: Buffer): boolean {
  const actual = digest(value)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Pairing credentials stay in memory; hashed device sessions may persist across restarts. */
export class RemoteAccessAuth {
  private readonly pairings = new Map<string, PairingCredential>()
  private readonly sessions = new Map<string, DeviceSession>()
  private readonly storePath?: string
  private readonly sessionTtlMs: number
  private readonly idleTtlMs: number
  private readonly now: () => number
  private readonly persistedLastSeen = new Map<string, number>()

  constructor(options: RemoteAccessAuthOptions = {}) {
    this.storePath = options.storePath
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
    this.now = options.now ?? Date.now
    this.load()
  }

  issuePairing(ttlMs = 10 * 60_000): { token: string; expiresAt: number } {
    const token = randomBytes(24).toString('base64url')
    const id = randomBytes(8).toString('hex')
    const expiresAt = this.now() + ttlMs
    this.pairings.set(id, { digest: digest(token), expiresAt, used: false })
    return { token: `${id}.${token}`, expiresAt }
  }

  exchange(pairingToken: string): { sessionToken?: string; sessionId?: string; expiresAt?: number; error?: string } {
    const separator = pairingToken.indexOf('.')
    if (separator < 1) return { error: 'invalid pairing token' }
    const id = pairingToken.slice(0, separator)
    const secret = pairingToken.slice(separator + 1)
    const pairing = this.pairings.get(id)
    const now = this.now()
    if (!pairing || pairing.used || pairing.expiresAt < now || !matches(secret, pairing.digest)) {
      return { error: 'pairing token is invalid, expired, or already used' }
    }
    pairing.used = true
    const sessionToken = randomBytes(32).toString('base64url')
    const sessionId = randomBytes(8).toString('hex')
    const expiresAt = now + this.sessionTtlMs
    this.sessions.set(sessionId, { id: sessionId, digest: digest(sessionToken), createdAt: now, lastSeenAt: now, expiresAt })
    this.persistedLastSeen.set(sessionId, now)
    this.flush()
    return { sessionToken: `${sessionId}.${sessionToken}`, sessionId, expiresAt }
  }

  authenticate(sessionToken: string): boolean {
    const separator = sessionToken.indexOf('.')
    if (separator < 1) return false
    const id = sessionToken.slice(0, separator)
    const session = this.sessions.get(id)
    const now = this.now()
    if (!session || session.revokedAt || session.expiresAt <= now || session.lastSeenAt + this.idleTtlMs <= now) return false
    if (!matches(sessionToken.slice(separator + 1), session.digest)) return false
    session.lastSeenAt = now
    const persistedAt = this.persistedLastSeen.get(id) ?? 0
    if (now - persistedAt >= LAST_SEEN_PERSIST_INTERVAL_MS) {
      this.persistedLastSeen.set(id, now)
      this.flush()
    }
    return true
  }

  list(): RemoteAccessSessionInfo[] {
    const now = this.now()
    return [...this.sessions.values()]
      .map(session => ({
        id: session.id,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        status: session.revokedAt ? 'revoked' as const : session.expiresAt <= now || session.lastSeenAt + this.idleTtlMs <= now ? 'expired' as const : 'active' as const,
        ...(session.revokedAt ? { revokedAt: session.revokedAt } : {}),
      }))
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  revoke(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session || session.revokedAt) return false
    session.revokedAt = this.now()
    this.flush()
    return true
  }

  private load(): void {
    if (!this.storePath || !existsSync(this.storePath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.storePath, 'utf8')) as Partial<PersistedAuthFile>
      if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return
      for (const value of parsed.sessions) {
        if (!value || typeof value.id !== 'string' || typeof value.digest !== 'string') continue
        if (![value.createdAt, value.lastSeenAt, value.expiresAt].every(Number.isFinite)) continue
        if (value.revokedAt !== undefined && !Number.isFinite(value.revokedAt)) continue
        const session: DeviceSession = {
          id: value.id,
          digest: Buffer.from(value.digest, 'base64'),
          createdAt: value.createdAt,
          lastSeenAt: value.lastSeenAt,
          expiresAt: value.expiresAt,
          ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
        }
        if (session.digest.length !== 32) continue
        this.sessions.set(session.id, session)
        this.persistedLastSeen.set(session.id, session.lastSeenAt)
      }
    } catch {
      // Refuse unknown/corrupt persisted credentials rather than failing the server
      // open. A later successful pairing replaces the store with valid state.
      this.sessions.clear()
      this.persistedLastSeen.clear()
    }
  }

  private flush(): void {
    if (!this.storePath) return
    mkdirSync(dirname(this.storePath), { recursive: true })
    const payload: PersistedAuthFile = {
      version: 1,
      sessions: [...this.sessions.values()].map(session => ({ ...session, digest: session.digest.toString('base64') })),
    }
    const temporary = `${this.storePath}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.storePath)
  }
}

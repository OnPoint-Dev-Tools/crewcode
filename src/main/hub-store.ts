import { createHash, randomBytes } from 'crypto'
import { chmodSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { AuthenticatorTransportFuture, WebAuthnCredential } from '@simplewebauthn/server'

const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
type DatabaseSync = import('node:sqlite').DatabaseSync

export interface HubUser {
  id: string
  username: string
  role: 'owner'
  createdAt: number
}

export interface HubCredentialRecord {
  id: string
  userId: string
  publicKey: Uint8Array
  counter: number
  transports?: AuthenticatorTransportFuture[]
  deviceType: 'singleDevice' | 'multiDevice'
  backedUp: boolean
}

export interface HubSession {
  id: string
  userId: string
  createdAt: number
  expiresAt: number
}

export interface HubMachineSummary {
  id: string
  name: string
  status: 'offline' | 'online' | 'revoked'
  platform: string | null
  version: string | null
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

export interface HubMachineIdentity {
  id: string
  ownerUserId: string
  revokedAt: number | null
}

export interface HubMachineAuthority extends HubMachineIdentity {
  publicKey: string
}

interface UserRow { id: string; username: string; role: string; created_at: number }
interface CredentialRow {
  id: string
  user_id: string
  public_key: Uint8Array
  counter: number
  transports: string | null
  device_type: string
  backed_up: number
}
interface SessionRow { id: string; user_id: string; created_at: number; expires_at: number }
interface MachineRow {
  id: string
  name: string
  status: string
  platform: string | null
  version: string | null
  created_at: number
  last_seen_at: number | null
  revoked_at: number | null
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64')
}

export class HubStore {
  private readonly db: DatabaseSync

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    try { chmodSync(dirname(path), 0o700) } catch { /* no-op on Windows */ }
    this.db = new DatabaseSync(path, { timeout: 5_000, enableForeignKeyConstraints: true, allowExtension: false })
    try { chmodSync(path, 0o600) } catch { /* no-op on Windows */ }
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA trusted_schema = OFF;
      CREATE TABLE IF NOT EXISTS local_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK(role = 'owner'),
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES local_users(id),
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT,
        device_type TEXT NOT NULL,
        backed_up INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS browser_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES local_users(id),
        token_digest TEXT NOT NULL,
        csrf_digest TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES local_users(id),
        public_key TEXT NOT NULL UNIQUE,
        credential_digest TEXT UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'offline',
        platform TEXT,
        version TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        machine_id TEXT,
        type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        metadata TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS browser_sessions_digest ON browser_sessions(token_digest);
      CREATE INDEX IF NOT EXISTS machines_owner ON machines(owner_user_id);
    `)
    const machineColumns = this.db.prepare('PRAGMA table_info(machines)').all() as Array<{ name: string }>
    if (!machineColumns.some(column => column.name === 'credential_digest')) {
      this.db.exec('ALTER TABLE machines ADD COLUMN credential_digest TEXT')
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS machines_credential_digest ON machines(credential_digest)')
  }

  close(): void { this.db.close() }

  owner(): HubUser | null {
    const row = this.db.prepare("SELECT id, username, role, created_at FROM local_users WHERE role = 'owner' AND revoked_at IS NULL LIMIT 1").get() as unknown as UserRow | undefined
    return row ? { id: row.id, username: row.username, role: 'owner', createdAt: row.created_at } : null
  }

  createOwnerWithCredential(input: {
    username: string
    credential: WebAuthnCredential
    deviceType: 'singleDevice' | 'multiDevice'
    backedUp: boolean
    now: number
  }): HubUser {
    if (this.owner()) throw new Error('Hub owner already exists')
    const user: HubUser = { id: randomBytes(16).toString('hex'), username: input.username, role: 'owner', createdAt: input.now }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO local_users(id, username, role, created_at) VALUES (?, ?, ?, ?)')
        .run(user.id, user.username, user.role, user.createdAt)
      this.db.prepare('INSERT INTO webauthn_credentials(id, user_id, public_key, counter, transports, device_type, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.credential.id, user.id, input.credential.publicKey, input.credential.counter, JSON.stringify(input.credential.transports ?? []), input.deviceType, input.backedUp ? 1 : 0, input.now)
      this.audit('hub.owner.created', user.id, null, { username: user.username }, input.now)
      this.db.exec('COMMIT')
      return user
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  credentialsForUser(userId: string): HubCredentialRecord[] {
    const rows = this.db.prepare('SELECT id, user_id, public_key, counter, transports, device_type, backed_up FROM webauthn_credentials WHERE user_id = ?').all(userId) as unknown as CredentialRow[]
    return rows.map(row => ({
      id: row.id,
      userId: row.user_id,
      publicKey: new Uint8Array(row.public_key),
      counter: row.counter,
      transports: JSON.parse(row.transports ?? '[]') as AuthenticatorTransportFuture[],
      deviceType: row.device_type === 'multiDevice' ? 'multiDevice' : 'singleDevice',
      backedUp: row.backed_up === 1,
    }))
  }

  credential(id: string): HubCredentialRecord | null {
    const row = this.db.prepare('SELECT id, user_id, public_key, counter, transports, device_type, backed_up FROM webauthn_credentials WHERE id = ?').get(id) as unknown as CredentialRow | undefined
    if (!row) return null
    return {
      id: row.id,
      userId: row.user_id,
      publicKey: new Uint8Array(row.public_key),
      counter: row.counter,
      transports: JSON.parse(row.transports ?? '[]') as AuthenticatorTransportFuture[],
      deviceType: row.device_type === 'multiDevice' ? 'multiDevice' : 'singleDevice',
      backedUp: row.backed_up === 1,
    }
  }

  updateCredentialCounter(id: string, counter: number): void {
    this.db.prepare('UPDATE webauthn_credentials SET counter = ? WHERE id = ?').run(counter, id)
  }

  createSession(userId: string, now: number, ttlMs: number): { session: HubSession; token: string; csrf: string } {
    const token = randomBytes(32).toString('base64url')
    const csrf = randomBytes(24).toString('base64url')
    const session: HubSession = { id: randomBytes(16).toString('hex'), userId, createdAt: now, expiresAt: now + ttlMs }
    this.db.prepare('INSERT INTO browser_sessions(id, user_id, token_digest, csrf_digest, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(session.id, userId, digest(token), digest(csrf), session.createdAt, session.expiresAt)
    this.audit('hub.session.created', userId, null, { sessionId: session.id }, now)
    return { session, token: `${session.id}.${token}`, csrf }
  }

  authenticateSession(token: string, now: number): HubSession | null {
    const separator = token.indexOf('.')
    if (separator < 1) return null
    const id = token.slice(0, separator)
    const secret = token.slice(separator + 1)
    const row = this.db.prepare('SELECT id, user_id, created_at, expires_at FROM browser_sessions WHERE id = ? AND token_digest = ? AND revoked_at IS NULL AND expires_at > ?')
      .get(id, digest(secret), now) as unknown as SessionRow | undefined
    return row ? { id: row.id, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at } : null
  }

  rotateCsrf(sessionId: string): string {
    const csrf = randomBytes(24).toString('base64url')
    this.db.prepare('UPDATE browser_sessions SET csrf_digest = ? WHERE id = ? AND revoked_at IS NULL').run(digest(csrf), sessionId)
    return csrf
  }

  validateCsrf(sessionId: string, csrf: string): boolean {
    const row = this.db.prepare('SELECT 1 AS ok FROM browser_sessions WHERE id = ? AND csrf_digest = ? AND revoked_at IS NULL').get(sessionId, digest(csrf)) as { ok: number } | undefined
    return row?.ok === 1
  }

  revokeSession(sessionId: string, now: number): boolean {
    const result = this.db.prepare('UPDATE browser_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, sessionId)
    return Number(result.changes) === 1
  }

  createMachine(input: { userId: string; publicKey: string; name: string; platform: string | null; version: string | null; now: number }): { machine: HubMachineSummary; token: string } {
    const id = randomBytes(16).toString('hex')
    const secret = randomBytes(32).toString('base64url')
    this.db.prepare("INSERT INTO machines(id, owner_user_id, public_key, credential_digest, name, status, platform, version, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 'online', ?, ?, ?, ?)")
      .run(id, input.userId, input.publicKey, digest(secret), input.name, input.platform, input.version, input.now, input.now)
    this.audit('hub.machine.enrolled', input.userId, id, { name: input.name, platform: input.platform }, input.now)
    return {
      machine: { id, name: input.name, status: 'online', platform: input.platform, version: input.version, createdAt: input.now, lastSeenAt: input.now, revokedAt: null },
      token: `${id}.${secret}`,
    }
  }

  authenticateMachine(token: string): HubMachineIdentity | null {
    const separator = token.indexOf('.')
    if (separator < 1) return null
    const id = token.slice(0, separator)
    const secret = token.slice(separator + 1)
    const row = this.db.prepare('SELECT id, owner_user_id, revoked_at FROM machines WHERE id = ? AND credential_digest = ? AND revoked_at IS NULL')
      .get(id, digest(secret)) as { id: string; owner_user_id: string; revoked_at: number | null } | undefined
    return row ? { id: row.id, ownerUserId: row.owner_user_id, revokedAt: row.revoked_at } : null
  }

  machineAuthorityForUser(userId: string, machineId: string): HubMachineAuthority | null {
    const row = this.db.prepare('SELECT id, owner_user_id, public_key, revoked_at FROM machines WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL')
      .get(machineId, userId) as { id: string; owner_user_id: string; public_key: string; revoked_at: number | null } | undefined
    return row ? { id: row.id, ownerUserId: row.owner_user_id, publicKey: row.public_key, revokedAt: row.revoked_at } : null
  }

  heartbeatMachine(machineId: string, platform: string | null, version: string | null, now: number): boolean {
    const result = this.db.prepare("UPDATE machines SET status = 'online', platform = ?, version = ?, last_seen_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(platform, version, now, machineId)
    return Number(result.changes) === 1
  }

  revokeMachine(userId: string, machineId: string, now: number): boolean {
    const result = this.db.prepare("UPDATE machines SET revoked_at = ?, status = 'offline' WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL")
      .run(now, machineId, userId)
    if (Number(result.changes) !== 1) return false
    this.audit('hub.machine.revoked', userId, machineId, {}, now)
    return true
  }

  machinesForUser(userId: string, now = Date.now(), onlineWindowMs = 90_000): HubMachineSummary[] {
    const rows = this.db.prepare('SELECT id, name, status, platform, version, created_at, last_seen_at, revoked_at FROM machines WHERE owner_user_id = ? ORDER BY name COLLATE NOCASE').all(userId) as unknown as MachineRow[]
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      status: row.revoked_at ? 'revoked' : row.last_seen_at !== null && row.last_seen_at > now - onlineWindowMs ? 'online' : 'offline',
      platform: row.platform,
      version: row.version,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
    }))
  }

  audit(type: string, userId: string | null, machineId: string | null, metadata: Record<string, unknown>, now: number): void {
    this.db.prepare('INSERT INTO audit_events(id, user_id, machine_id, type, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomBytes(16).toString('hex'), userId, machineId, type, now, JSON.stringify(metadata))
  }
}

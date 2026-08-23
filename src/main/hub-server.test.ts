import { generateKeyPairSync } from 'crypto'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { hubRelayExpiryReason, startHubServer, type RunningHubServer } from './hub-server'
import { HUB_RELAY_ABSOLUTE_TIMEOUT_MS, HUB_RELAY_IDLE_TIMEOUT_MS } from '../shared/hub-relay-types'
import { HubEnrollmentIssuer, HUB_ENROLLMENT_TTL_MS } from './hub-machine-enrollment'
import { HubStore } from './hub-store'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'crewcode-hub-test-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

async function server(): Promise<RunningHubServer> {
  const running = await startHubServer({ dataDir: temporaryDirectory(), port: 0 })
  cleanups.push(() => running.close())
  return running
}

async function authenticatedServer(now: () => number): Promise<{ running: RunningHubServer; cookie: string; csrf: string }> {
  const directory = temporaryDirectory()
  const store = new HubStore(join(directory, 'hub.sqlite'))
  const owner = store.createOwnerWithCredential({
    username: 'Owner',
    credential: { id: 'credential-id', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
    deviceType: 'singleDevice',
    backedUp: false,
    now: now(),
  })
  const session = store.createSession(owner.id, now(), 10 * 60_000)
  store.close()
  const running = await startHubServer({ dataDir: directory, port: 0, now })
  cleanups.push(() => running.close())
  return { running, cookie: `crewcode_hub_session=${encodeURIComponent(session.token)}`, csrf: session.csrf }
}

describe('Hub enrollment credentials', () => {
  it('keeps enrollment tokens memory-only, expiring, and single-use', () => {
    let time = 1_000
    const issuer = new HubEnrollmentIssuer(() => time)
    const first = issuer.issue('owner-id')
    expect(issuer.consume(first.token)).toEqual({ userId: 'owner-id' })
    expect(issuer.consume(first.token)).toBeNull()

    const guessed = issuer.issue('owner-id')
    expect(issuer.consume(`${guessed.token.split('.')[0]}.wrong`)).toBeNull()
    expect(issuer.consume(guessed.token)).toBeNull()

    const expired = issuer.issue('owner-id')
    time += HUB_ENROLLMENT_TTL_MS
    expect(issuer.consume(expired.token)).toBeNull()
  })
})

describe('Hub store', () => {
  it('migrates the pre-enrollment machine registry schema in place', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'hub.sqlite')
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE local_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, role TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER) STRICT;
      CREATE TABLE machines (id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES local_users(id), public_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'offline', platform TEXT, version TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER) STRICT;
    `)
    legacy.close()
    const store = new HubStore(path)
    store.close()
    const migrated = new DatabaseSync(path)
    const columns = migrated.prepare('PRAGMA table_info(machines)').all() as Array<{ name: string }>
    expect(columns.some(column => column.name === 'credential_digest')).toBe(true)
    migrated.close()
  })

  it('persists an owner credential and protects session secrets with digests', () => {
    const directory = temporaryDirectory()
    const path = join(directory, 'hub.sqlite')
    const store = new HubStore(path)
    const owner = store.createOwnerWithCredential({
      username: 'Owner',
      credential: { id: 'credential-id', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
      deviceType: 'singleDevice',
      backedUp: false,
      now: 1_000,
    })
    const created = store.createSession(owner.id, 2_000, 10_000)
    expect(store.authenticateSession(created.token, 3_000)?.userId).toBe(owner.id)
    expect(store.authenticateSession(`${created.session.id}.wrong`, 3_000)).toBeNull()
    expect(store.validateCsrf(created.session.id, created.csrf)).toBe(true)
    const enrolled = store.createMachine({ userId: owner.id, publicKey: 'test-public-key', name: 'cortex', platform: 'linux', version: '0.2.1', now: 3_000 })
    expect(store.authenticateMachine(enrolled.token)?.id).toBe(enrolled.machine.id)
    expect(store.authenticateMachine(`${enrolled.machine.id}.wrong`)).toBeNull()
    expect(readFileSync(path).includes(Buffer.from(enrolled.token.split('.')[1]))).toBe(false)
    expect(store.revokeSession(created.session.id, 4_000)).toBe(true)
    expect(store.authenticateSession(created.token, 5_000)).toBeNull()
    store.close()

    const reopened = new HubStore(path)
    expect(reopened.owner()?.username).toBe('Owner')
    expect(reopened.credentialsForUser(owner.id)[0]?.publicKey).toEqual(new Uint8Array([1, 2, 3]))
    reopened.close()
  })
})

describe('Hub relay expiry', () => {
  it('expires idle connections and enforces an absolute lifetime despite activity', () => {
    const connection = { openedAt: 1_000, lastActivityAt: 1_000 }
    expect(hubRelayExpiryReason(connection, 1_000 + HUB_RELAY_IDLE_TIMEOUT_MS - 1)).toBeNull()
    expect(hubRelayExpiryReason(connection, 1_000 + HUB_RELAY_IDLE_TIMEOUT_MS)).toBe('idle timeout')

    connection.lastActivityAt = 1_000 + HUB_RELAY_ABSOLUTE_TIMEOUT_MS - 1
    expect(hubRelayExpiryReason(connection, 1_000 + HUB_RELAY_ABSOLUTE_TIMEOUT_MS - 1)).toBeNull()
    expect(hubRelayExpiryReason(connection, 1_000 + HUB_RELAY_ABSOLUTE_TIMEOUT_MS)).toBe('absolute timeout')
  })
})

describe('Hub HTTP security boundary', () => {
  it('does not disclose the one-time bootstrap token through status', async () => {
    const running = await server()
    expect(running.bootstrapToken).toBeTruthy()
    const response = await fetch(`${running.url}/api/v1/hub/status`)
    const body = await response.text()
    expect(response.status).toBe(200)
    expect(body).not.toContain(running.bootstrapToken as string)
    expect(JSON.parse(body)).toEqual({ service: 'crewcode-hub', protocolVersion: 1, ownerConfigured: false })
  })

  it('rejects foreign browser origins and unauthenticated machine access', async () => {
    const running = await server()
    const foreign = await fetch(`${running.url}/api/v1/hub/status`, { headers: { origin: 'https://evil.example' } })
    expect(foreign.status).toBe(403)
    const machines = await fetch(`${running.url}/api/v1/hub/machines`)
    expect(machines.status).toBe(401)
  })

  it('trusts only the configured HTTPS RP origin, not the internal listener host', async () => {
    const running = await startHubServer({ dataDir: temporaryDirectory(), port: 0, publicOrigin: 'https://crewcode.example' })
    cleanups.push(() => running.close())
    const internal = await fetch(`${running.url}/api/v1/hub/status`, { headers: { origin: running.url } })
    expect(internal.status).toBe(403)
    const configured = await fetch(`${running.url}/api/v1/hub/status`, { headers: { origin: 'https://crewcode.example' } })
    expect(configured.status).toBe(200)
  })

  it('enrolls, tracks, expires, and revokes an authenticated outbound machine', async () => {
    let time = 10_000
    const { running, cookie, csrf } = await authenticatedServer(() => time)
    const browserHeaders = { cookie, 'x-crewcode-csrf': csrf, 'content-type': 'application/json' }

    const noCsrf = await fetch(`${running.url}/api/v1/hub/enrollments`, { method: 'POST', headers: { cookie } })
    expect(noCsrf.status).toBe(403)
    const issuedResponse = await fetch(`${running.url}/api/v1/hub/enrollments`, { method: 'POST', headers: browserHeaders, body: '{}' })
    expect(issuedResponse.status).toBe(201)
    const issued = await issuedResponse.json() as { token: string }

    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
    const enrolledResponse = await fetch(`${running.url}/api/v1/hub/machines/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentToken: issued.token, publicKey, name: 'cortex-pc', platform: 'linux', version: '0.2.1' }),
    })
    expect(enrolledResponse.status).toBe(201)
    const enrolled = await enrolledResponse.json() as { machineId: string; token: string }
    const replay = await fetch(`${running.url}/api/v1/hub/machines/enroll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enrollmentToken: issued.token, publicKey, name: 'replay', platform: 'linux', version: '0.2.1' }),
    })
    expect(replay.status).toBe(401)

    time += 91_000
    let machines = await (await fetch(`${running.url}/api/v1/hub/machines`, { headers: { cookie } })).json() as { machines: Array<{ status: string }> }
    expect(machines.machines[0]?.status).toBe('offline')
    const heartbeat = await fetch(`${running.url}/api/v1/hub/machines/heartbeat`, {
      method: 'POST', headers: { authorization: `Bearer ${enrolled.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ platform: 'linux', version: '0.2.1' }),
    })
    expect(heartbeat.status).toBe(200)
    machines = await (await fetch(`${running.url}/api/v1/hub/machines`, { headers: { cookie } })).json() as { machines: Array<{ status: string }> }
    expect(machines.machines[0]?.status).toBe('online')

    const revoked = await fetch(`${running.url}/api/v1/hub/machines/${enrolled.machineId}/revoke`, { method: 'POST', headers: browserHeaders, body: '{}' })
    expect(revoked.status).toBe(200)
    const afterRevoke = await fetch(`${running.url}/api/v1/hub/machines/heartbeat`, {
      method: 'POST', headers: { authorization: `Bearer ${enrolled.token}`, 'content-type': 'application/json' }, body: '{}',
    })
    expect(afterRevoke.status).toBe(401)
  })

  it('serves the standalone setup screen with a restrictive CSP', async () => {
    const running = await server()
    const response = await fetch(running.url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(await response.text()).not.toContain('<script>')
  })
})

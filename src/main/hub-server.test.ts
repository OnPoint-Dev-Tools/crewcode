import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { startHubServer, type RunningHubServer } from './hub-server'
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

describe('Hub store', () => {
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
    expect(store.revokeSession(created.session.id, 4_000)).toBe(true)
    expect(store.authenticateSession(created.token, 5_000)).toBeNull()
    store.close()

    const reopened = new HubStore(path)
    expect(reopened.owner()?.username).toBe('Owner')
    expect(reopened.credentialsForUser(owner.id)[0]?.publicKey).toEqual(new Uint8Array([1, 2, 3]))
    reopened.close()
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

  it('serves the standalone setup screen with a restrictive CSP', async () => {
    const running = await server()
    const response = await fetch(running.url)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(await response.text()).not.toContain('<script>')
  })
})

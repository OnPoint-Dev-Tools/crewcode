import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { RemoteAccessAuth } from './remote-access-auth'

function exchange(auth: RemoteAccessAuth): { token: string; id: string } {
  const pairing = auth.issuePairing()
  const result = auth.exchange(pairing.token)
  if (!result.sessionToken || !result.sessionId) throw new Error(result.error ?? 'exchange failed')
  return { token: result.sessionToken, id: result.sessionId }
}

describe('RemoteAccessAuth', () => {
  it('persists only hashed sessions with owner-only permissions and restores them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'crewcode-remote-auth-'))
    const storePath = join(directory, 'sessions.json')
    const auth = new RemoteAccessAuth({ storePath })
    const session = exchange(auth)

    expect(existsSync(storePath)).toBe(true)
    const stored = readFileSync(storePath, 'utf8')
    expect(stored).not.toContain(session.token)
    if (process.platform !== 'win32') expect(statSync(storePath).mode & 0o777).toBe(0o600)

    const restored = new RemoteAccessAuth({ storePath })
    expect(restored.authenticate(session.token)).toBe(true)
    expect(restored.list()).toMatchObject([{ id: session.id, status: 'active' }])
  })

  it('enforces absolute and idle expiry', () => {
    let now = 1_000
    const absolute = new RemoteAccessAuth({ now: () => now, sessionTtlMs: 100, idleTtlMs: 1_000 })
    const absoluteSession = exchange(absolute)
    now = 1_100
    expect(absolute.authenticate(absoluteSession.token)).toBe(false)
    expect(absolute.list()[0].status).toBe('expired')

    now = 2_000
    const idle = new RemoteAccessAuth({ now: () => now, sessionTtlMs: 10_000, idleTtlMs: 100 })
    const idleSession = exchange(idle)
    now = 2_100
    expect(idle.authenticate(idleSession.token)).toBe(false)
    expect(idle.list()[0].status).toBe('expired')
  })

  it('revokes a session without exposing its digest', () => {
    let now = 5_000
    const auth = new RemoteAccessAuth({ now: () => now })
    const session = exchange(auth)
    now += 1
    expect(auth.revoke(session.id)).toBe(true)
    expect(auth.revoke(session.id)).toBe(false)
    expect(auth.authenticate(session.token)).toBe(false)
    expect(auth.list()).toEqual([expect.objectContaining({ id: session.id, status: 'revoked', revokedAt: now })])
    expect(JSON.stringify(auth.list())).not.toContain(session.token)
  })

  it('fails closed when the persisted credential file is corrupt', () => {
    const directory = mkdtempSync(join(tmpdir(), 'crewcode-remote-auth-corrupt-'))
    const storePath = join(directory, 'sessions.json')
    const auth = new RemoteAccessAuth({ storePath })
    const session = exchange(auth)
    writeFileSync(storePath, '{ broken', 'utf8')

    const restored = new RemoteAccessAuth({ storePath })
    expect(restored.authenticate(session.token)).toBe(false)
    expect(restored.list()).toEqual([])
  })
})

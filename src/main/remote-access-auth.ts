import { createHash, randomBytes, timingSafeEqual } from 'crypto'

interface PairingCredential {
  digest: Buffer
  expiresAt: number
  used: boolean
}

interface DeviceSession {
  digest: Buffer
  createdAt: number
  lastSeenAt: number
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function matches(value: string, expected: Buffer): boolean {
  const actual = digest(value)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** In-memory credentials intentionally expire when the server process exits. */
export class RemoteAccessAuth {
  private readonly pairings = new Map<string, PairingCredential>()
  private readonly sessions = new Map<string, DeviceSession>()

  issuePairing(ttlMs = 10 * 60_000): { token: string; expiresAt: number } {
    const token = randomBytes(24).toString('base64url')
    const id = randomBytes(8).toString('hex')
    const expiresAt = Date.now() + ttlMs
    this.pairings.set(id, { digest: digest(token), expiresAt, used: false })
    return { token: `${id}.${token}`, expiresAt }
  }

  exchange(pairingToken: string): { sessionToken?: string; error?: string } {
    const separator = pairingToken.indexOf('.')
    if (separator < 1) return { error: 'invalid pairing token' }
    const id = pairingToken.slice(0, separator)
    const secret = pairingToken.slice(separator + 1)
    const pairing = this.pairings.get(id)
    if (!pairing || pairing.used || pairing.expiresAt < Date.now() || !matches(secret, pairing.digest)) {
      return { error: 'pairing token is invalid, expired, or already used' }
    }
    pairing.used = true
    const sessionToken = randomBytes(32).toString('base64url')
    const sessionId = randomBytes(8).toString('hex')
    const now = Date.now()
    this.sessions.set(sessionId, { digest: digest(sessionToken), createdAt: now, lastSeenAt: now })
    return { sessionToken: `${sessionId}.${sessionToken}` }
  }

  authenticate(sessionToken: string): boolean {
    const separator = sessionToken.indexOf('.')
    if (separator < 1) return false
    const session = this.sessions.get(sessionToken.slice(0, separator))
    if (!session || !matches(sessionToken.slice(separator + 1), session.digest)) return false
    session.lastSeenAt = Date.now()
    return true
  }
}

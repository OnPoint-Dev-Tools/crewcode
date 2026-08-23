import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import {
  HUB_CONNECTION_TICKET_TTL_MS,
  type BrainAccessScope,
} from '../shared/hub-relay-types'

interface PendingConnectionTicket {
  id: string
  secretDigest: Buffer
  userId: string
  browserSessionId: string
  machineId: string
  requestedScopes: BrainAccessScope[]
  expiresAt: number
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export class HubConnectionTicketIssuer {
  private readonly pending = new Map<string, PendingConnectionTicket>()

  constructor(private readonly now: () => number = Date.now) {}

  issue(input: {
    userId: string
    browserSessionId: string
    machineId: string
    requestedScopes: BrainAccessScope[]
  }): { ticket: string; expiresAt: number } {
    this.prune()
    const id = randomBytes(16).toString('hex')
    const secret = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + HUB_CONNECTION_TICKET_TTL_MS
    this.pending.set(id, {
      id,
      secretDigest: digest(secret),
      userId: input.userId,
      browserSessionId: input.browserSessionId,
      machineId: input.machineId,
      requestedScopes: [...input.requestedScopes],
      expiresAt,
    })
    return { ticket: `${id}.${secret}`, expiresAt }
  }

  consume(token: string): Omit<PendingConnectionTicket, 'secretDigest'> | null {
    this.prune()
    const separator = token.indexOf('.')
    if (separator < 1) return null
    const id = token.slice(0, separator)
    const pending = this.pending.get(id)
    if (!pending) return null
    // A ticket id gets one presentation. A wrong secret consumes it to bound
    // online guessing and make replay behavior unambiguous.
    this.pending.delete(id)
    const supplied = digest(token.slice(separator + 1))
    if (supplied.length !== pending.secretDigest.length || !timingSafeEqual(supplied, pending.secretDigest)) return null
    if (pending.expiresAt <= this.now()) return null
    const { secretDigest: _secretDigest, ...claims } = pending
    return claims
  }

  private prune(): void {
    const now = this.now()
    for (const [id, ticket] of this.pending) if (ticket.expiresAt <= now) this.pending.delete(id)
  }
}

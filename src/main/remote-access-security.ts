import type { IncomingMessage } from 'http'

export const REMOTE_AUTH_RATE_WINDOW_MS = 60_000
export const REMOTE_PAIR_ATTEMPTS_PER_WINDOW = 10
export const REMOTE_UNAUTHENTICATED_ATTEMPTS_PER_WINDOW = 60

interface RateWindow {
  startedAt: number
  attempts: number
}

export interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds: number
}

/** Small fixed-window limiter for authentication boundaries, keyed by peer address. */
export class RemoteAccessRateLimiter {
  private readonly windows = new Map<string, RateWindow>()

  constructor(
    private readonly limit: number,
    private readonly windowMs = REMOTE_AUTH_RATE_WINDOW_MS,
    private readonly maxPeers = 10_000,
  ) {}

  consume(key: string, now = Date.now()): RateLimitResult {
    if (!this.windows.has(key) && this.windows.size >= this.maxPeers) {
      for (const [peer, window] of this.windows) {
        if (now - window.startedAt >= this.windowMs) this.windows.delete(peer)
      }
      while (this.windows.size >= this.maxPeers) {
        const oldest = this.windows.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.windows.delete(oldest)
      }
    }
    const previous = this.windows.get(key)
    const current = !previous || now - previous.startedAt >= this.windowMs
      ? { startedAt: now, attempts: 0 }
      : previous
    current.attempts += 1
    this.windows.set(key, current)
    return {
      allowed: current.attempts <= this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((current.startedAt + this.windowMs - now) / 1000)),
    }
  }
}

function normalizedOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Browser requests always carry Origin for cross-origin POST and WebSocket
 * handshakes. Non-browser CLI requests may omit it. A supplied origin must match
 * either the exact request Host over HTTP or an explicitly configured public URL.
 */
export function browserOriginAllowed(request: IncomingMessage, publicOrigins: readonly string[] = []): boolean {
  const supplied = request.headers.origin
  if (supplied === undefined) return true
  if (Array.isArray(supplied) || supplied === 'null') return false
  const origin = normalizedOrigin(supplied)
  if (!origin) return false
  const allowed = new Set(publicOrigins.map(normalizedOrigin).filter((value): value is string => value !== null))
  const host = request.headers.host
  if (host) allowed.add(`http://${host}`)
  return allowed.has(origin)
}

export function remotePeerKey(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? 'unknown'
}

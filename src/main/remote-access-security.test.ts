import type { IncomingMessage } from 'http'
import { describe, expect, it } from 'vitest'
import {
  browserOriginAllowed,
  RemoteAccessRateLimiter,
} from './remote-access-security'

function request(origin?: string, host = '127.0.0.1:3773'): IncomingMessage {
  return { headers: { ...(origin === undefined ? {} : { origin }), host } } as IncomingMessage
}

describe('remote access browser origin checks', () => {
  it('accepts CLI traffic without Origin and exact same-origin browsers', () => {
    expect(browserOriginAllowed(request())).toBe(true)
    expect(browserOriginAllowed(request('http://127.0.0.1:3773'))).toBe(true)
  })

  it('rejects cross-origin, null, malformed, and path-bearing origins', () => {
    expect(browserOriginAllowed(request('https://evil.example'))).toBe(false)
    expect(browserOriginAllowed(request('null'))).toBe(false)
    expect(browserOriginAllowed(request('not a url'))).toBe(false)
    expect(browserOriginAllowed(request('https://hub.example/path'))).toBe(false)
  })

  it('accepts an explicitly configured reverse-proxy origin', () => {
    expect(browserOriginAllowed(request('https://crewcode.example'), ['https://crewcode.example'])).toBe(true)
  })
})

describe('RemoteAccessRateLimiter', () => {
  it('refuses attempts over the fixed-window limit and resets afterward', () => {
    const limiter = new RemoteAccessRateLimiter(2, 1_000)
    expect(limiter.consume('peer', 10_000).allowed).toBe(true)
    expect(limiter.consume('peer', 10_000).allowed).toBe(true)
    expect(limiter.consume('peer', 10_000)).toMatchObject({ allowed: false, retryAfterSeconds: 1 })
    expect(limiter.consume('peer', 11_000).allowed).toBe(true)
  })

  it('keeps independent peer budgets', () => {
    const limiter = new RemoteAccessRateLimiter(1)
    expect(limiter.consume('one', 1).allowed).toBe(true)
    expect(limiter.consume('one', 1).allowed).toBe(false)
    expect(limiter.consume('two', 1).allowed).toBe(true)
  })

  it('bounds remembered peer windows', () => {
    const limiter = new RemoteAccessRateLimiter(1, 60_000, 2)
    expect(limiter.consume('one', 1).allowed).toBe(true)
    expect(limiter.consume('two', 1).allowed).toBe(true)
    expect(limiter.consume('three', 1).allowed).toBe(true)
    expect(limiter.consume('one', 1).allowed).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { HubRelayTrafficLimiter } from './hub-relay-limits'

describe('Hub relay traffic limiter', () => {
  it('bounds frame bursts and refills at the sustained rate', () => {
    const limiter = new HubRelayTrafficLimiter(1_000, 2, 1, 100, 100)
    expect(limiter.consume(1, 1_000)).toBeNull()
    expect(limiter.consume(1, 1_000)).toBeNull()
    expect(limiter.consume(1, 1_000)).toBe('frame rate limit')
    expect(limiter.consume(1, 1_999)).toBe('frame rate limit')
    expect(limiter.consume(1, 2_000)).toBeNull()
  })

  it('bounds encoded bytes without consuming a frame token for a rejected frame', () => {
    const limiter = new HubRelayTrafficLimiter(1_000, 2, 0, 10, 5)
    expect(limiter.consume(6, 1_000)).toBeNull()
    expect(limiter.consume(5, 1_000)).toBe('bandwidth limit')
    expect(limiter.consume(5, 2_000)).toBeNull()
  })

  it('does not refill when the supplied clock moves backwards', () => {
    const limiter = new HubRelayTrafficLimiter(1_000, 1, 1, 10, 10)
    expect(limiter.consume(1, 1_000)).toBeNull()
    expect(limiter.consume(1, 500)).toBe('frame rate limit')
  })
})

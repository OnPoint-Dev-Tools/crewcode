export const HUB_RELAY_FRAME_BURST = 240
export const HUB_RELAY_FRAME_REFILL_PER_SECOND = 60
export const HUB_RELAY_BYTE_BURST = 8 * 1024 * 1024
export const HUB_RELAY_BYTE_REFILL_PER_SECOND = 2 * 1024 * 1024

export type HubRelayTrafficLimitReason = 'frame rate limit' | 'bandwidth limit'

/**
 * Per-connection token bucket. Frames in both directions share the same budget,
 * preventing either peer from making the Hub retain unbounded relay work. The
 * burst accommodates normal terminal/event fan-out while sustained traffic is
 * bounded independently by frame count and encoded bytes.
 */
export class HubRelayTrafficLimiter {
  private frameTokens: number
  private byteTokens: number
  private lastRefillAt: number

  constructor(
    at: number,
    private readonly frameCapacity = HUB_RELAY_FRAME_BURST,
    private readonly frameRefillPerSecond = HUB_RELAY_FRAME_REFILL_PER_SECOND,
    private readonly byteCapacity = HUB_RELAY_BYTE_BURST,
    private readonly byteRefillPerSecond = HUB_RELAY_BYTE_REFILL_PER_SECOND,
  ) {
    this.frameTokens = frameCapacity
    this.byteTokens = byteCapacity
    this.lastRefillAt = at
  }

  consume(bytes: number, at: number): HubRelayTrafficLimitReason | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return 'bandwidth limit'
    const elapsedSeconds = Math.max(0, at - this.lastRefillAt) / 1000
    this.frameTokens = Math.min(this.frameCapacity, this.frameTokens + elapsedSeconds * this.frameRefillPerSecond)
    this.byteTokens = Math.min(this.byteCapacity, this.byteTokens + elapsedSeconds * this.byteRefillPerSecond)
    this.lastRefillAt = Math.max(this.lastRefillAt, at)
    if (this.frameTokens < 1) return 'frame rate limit'
    if (this.byteTokens < bytes) return 'bandwidth limit'
    this.frameTokens -= 1
    this.byteTokens -= bytes
    return null
  }
}

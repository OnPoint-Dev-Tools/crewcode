import type { Message, TurnUsage } from '../types'

/**
 * Native compaction makes the previous absolute context occupancy stale.
 * Preserve per-turn billing/speed fields, but hide context percentage and its
 * breakdown until the provider reports a new authoritative measurement.
 */
export function clearLatestContextUsage(messages: Message[]): Message[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.kind !== 'agent' || !message.usage) continue
    const usage: TurnUsage = { ...message.usage }
    const hadContext = usage.contextTokens !== undefined
      || usage.compaction !== undefined
      || usage.contextBreakdown !== undefined
    if (!hadContext) return messages
    delete usage.contextTokens
    delete usage.compaction
    delete usage.contextBreakdown
    const next = messages.slice()
    next[index] = { ...message, usage }
    return next
  }
  return messages
}

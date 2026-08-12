import { describe, expect, it } from 'vitest'
import type { Message } from '../types'
import { clearLatestContextUsage } from './compaction-context'

describe('clearLatestContextUsage', () => {
  it('clears stale occupancy while preserving per-turn token totals', () => {
    const messages: Message[] = [{
      kind: 'agent',
      time: '12:00',
      blocks: [],
      usage: {
        inputTokens: 170_000,
        outputTokens: 500,
        totalTokens: 170_500,
        contextTokens: 170_000,
        contextWindow: 200_000,
        model: 'crewcoder:model',
        compaction: { percent: 85 },
        contextBreakdown: [{ name: 'messages', tokens: 160_000 }],
      },
    }]

    expect(clearLatestContextUsage(messages)).toEqual([{
      ...messages[0],
      usage: {
        inputTokens: 170_000,
        outputTokens: 500,
        totalTokens: 170_500,
        contextWindow: 200_000,
        model: 'crewcoder:model',
      },
    }])
  })

  it('changes only the latest usage-bearing agent message', () => {
    const first: Message = { kind: 'agent', time: '11:00', blocks: [], usage: { contextTokens: 10_000, contextWindow: 200_000 } }
    const second: Message = { kind: 'agent', time: '12:00', blocks: [], usage: { contextTokens: 170_000, contextWindow: 200_000 } }
    const result = clearLatestContextUsage([first, { kind: 'system', time: '11:30', text: 'note' }, second])

    expect(result[0]).toBe(first)
    expect(result[2]).toEqual({ ...second, usage: { contextWindow: 200_000 } })
  })

  it('returns the original array when no context measurement exists', () => {
    const messages: Message[] = [{ kind: 'agent', time: '12:00', blocks: [], usage: { outputTokens: 12 } }]
    expect(clearLatestContextUsage(messages)).toBe(messages)
  })
})

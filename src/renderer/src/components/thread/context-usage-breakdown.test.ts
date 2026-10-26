import { describe, expect, it } from 'vitest'
import { latestSessionUsage, latestSessionCompaction, contextUsageRows } from './context-usage-breakdown'
import type { Message, TurnUsage } from '../../types'

const agent = (usage?: TurnUsage): Message => ({ kind: 'agent', time: 'now', blocks: [], usage })
describe('session context sidebar data', () => {
  it('does not resurrect old occupancy after compaction', () => {
    const cleared = { contextWindow: 1000 }
    expect(latestSessionUsage([agent({ contextTokens: 900, contextWindow: 1000 }), agent(cleared), agent()])).toBe(cleared)
  })
  it('stays unknown for a new session', () => {
    expect(latestSessionUsage([])).toBeUndefined()
    expect(contextUsageRows()).toEqual({ categories: [], groups: [] })
  })
  it('separates contributors and diagnostics without adding them to occupancy', () => {
    const usage: TurnUsage = { contextTokens: 100, contextBreakdownSource: 'context', contextBreakdown: [
      { name: 'Messages', tokens: 80 }, { name: 'MCP tools', tokens: 20 },
      { name: 'mcp:docs/search', tokens: 20 }, { name: 'memory:project:AGENTS.md', tokens: 10 },
      { name: 'sdk:active category sum', tokens: 100 }, { name: 'builtin:search', tokens: 40, deferred: true },
    ] }
    const result = contextUsageRows(usage)
    expect(result.categories.map(row => row.name)).toEqual(['Messages', 'MCP tools'])
    expect(result.groups.find(group => group.name === 'Memory files')?.rows).toEqual([{ name: 'project:AGENTS.md', tokens: 10 }])
    expect(result.groups.find(group => group.name === 'Deferred system tools')?.rows[0].deferred).toBe(true)
    expect(usage.contextTokens).toBe(100)
  })
  it('does not reinterpret provider billing counters as context categories', () => {
    const counts = [{ name: 'api usage:input', tokens: 500 }, { name: 'Cached input', tokens: 400 }]
    expect(contextUsageRows({ contextBreakdownSource: 'usage', contextBreakdown: counts })).toEqual({ categories: counts, groups: [] })
  })
})


it('keeps manual compaction status scoped to the selected provider', () => {
  const event: Message = { kind: 'compaction', time: 'now', bridgeId: 'b', status: 'completed', automatic: false, provider: 'codex', message: 'Native completion' }
  expect(latestSessionCompaction([event], 'codex')).toBe(event)
  expect(latestSessionCompaction([event], 'claude')).toBeUndefined()
})

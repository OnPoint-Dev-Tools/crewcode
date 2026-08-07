import { describe, it, expect } from 'vitest'

import { orchestrationAgents, TERMINAL_ONLY_AGENT_IDS } from './terminal-only-agents'

describe('orchestrationAgents', () => {
  const roster = [
    { id: 'pi' }, { id: 'opencode' }, { id: 'claude' }, { id: 'codex' }, { id: 'hermes' }, { id: 'crewcoder' },
  ]

  it('keeps claude and every other bridge-capable agent in chat/crew selection', () => {
    const ids = orchestrationAgents(roster).map(a => a.id)
    expect(ids).toEqual(['pi', 'opencode', 'claude', 'codex', 'hermes', 'crewcoder'])
  })

  it('preserves the original objects and extra fields by reference', () => {
    const withMeta = [{ id: 'pi', available: true }, { id: 'claude', available: true }]
    const out = orchestrationAgents(withMeta)
    expect(out).toEqual(withMeta)
    expect(out[0]).toBe(withMeta[0])
    expect(out[1]).toBe(withMeta[1])
  })

  it('has no terminal-only built-ins while claude is bridge-backed', () => {
    expect([...TERMINAL_ONLY_AGENT_IDS]).toEqual([])
  })
})

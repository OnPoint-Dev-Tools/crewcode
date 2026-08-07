import { describe, it, expect } from 'vitest'
import { delegatedSectionLabel, isDelegated, splitDelegatedSessions } from './delegated-session-split'
import type { Session } from '../../types'

const session = (over: Partial<Session> & { id: string }): Session => ({
  tabId: 'ws1-chat',
  label: over.id,
  agentId: 'claude',
  model: 'sonnet',
  mode: 'build',
  effort: 'medium',
  mcpServerIds: [],
  enabledSkillIds: [],
  ...over,
})

describe('isDelegated', () => {
  // `origin` is the only positive test — a human-created session has none of
  // these fields, so inferring from delegatedBy/worktree would misclassify.
  it('is true only for origin: delegated', () => {
    expect(isDelegated(session({ id: 'a' }))).toBe(false)
    expect(isDelegated(session({ id: 'b', origin: 'delegated' }))).toBe(true)
  })
})

describe('splitDelegatedSessions', () => {
  it('separates delegated threads from the user\'s own', () => {
    const result = splitDelegatedSessions([
      session({ id: 'mine-1' }),
      session({ id: 'child-1', origin: 'delegated', delegatedBy: 'mine-1', delegatedAt: 10 }),
      session({ id: 'mine-2' }),
    ])
    expect(result.own.map(s => s.id)).toEqual(['mine-1', 'mine-2'])
    expect(result.delegated.map(s => s.id)).toEqual(['child-1'])
  })

  it('preserves the drawer\'s existing order for the user\'s own threads', () => {
    const result = splitDelegatedSessions([
      session({ id: 'c' }), session({ id: 'a' }), session({ id: 'b' }),
    ])
    expect(result.own.map(s => s.id)).toEqual(['c', 'a', 'b'])
  })

  it('sorts delegated threads newest first', () => {
    const result = splitDelegatedSessions([
      session({ id: 'old',    origin: 'delegated', delegatedAt: 100 }),
      session({ id: 'newest', origin: 'delegated', delegatedAt: 300 }),
      session({ id: 'mid',    origin: 'delegated', delegatedAt: 200 }),
    ])
    expect(result.delegated.map(s => s.id)).toEqual(['newest', 'mid', 'old'])
  })

  // A row with no timestamp must not sort to the top and displace the thread the
  // user is actually waiting on.
  it('keeps timestamp-less delegated threads last, in stable order', () => {
    const result = splitDelegatedSessions([
      session({ id: 'no-time-1', origin: 'delegated' }),
      session({ id: 'timed',     origin: 'delegated', delegatedAt: 50 }),
      session({ id: 'no-time-2', origin: 'delegated' }),
    ])
    expect(result.delegated.map(s => s.id)).toEqual(['timed', 'no-time-1', 'no-time-2'])
  })

  it('returns empty groups for an empty workspace', () => {
    expect(splitDelegatedSessions([])).toEqual({ own: [], delegated: [] })
  })

  it('does not mutate the input array', () => {
    const input = [session({ id: 'a' }), session({ id: 'b', origin: 'delegated' })]
    const copy = [...input]
    splitDelegatedSessions(input)
    expect(input).toEqual(copy)
  })
})

describe('delegatedSectionLabel', () => {
  const labels: Record<string, string> = { 'mine-1': 'Bridge work', 'mine-2': 'Editor work' }
  const lookup = (id: string) => labels[id]

  it('names the parent when every thread came from the same one', () => {
    const delegated = [
      session({ id: 'c1', origin: 'delegated', delegatedBy: 'mine-1' }),
      session({ id: 'c2', origin: 'delegated', delegatedBy: 'mine-1' }),
    ]
    expect(delegatedSectionLabel(delegated, lookup)).toBe('delegated · Bridge work')
  })

  it('stays generic for a mixed group', () => {
    const delegated = [
      session({ id: 'c1', origin: 'delegated', delegatedBy: 'mine-1' }),
      session({ id: 'c2', origin: 'delegated', delegatedBy: 'mine-2' }),
    ]
    expect(delegatedSectionLabel(delegated, lookup)).toBe('delegated')
  })

  it('stays generic when the parent is gone or unnamed', () => {
    const orphan = [session({ id: 'c1', origin: 'delegated', delegatedBy: 'deleted-parent' })]
    expect(delegatedSectionLabel(orphan, lookup)).toBe('delegated')
    expect(delegatedSectionLabel([session({ id: 'c1', origin: 'delegated' })], lookup)).toBe('delegated')
  })
})

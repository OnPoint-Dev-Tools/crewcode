// Depth-1 is a promise the parent's preamble makes to the agent ("threads you
// create cannot create threads of their own"). It used to hold only because
// children were never handed credentials — true right up until someone turned
// the toggle on inside a delegated thread, at which point nothing refused.

import { describe, expect, it } from 'vitest'
import { canSessionDelegate } from './delegation-eligibility'
import type { Session } from '../types'

function session(over: Partial<Session> = {}): Session {
  return {
    id: 'ws-chat',
    tabId: 'ws-chat',
    label: 'main',
    agentId: 'pi',
    model: 'm',
    mode: 'build',
    effort: 'medium',
    mcpServerIds: [],
    enabledSkillIds: [],
    ...over,
  }
}

describe('canSessionDelegate', () => {
  it('allows an ordinary chat', () => {
    expect(canSessionDelegate(session())).toBe(true)
  })

  it('refuses a thread another agent created', () => {
    expect(canSessionDelegate(session({ origin: 'delegated' }))).toBe(false)
  })

  // Provenance is history, not current ownership — continuing a delegated thread
  // yourself, or the agent marking it done, does not promote it to a root chat.
  it('stays refused however the thread has since been used', () => {
    expect(canSessionDelegate(session({ origin: 'delegated', delegationClosedAt: 1 }))).toBe(false)
    expect(canSessionDelegate(session({ origin: 'delegated', delegationEnabled: true }))).toBe(false)
    expect(canSessionDelegate(session({ origin: 'delegated', archived: true }))).toBe(false)
  })

  // The other delegation fields are set alongside `origin`, but only `origin` is
  // the positive test — inferring from them would misclassify a plain chat that
  // happens to carry a worktree path.
  it('does not infer delegation from worktree or parent fields alone', () => {
    expect(canSessionDelegate(session({ delegatedWorktreePath: '/wt', delegatedBranch: 'x' }))).toBe(true)
    expect(canSessionDelegate(session({ delegatedBy: 'someone' }))).toBe(true)
  })

  it('is false for no session, so a missing chat never delegates by default', () => {
    expect(canSessionDelegate(null)).toBe(false)
    expect(canSessionDelegate(undefined)).toBe(false)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { delegationInbox, useDelegationInboxStore } from './delegation-inbox-store'
import { MAX_BUFFERED_REPORTS, type DelegationReport } from '../hooks/delegation-report'

function report(over: Partial<DelegationReport> = {}): DelegationReport {
  return {
    threadId: 't1',
    parentSessionId: 'parent-1',
    title: 'sweep',
    reply: 'all green',
    failed: false,
    at: 1,
    ...over,
  }
}

beforeEach(() => {
  vi.stubGlobal('window', {})
  useDelegationInboxStore.setState({ reportsByParent: {} })
})

describe('delegationInbox', () => {
  it('holds reports per parent and hands them back in arrival order', () => {
    delegationInbox.push(report({ threadId: 'a' }))
    delegationInbox.push(report({ threadId: 'b' }))
    delegationInbox.push(report({ threadId: 'c', parentSessionId: 'parent-2' }))

    expect(delegationInbox.take('parent-1').map(r => r.threadId)).toEqual(['a', 'b'])
    expect(delegationInbox.peek('parent-2')).toHaveLength(1)
  })

  // The drain must be exactly once: a report riding on two prompts is the same
  // token bill twice and reads to the agent as two separate finishes.
  it('drains a parent exactly once', () => {
    delegationInbox.push(report())

    expect(delegationInbox.take('parent-1')).toHaveLength(1)
    expect(delegationInbox.take('parent-1')).toEqual([])
  })

  it('is safe on a parent that never had reports', () => {
    expect(delegationInbox.take('nobody')).toEqual([])
    expect(delegationInbox.peek('nobody')).toEqual([])
  })

  // An agent that spawns in a loop must not be able to grow one prompt without
  // bound. Newest wins — a stale report matters less than the latest state.
  it('caps buffered reports and drops the oldest', () => {
    for (let i = 0; i < MAX_BUFFERED_REPORTS + 5; i++) {
      delegationInbox.push(report({ threadId: `t${i}` }))
    }

    const pending = delegationInbox.take('parent-1')
    expect(pending).toHaveLength(MAX_BUFFERED_REPORTS)
    expect(pending[0].threadId).toBe('t5')
    expect(pending[pending.length - 1].threadId).toBe(`t${MAX_BUFFERED_REPORTS + 4}`)
  })

  it('clears one parent without touching another', () => {
    delegationInbox.push(report())
    delegationInbox.push(report({ parentSessionId: 'parent-2' }))

    delegationInbox.clear('parent-1')
    expect(delegationInbox.peek('parent-1')).toEqual([])
    expect(delegationInbox.peek('parent-2')).toHaveLength(1)
  })
})

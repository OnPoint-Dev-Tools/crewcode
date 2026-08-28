import { beforeEach, describe, expect, it } from 'vitest'

import { bridgeActivity, useBridgeActivityStore } from './bridge-activity-store'
import type { AgentUserRequest } from '../types'

const state = () => useBridgeActivityStore.getState()

function request(requestId: string, bridgeId: string): AgentUserRequest {
  return { requestId, bridgeId, kind: 'permission', title: `allow ${requestId}?` }
}

beforeEach(() => { bridgeActivity.reset() })

describe('bridge-activity-store — running', () => {
  it('adds and removes the running flag', () => {
    bridgeActivity.setRunning('b1', true)
    expect(state().runningByBridge).toEqual({ b1: true })

    bridgeActivity.setRunning('b1', false)
    expect(state().runningByBridge).toEqual({})
  })

  it('keeps identity stable on a no-op so selectors do not fire', () => {
    bridgeActivity.setRunning('b1', true)
    const before = state().runningByBridge
    bridgeActivity.setRunning('b1', true)
    expect(state().runningByBridge).toBe(before)

    bridgeActivity.setRunning('missing', false)
    expect(state().runningByBridge).toBe(before)
  })

  it('keys Running by conversation scope so the drawer can list a chat before the registry map commits', () => {
    bridgeActivity.bindScope('b-grok', 'sess-1')
    bridgeActivity.setRunning('b-grok', true)
    expect(state().runningByScope).toEqual({ 'sess-1': true })

    bridgeActivity.setRunning('b-grok', false)
    expect(state().runningByScope).toEqual({})
  })

  it('keeps a scope running while any of its bridges is still in flight', () => {
    bridgeActivity.bindScope('b1', 'sess-1')
    bridgeActivity.bindScope('b2', 'sess-1')
    bridgeActivity.setRunning('b1', true)
    bridgeActivity.setRunning('b2', true)
    bridgeActivity.setRunning('b1', false)
    expect(state().runningByScope).toEqual({ 'sess-1': true })
    bridgeActivity.setRunning('b2', false)
    expect(state().runningByScope).toEqual({})
  })
})

describe('bridge-activity-store — status', () => {
  it('sets, replaces, and clears status', () => {
    bridgeActivity.setStatus('b1', 'resuming')
    expect(state().statusByBridge).toEqual({ b1: 'resuming' })

    const before = state().statusByBridge
    bridgeActivity.setStatus('b1', 'resuming')
    expect(state().statusByBridge).toBe(before)

    bridgeActivity.setStatus('b1', null)
    expect(state().statusByBridge).toEqual({})
  })
})

describe('bridge-activity-store — follow-ups', () => {
  it('appends in order and dedupes by id', () => {
    bridgeActivity.addFollowUp('b1', 'fu-1', 'first')
    bridgeActivity.addFollowUp('b1', 'fu-2', 'second')
    bridgeActivity.addFollowUp('b1', 'fu-1', 'duplicate')

    expect(state().followUpsByBridge.b1).toEqual([
      { id: 'fu-1', text: 'first' },
      { id: 'fu-2', text: 'second' },
    ])
  })

  it('drops the bridge key once the last follow-up leaves', () => {
    bridgeActivity.addFollowUp('b1', 'fu-1', 'only')
    bridgeActivity.removeFollowUp('b1', 'fu-1')
    expect(state().followUpsByBridge).toEqual({})
  })
})

describe('bridge-activity-store — user requests', () => {
  it('dedupes by requestId and resolves by tab', () => {
    bridgeActivity.addUserRequest('tab-1', request('r1', 'b1'))
    bridgeActivity.addUserRequest('tab-1', request('r1', 'b1'))
    expect(state().userRequestsByTab['tab-1']).toHaveLength(1)

    bridgeActivity.removeUserRequest('tab-1', 'r1')
    expect(state().userRequestsByTab).toEqual({})
  })

  it('resolves a request by id when the tab is unknown', () => {
    bridgeActivity.addUserRequest('tab-1', request('r1', 'b1'))
    bridgeActivity.addUserRequest('tab-2', request('r2', 'b2'))

    bridgeActivity.removeUserRequestById('r2')
    expect(Object.keys(state().userRequestsByTab)).toEqual(['tab-1'])
  })

  it('drops a settled bridge’s pending requests across every tab', () => {
    bridgeActivity.addUserRequest('tab-1', request('r1', 'b1'))
    bridgeActivity.addUserRequest('tab-2', request('r2', 'b1'))
    bridgeActivity.addUserRequest('tab-2', request('r3', 'b2'))

    bridgeActivity.removeRequestsForBridge('b1')
    expect(state().userRequestsByTab).toEqual({ 'tab-2': [request('r3', 'b2')] })
  })
})

describe('bridge-activity-store — teardown', () => {
  it('clearBridges forgets running/status/follow-ups but preserves requests', () => {
    // An idle-stopped bridge keeps its tab's requests; only an explicit drop or
    // tab release clears them. Guards a 1:1 port of the old registry semantics.
    bridgeActivity.setRunning('b1', true)
    bridgeActivity.setStatus('b1', 'thinking')
    bridgeActivity.addFollowUp('b1', 'fu-1', 'later')
    bridgeActivity.addUserRequest('tab-1', request('r1', 'b1'))

    bridgeActivity.clearBridges(['b1'])

    expect(state().runningByBridge).toEqual({})
    expect(state().runningByScope).toEqual({})
    expect(state().statusByBridge).toEqual({})
    expect(state().followUpsByBridge).toEqual({})
    expect(state().userRequestsByTab['tab-1']).toHaveLength(1)
  })

  it('dropRequestsForBridges removes only the released bridges’ requests', () => {
    bridgeActivity.addUserRequest('tab-1', request('r1', 'b1'))
    bridgeActivity.addUserRequest('tab-1', request('r2', 'b2'))

    bridgeActivity.dropRequestsForBridges(['b1'])
    expect(state().userRequestsByTab['tab-1']).toEqual([request('r2', 'b2')])
  })

  it('clearTabRequests wipes one tab only', () => {
    bridgeActivity.addUserRequest('tab-1', request('r1', 'b1'))
    bridgeActivity.addUserRequest('tab-2', request('r2', 'b2'))

    bridgeActivity.clearTabRequests('tab-1')
    expect(Object.keys(state().userRequestsByTab)).toEqual(['tab-2'])
  })

  it('is a no-op for unknown ids', () => {
    const before = state()
    bridgeActivity.clearBridges([])
    bridgeActivity.clearBridges(['nope'])
    bridgeActivity.clearTabRequests('nope')
    expect(state().runningByBridge).toBe(before.runningByBridge)
    expect(state().userRequestsByTab).toBe(before.userRequestsByTab)
  })
})

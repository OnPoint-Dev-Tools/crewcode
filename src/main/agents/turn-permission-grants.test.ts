import { describe, expect, it } from 'vitest'

import type { AgentUserRequest } from './bridge-types'
import { TurnPermissionGrantStore } from './turn-permission-grants'

const permission = {
  kind: 'permission' as const,
  turnId: 'turn-1',
  title: 'allow write',
}

function pendingRequest(overrides: Partial<AgentUserRequest> = {}): AgentUserRequest {
  return {
    requestId: 'request-1',
    bridgeId: 'bridge-1',
    ...permission,
    ...overrides,
  }
}

describe('TurnPermissionGrantStore', () => {
  it('offers allow-all only for writable Build permission requests with a turn id', () => {
    const store = new TurnPermissionGrantStore()

    expect(store.prepareRequest('bridge-1', 'build', 'default', permission).request.allowAllForTurn).toBe(true)
    expect(store.prepareRequest('bridge-1', 'ask', 'default', { ...permission, allowAllForTurn: true }).request.allowAllForTurn).toBeUndefined()
    expect(store.prepareRequest('bridge-1', 'build', 'read-only', permission).request.allowAllForTurn).toBeUndefined()
    expect(store.prepareRequest('bridge-1', 'build', 'default', { ...permission, turnId: undefined }).request.allowAllForTurn).toBeUndefined()
  })

  it('auto-accepts later permissions only in the granted bridge turn', () => {
    const store = new TurnPermissionGrantStore()
    expect(store.grant('bridge-1', pendingRequest({ allowAllForTurn: true }))).toBe(true)

    expect(store.prepareRequest('bridge-1', 'build', 'default', permission).autoResponse?.action).toBe('accept')
    expect(store.prepareRequest('bridge-1', 'build', 'default', { ...permission, turnId: 'turn-2' }).autoResponse).toBeUndefined()
    expect(store.prepareRequest('bridge-2', 'build', 'default', permission).autoResponse).toBeUndefined()
  })

  it('clears grants at turn and bridge boundaries', () => {
    const store = new TurnPermissionGrantStore()
    store.grant('bridge-1', pendingRequest({ allowAllForTurn: true }))
    store.clearTurn('bridge-1', 'turn-1')
    expect(store.prepareRequest('bridge-1', 'build', 'default', permission).autoResponse).toBeUndefined()

    store.grant('bridge-1', pendingRequest({ allowAllForTurn: true }))
    store.clearBridge('bridge-1')
    expect(store.prepareRequest('bridge-1', 'build', 'default', permission).autoResponse).toBeUndefined()
  })

  it('rejects escalation for an ineligible request', () => {
    const store = new TurnPermissionGrantStore()
    expect(store.grant('bridge-1', pendingRequest())).toBe(false)
  })
})

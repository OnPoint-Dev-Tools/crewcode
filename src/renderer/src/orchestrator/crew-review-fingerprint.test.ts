import { describe, expect, it } from 'vitest'

import { crewReviewFingerprint } from './crew-review-fingerprint'
import type { CrewAgentLane } from './crew-session'

function lane(over: Partial<CrewAgentLane> = {}): CrewAgentLane {
  return {
    laneId: 'lane-1', agentId: 'pi', model: '', effort: null,
    roleId: null, roleName: '', role: '', instructions: '',
    status: 'running', branch: 'crew/demo/pi-1', path: '/repo/.worktrees/pi-1',
    worktreeId: 'wt-1', tabId: 'crew/lane-1', bridgeId: 'bridge-1', paneId: null,
    muted: false, nextAction: 'implement parser',
    usage: { tokensIn: 1, tokensOut: 2, elapsedMs: 3 }, error: null,
    ...over,
  }
}

describe('crewReviewFingerprint', () => {
  it('ignores runtime, pause, usage, and checkpoint updates that caused review flicker', () => {
    const before = crewReviewFingerprint([lane()])
    const after = crewReviewFingerprint([lane({
      status: 'ready', bridgeId: null, muted: true, nextAction: 'run parser tests',
      usage: { tokensIn: 20, tokensOut: 30, elapsedMs: 4_000 },
    })])
    expect(after).toBe(before)
  })

  it('changes when Git ownership inputs change', () => {
    const before = crewReviewFingerprint([lane()])
    expect(crewReviewFingerprint([lane({ branch: 'crew/demo/pi-2' })])).not.toBe(before)
    expect(crewReviewFingerprint([lane({ path: '/repo/.worktrees/pi-2' })])).not.toBe(before)
    expect(crewReviewFingerprint([lane({ laneId: 'lane-2' })])).not.toBe(before)
  })

  it('refreshes when a pending lane starts owning a workspace', () => {
    const before = crewReviewFingerprint([lane({ status: 'pending', path: '' })])
    const after = crewReviewFingerprint([lane({ status: 'provisioning', path: '' })])
    expect(after).not.toBe(before)
  })
})

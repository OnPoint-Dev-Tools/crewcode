import { describe, expect, it } from 'vitest'

import { buildCrewRounds } from './crew-rounds'
import type { CrewAgentLane } from '../../orchestrator/crew-session'
import type { Message } from '../../types'

function lane(laneId: string): CrewAgentLane {
  return {
    laneId,
    agentId: laneId,
    model: '',
    effort: null,
    roleId: null,
    roleName: '',
    role: '',
    instructions: '',
    status: 'running',
    branch: 'main',
    path: '/repo',
    worktreeId: null,
    tabId: `tab-${laneId}`,
    bridgeId: null,
    paneId: null,
    muted: false,
    usage: { tokensIn: 0, tokensOut: 0, elapsedMs: 0 },
    error: null,
  }
}

function user(text: string): Message {
  return { kind: 'user', text, time: '1:00' }
}

function agent(text: string): Message {
  return { kind: 'agent', blocks: [], text, time: '1:01' }
}

describe('buildCrewRounds', () => {
  it('preserves each lane prompt for split-work timelines', () => {
    const rounds = buildCrewRounds([
      { lane: lane('pi'), messages: [user('task for pi'), agent('pi done')] },
      { lane: lane('claude'), messages: [user('task for claude'), agent('claude done')] },
    ])

    expect(rounds).toHaveLength(1)
    expect(rounds[0].prompt).toBe('task for pi')
    expect(rounds[0].groups.map(group => group.prompt)).toEqual(['task for pi', 'task for claude'])
    expect(rounds[0].groups.map(group => group.messages[0]?.kind)).toEqual(['agent', 'agent'])
  })
})

import { describe, expect, it } from 'vitest'
import type { Message } from '../types'
import { voiceAgentActivityPresentation } from './voice-agent-activity'

const toolCall = (status: 'pending' | 'running' | 'completed' | 'error'): Message => ({
  kind: 'toolcall',
  time: 'now',
  turnId: 'turn-1',
  toolCallId: 'tool-1',
  toolName: 'read',
  args: {},
  status,
})

describe('voiceAgentActivityPresentation', () => {
  it.each(['pending', 'running'] as const)('shows Running tools for a %s tool call', status => {
    expect(voiceAgentActivityPresentation([toolCall(status)], 0, true, 'Codex')).toEqual({
      phase: 'waiting',
      status: 'Running tools',
    })
  })

  it('keeps a running agent in waiting after its tool settles', () => {
    expect(voiceAgentActivityPresentation([toolCall('completed')], 0, true, 'Codex')).toEqual({
      phase: 'waiting',
      status: 'Codex is working',
    })
  })

  it('does not override transport state outside an active voice-started turn', () => {
    expect(voiceAgentActivityPresentation([toolCall('running')], null, true, 'Codex')).toBeNull()
    expect(voiceAgentActivityPresentation([toolCall('running')], 0, false, 'Codex')).toBeNull()
  })
})

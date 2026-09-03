import { describe, expect, it } from 'vitest'

import type { Session } from '../types'
import { sortOwnSessionsForDrawer } from './chat-session-order'

function session(id: string, tabId = id): Session {
  return {
    id,
    tabId,
    label: id,
    agentId: 'pi',
    model: '',
    mode: 'build',
    effort: 'medium',
    mcpServerIds: [],
    enabledSkillIds: [],
  }
}

describe('drawer session order', () => {
  it('puts newest extra chat tabs above older ones and the canonical chat last', () => {
    const ordered = sortOwnSessionsForDrawer([
      session('workspace-chat'),
      session('workspace-chat-mthkwkth-4'),
      session('workspace-chat-mqwmxqm7-1'),
      session('workspace-chat-mtbvpja1-5::s2', 'workspace-chat-mtbvpja1-5'),
      session('workspace-chat-mtbvpja1-5', 'workspace-chat-mtbvpja1-5'),
    ])

    expect(ordered.map(item => item.id)).toEqual([
      'workspace-chat-mthkwkth-4',
      'workspace-chat-mtbvpja1-5::s2',
      'workspace-chat-mtbvpja1-5',
      'workspace-chat-mqwmxqm7-1',
      'workspace-chat',
    ])
  })
})

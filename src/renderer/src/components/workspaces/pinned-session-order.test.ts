import { describe, expect, it } from 'vitest'

import type { Session } from '../../types'
import { pinnedSessionsFirst } from './pinned-session-order'

function session(id: string, pinned = false): Session {
  return {
    id,
    tabId: 'tab',
    label: id,
    agentId: 'pi',
    model: '',
    mode: 'build',
    effort: 'medium',
    mcpServerIds: [],
    enabledSkillIds: [],
    pinned,
  }
}

describe('pinned session order', () => {
  it('moves pinned sessions ahead of unpinned sessions', () => {
    const ordered = pinnedSessionsFirst([
      session('newest'),
      session('older-pinned', true),
      session('oldest'),
    ])

    expect(ordered.map(item => item.id)).toEqual(['older-pinned', 'newest', 'oldest'])
  })

  it('preserves relative order within both groups', () => {
    const ordered = pinnedSessionsFirst([
      session('unpinned-new'),
      session('pinned-new', true),
      session('unpinned-old'),
      session('pinned-old', true),
    ])

    expect(ordered.map(item => item.id)).toEqual([
      'pinned-new',
      'pinned-old',
      'unpinned-new',
      'unpinned-old',
    ])
  })
})

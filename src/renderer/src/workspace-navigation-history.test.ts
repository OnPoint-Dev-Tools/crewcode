import { describe, expect, it } from 'vitest'

import {
  EMPTY_WORKSPACE_NAVIGATION_HISTORY,
  moveInTabHistory,
  moveInWorkspaceHistory,
  recordTabVisit,
  recordWorkspaceVisit,
} from './workspace-navigation-history'

describe('workspace navigation history', () => {
  it('moves backward and forward through workspace/tab/chat destinations', () => {
    let history = recordWorkspaceVisit(EMPTY_WORKSPACE_NAVIGATION_HISTORY, {
      wsId: 'alpha', tabId: 'alpha-chat', sessionId: 'alpha-session',
    })
    history = recordWorkspaceVisit(history, {
      wsId: 'beta', tabId: 'beta-chat-2', sessionId: 'beta-session',
    })

    const back = moveInWorkspaceHistory(history, -1, new Set(['alpha', 'beta']))
    expect(back.visit).toEqual({ wsId: 'alpha', tabId: 'alpha-chat', sessionId: 'alpha-session' })

    const forward = moveInWorkspaceHistory(back.history, 1, new Set(['alpha', 'beta']))
    expect(forward.visit).toEqual({ wsId: 'beta', tabId: 'beta-chat-2', sessionId: 'beta-session' })
  })

  it('updates the current workspace destination without creating another history step', () => {
    let history = recordWorkspaceVisit(EMPTY_WORKSPACE_NAVIGATION_HISTORY, { wsId: 'alpha', tabId: 'chat-1' })
    history = recordWorkspaceVisit(history, { wsId: 'alpha', tabId: 'chat-2', sessionId: 'thread-2' })

    expect(history.entries).toEqual([{ wsId: 'alpha', tabId: 'chat-2', sessionId: 'thread-2' }])
  })

  it('drops forward history after visiting a new workspace and skips removed workspaces', () => {
    let history = recordWorkspaceVisit(EMPTY_WORKSPACE_NAVIGATION_HISTORY, { wsId: 'alpha', tabId: 'a' })
    history = recordWorkspaceVisit(history, { wsId: 'removed', tabId: 'r' })
    history = recordWorkspaceVisit(history, { wsId: 'beta', tabId: 'b' })

    const back = moveInWorkspaceHistory(history, -1, new Set(['alpha', 'beta', 'gamma']))
    expect(back.visit?.wsId).toBe('alpha')

    history = recordWorkspaceVisit(back.history, { wsId: 'gamma', tabId: 'g' })
    expect(history.entries.map(entry => entry.wsId)).toEqual(['alpha', 'gamma'])
    expect(moveInWorkspaceHistory(history, 1, new Set(['alpha', 'beta', 'gamma'])).visit).toBeNull()
  })
})

describe('workspace-local tab navigation history', () => {
  it('moves backward and forward by visit order rather than tab position', () => {
    let history = recordTabVisit(EMPTY_WORKSPACE_NAVIGATION_HISTORY, { wsId: 'alpha', tabId: 'tab-3' })
    history = recordTabVisit(history, { wsId: 'alpha', tabId: 'tab-1', sessionId: 'thread-1' })
    history = recordTabVisit(history, { wsId: 'alpha', tabId: 'tab-2' })

    const back = moveInTabHistory(history, -1, new Set(['tab-1', 'tab-2', 'tab-3']))
    expect(back.visit).toEqual({ wsId: 'alpha', tabId: 'tab-1', sessionId: 'thread-1' })
    expect(moveInTabHistory(back.history, 1, new Set(['tab-1', 'tab-2', 'tab-3'])).visit?.tabId).toBe('tab-2')
  })

  it('updates a chat session in place and skips closed tabs', () => {
    let history = recordTabVisit(EMPTY_WORKSPACE_NAVIGATION_HISTORY, { wsId: 'alpha', tabId: 'chat', sessionId: 'one' })
    history = recordTabVisit(history, { wsId: 'alpha', tabId: 'chat', sessionId: 'two' })
    history = recordTabVisit(history, { wsId: 'alpha', tabId: 'closed' })
    history = recordTabVisit(history, { wsId: 'alpha', tabId: 'current' })

    expect(history.entries[0]).toEqual({ wsId: 'alpha', tabId: 'chat', sessionId: 'two' })
    expect(moveInTabHistory(history, -1, new Set(['chat', 'current'])).visit?.tabId).toBe('chat')
  })
})

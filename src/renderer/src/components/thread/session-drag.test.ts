import { describe, expect, it } from 'vitest'

import type { Tab } from '../../types'
import {
  decodeSessionDrag,
  encodeSessionDrag,
  insertTabAfter,
  isSessionDrag,
  planSessionSplit,
  tabDisplaysSession,
} from './session-drag'

function tab(partial: Partial<Tab> & Pick<Tab, 'id'>): Tab {
  return { kind: 'chat', label: partial.label ?? partial.id, ...partial }
}

describe('session drag payload', () => {
  it('round-trips session id and owner tab', () => {
    const raw = encodeSessionDrag({ sessionId: 'ws-chat::s2', tabId: 'ws-chat' })
    expect(decodeSessionDrag(raw)).toEqual({ sessionId: 'ws-chat::s2', tabId: 'ws-chat' })
  })

  it('rejects malformed payloads and random text', () => {
    expect(decodeSessionDrag('')).toBeNull()
    expect(decodeSessionDrag('not-json')).toBeNull()
    expect(decodeSessionDrag(JSON.stringify({ sessionId: 'a' }))).toBeNull()
    expect(isSessionDrag(['text/plain'])).toBe(false)
    expect(isSessionDrag(['application/x-crewcode-session'])).toBe(true)
  })
})

describe('planSessionSplit', () => {
  const owner = tab({ id: 'ws-chat' })
  const other = tab({ id: 'ws-chat-other' })
  const term = tab({ id: 'ws-term', kind: 'terminal', label: 'Terminal' })

  it('no-ops when the drop target already shows that session', () => {
    expect(planSessionSplit({
      sessionId: 'ws-chat',
      ownerTabId: 'ws-chat',
      anchorTabId: 'ws-chat',
      tabs: [owner],
      splitGroups: [],
      ownerActiveSessionId: 'ws-chat',
    })).toEqual({ type: 'noop' })
  })

  it('reuses the owner tab when splitting onto a different unsplit tab', () => {
    expect(planSessionSplit({
      sessionId: 'ws-chat::s2',
      ownerTabId: 'ws-chat',
      anchorTabId: 'ws-term',
      tabs: [owner, term],
      splitGroups: [],
      ownerActiveSessionId: 'ws-chat',
    })).toEqual({ type: 'reuse', tabId: 'ws-chat' })
  })

  it('opens a viewport when the owner pane is already visible with another session', () => {
    expect(planSessionSplit({
      sessionId: 'ws-chat::s2',
      ownerTabId: 'ws-chat',
      anchorTabId: 'ws-chat',
      tabs: [owner],
      splitGroups: [],
      ownerActiveSessionId: 'ws-chat',
    })).toEqual({ type: 'viewport' })
  })

  it('opens a viewport when the owner tab is already in another split group', () => {
    expect(planSessionSplit({
      sessionId: 'ws-chat',
      ownerTabId: 'ws-chat',
      anchorTabId: 'ws-term',
      tabs: [owner, other, term],
      splitGroups: [{ id: 'g1', primary: 'ws-chat', tabs: ['ws-chat', 'ws-chat-other'] }],
      ownerActiveSessionId: 'ws-chat',
    })).toEqual({ type: 'viewport' })
  })

  it('reuses an existing free viewport instead of minting another', () => {
    const view = tab({
      id: 'ws-chat-view',
      sessionOwnerTabId: 'ws-chat',
      pinnedSessionId: 'ws-chat::s2',
      label: 'Thread two',
    })
    expect(planSessionSplit({
      sessionId: 'ws-chat::s2',
      ownerTabId: 'ws-chat',
      anchorTabId: 'ws-term',
      tabs: [owner, term, view],
      splitGroups: [],
      ownerActiveSessionId: 'ws-chat',
    })).toEqual({ type: 'reuse', tabId: 'ws-chat-view' })
  })

  it('inserts the incoming tab after the drop target', () => {
    expect(insertTabAfter(['a', 'b', 'c'], 'b', 'x')).toEqual(['a', 'b', 'x', 'c'])
    expect(insertTabAfter(['a'], 'a', 'x')).toEqual(['a', 'x'])
    expect(insertTabAfter(['a', 'x'], 'a', 'x')).toEqual(['a', 'x'])
  })

  it('treats a pinned viewport as displaying its session', () => {
    expect(tabDisplaysSession(
      tab({ id: 'view', sessionOwnerTabId: 'ws-chat', pinnedSessionId: 'ws-chat::s2' }),
      'ws-chat::s2',
      'ws-chat',
      'ws-chat',
    )).toBe(true)
  })
})

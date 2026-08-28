import { describe, expect, it } from 'vitest'

import { liveSessionAgentStatus, liveWorkingChats } from './working-chats'

function session(id: string, tabId = 'tab') {
  return { id, tabId, label: id, agentId: 'grok' }
}

function workspace(id: string) {
  return { id, name: id }
}

describe('live working chats', () => {
  it('promotes a running Grok scope into the drawer Running list', () => {
    const ws = workspace('ws-1')
    const grok = session('chat-1')
    const working = liveWorkingChats([ws], { 'ws-1': [grok] }, { 'chat-1': true }, [])
    expect(working).toEqual([{
      sessionId: 'chat-1',
      tabId: 'tab',
      wsId: 'ws-1',
      label: 'chat-1',
      wsName: 'ws-1',
      agentId: 'grok',
    }])
  })

  it('keeps the App fallback when no live scope is running', () => {
    const fallback = [{
      sessionId: 'stale',
      tabId: 'tab',
      wsId: 'ws-1',
      label: 'stale',
      wsName: 'ws-1',
      agentId: 'grok',
    }]
    expect(liveWorkingChats([workspace('ws-1')], { 'ws-1': [session('chat-1')] }, {}, fallback)).toBe(fallback)
  })

  it('marks a live running session working even if App still thinks it is idle', () => {
    const status = liveSessionAgentStatus(
      { 'chat-1': 'done' },
      { 'ws-1': [session('chat-1')] },
      { 'chat-1': true },
    )
    expect(status['chat-1']).toBe('working')
  })
})

import { describe, it, expect } from 'vitest'
import { tabIdForSessionId, workspaceForChatTab } from './chat-tab-workspace-lookup'

describe('tabIdForSessionId', () => {
  // The first session in a tab reuses the tab id; later ones are suffixed.
  it('handles both session id shapes', () => {
    expect(tabIdForSessionId('ws1-chat')).toBe('ws1-chat')
    expect(tabIdForSessionId('ws1-chat::s3')).toBe('ws1-chat')
  })
})

describe('workspaceForChatTab', () => {
  const workspaces = [{ id: 'ws1' }, { id: 'ws2' }]

  it('matches the owning workspace by prefix', () => {
    expect(workspaceForChatTab('ws1-chat', workspaces)).toEqual({ id: 'ws1' })
    expect(workspaceForChatTab('ws2-chat', workspaces)).toEqual({ id: 'ws2' })
  })

  it('matches a tab id equal to the workspace id', () => {
    expect(workspaceForChatTab('ws1', workspaces)).toEqual({ id: 'ws1' })
  })

  // A plain prefix scan hands `a-b-chat` to `a`, sending the user to the wrong
  // workspace and a tab that isn't there.
  it('prefers the longest matching workspace id', () => {
    const overlapping = [{ id: 'a' }, { id: 'a-b' }]
    expect(workspaceForChatTab('a-b-chat', overlapping)).toEqual({ id: 'a-b' })
    expect(workspaceForChatTab('a-chat', overlapping)).toEqual({ id: 'a' })
  })

  it('returns undefined when nothing owns the tab', () => {
    expect(workspaceForChatTab('orphan-chat', workspaces)).toBeUndefined()
    expect(workspaceForChatTab('ws1-chat', [])).toBeUndefined()
  })

  // `ws10` must not be captured by `ws1`.
  it('does not match a workspace whose id is a bare prefix without a separator', () => {
    expect(workspaceForChatTab('ws10-chat', [{ id: 'ws1' }])).toBeUndefined()
  })
})

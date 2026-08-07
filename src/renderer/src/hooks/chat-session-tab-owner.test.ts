import { describe, expect, it } from 'vitest'
import { chatSessionOwnerWorkspaceId, chatSessionSurface, isChatSessionTabId } from './chat-session-tab-owner'

describe('chatSessionSurface', () => {
  it('labels writer workspace threads', () => {
    expect(chatSessionSurface('ws1-writer-abc-1')).toBe('writer')
    expect(chatSessionSurface('ws1-writer')).toBe('writer')
  })

  it('labels every other chat surface as chat', () => {
    expect(chatSessionSurface('ws1-chat')).toBe('chat')
    expect(chatSessionSurface('ws1-chat-abc-1')).toBe('chat')
    expect(chatSessionSurface('ws1-chat-canvas-ws1-canvas-1-chat-x-1')).toBe('chat')
    expect(chatSessionSurface('ws-writerly-chat')).toBe('chat')
  })
})

describe('isChatSessionTabId', () => {
  it('accepts the canonical chat tab and secondary chat tabs', () => {
    expect(isChatSessionTabId('ws1-chat', 'ws1')).toBe(true)
    expect(isChatSessionTabId('ws1-chat-abc-1', 'ws1')).toBe(true)
  })

  it('accepts workbench pane ids minted under the chat namespace', () => {
    expect(isChatSessionTabId('ws1-chat-canvas-ws1-canvas-1-chat-x-1', 'ws1')).toBe(true)
  })

  it('accepts writer workspace tabs, which embed a real chat pane', () => {
    expect(isChatSessionTabId('ws1-writer-abc-1', 'ws1')).toBe(true)
    expect(isChatSessionTabId('ws1-writer', 'ws1')).toBe(true)
  })

  it('rejects surfaces that do not own chat sessions', () => {
    expect(isChatSessionTabId('ws1-code', 'ws1')).toBe(false)
    expect(isChatSessionTabId('ws1-terminal-abc-1', 'ws1')).toBe(false)
    expect(isChatSessionTabId('ws2-chat', 'ws1')).toBe(false)
  })
})

describe('chatSessionOwnerWorkspaceId', () => {
  it('returns the owning workspace for writer tabs', () => {
    expect(chatSessionOwnerWorkspaceId('ws1-writer-abc-1', ['ws1', 'ws2'])).toBe('ws1')
  })

  it('prefers the longest matching workspace id', () => {
    expect(chatSessionOwnerWorkspaceId('ws1-extra-writer-1', ['ws1', 'ws1-extra'])).toBe('ws1-extra')
  })

  it('returns null when no workspace owns the tab', () => {
    expect(chatSessionOwnerWorkspaceId('ws1-git', ['ws1'])).toBe(null)
  })
})

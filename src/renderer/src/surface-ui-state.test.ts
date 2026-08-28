import { describe, expect, it } from 'vitest'

import { isSurfaceOpen, setSurfaceOpen } from './surface-ui-state'

describe('surface UI state', () => {
  it('keeps an open drawer isolated to the chat that opened it', () => {
    const state = setSurfaceOpen({}, 'chat-one', true)

    expect(isSurfaceOpen(state, 'chat-one')).toBe(true)
    expect(isSurfaceOpen(state, 'chat-two')).toBe(false)
  })

  it('preserves independent drawer state while switching chats', () => {
    const firstOpen = setSurfaceOpen({}, 'chat-one', true)
    const bothOpen = setSurfaceOpen(firstOpen, 'chat-two', true)
    const secondClosed = setSurfaceOpen(bothOpen, 'chat-two', false)

    expect(isSurfaceOpen(secondClosed, 'chat-one')).toBe(true)
    expect(isSurfaceOpen(secondClosed, 'chat-two')).toBe(false)
  })
})

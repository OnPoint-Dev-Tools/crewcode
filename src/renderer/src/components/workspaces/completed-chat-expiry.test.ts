import { describe, expect, it } from 'vitest'

import { COMPLETED_CHAT_LIFETIME_MS, isCompletedChatShortcutVisible } from './completed-chat-expiry'

describe('completed chat shortcut expiry', () => {
  const completedAt = 10_000

  it('keeps a completed shortcut visible before one hour', () => {
    expect(isCompletedChatShortcutVisible(completedAt, completedAt + COMPLETED_CHAT_LIFETIME_MS - 1)).toBe(true)
  })

  it('expires a completed shortcut at exactly one hour', () => {
    expect(isCompletedChatShortcutVisible(completedAt, completedAt + COMPLETED_CHAT_LIFETIME_MS)).toBe(false)
  })

  it('keeps future timestamps visible if the system clock moves backward', () => {
    expect(isCompletedChatShortcutVisible(completedAt, completedAt - 1)).toBe(true)
  })
})

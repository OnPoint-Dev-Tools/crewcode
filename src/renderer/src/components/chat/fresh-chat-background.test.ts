import { describe, expect, it } from 'vitest'
import {
  FRESH_CHAT_BACKGROUND_MAX_BYTES,
  deriveChatBackgroundPalette,
  freshChatBackgroundError,
  normalizeChatBackgroundPalette,
  normalizeFreshChatBackground,
  shouldShowChatBackground,
} from './fresh-chat-background'

describe('fresh chat background validation', () => {
  it('accepts bounded raster uploads', () => {
    expect(freshChatBackgroundError({ type: 'image/png', size: 278_759 })).toBeNull()
    expect(normalizeFreshChatBackground('data:image/png;base64,aGVsbG8=')).toBe('data:image/png;base64,aGVsbG8=')
  })

  it('rejects active or unsupported image formats', () => {
    expect(freshChatBackgroundError({ type: 'image/svg+xml', size: 200 })).toMatch(/png/)
    expect(normalizeFreshChatBackground('data:image/svg+xml;base64,PHN2Zz4=')).toBe('')
    expect(normalizeFreshChatBackground('https://example.com/background.png')).toBe('')
  })

  it('rejects oversized uploads and persisted values', () => {
    expect(freshChatBackgroundError({ type: 'image/jpeg', size: FRESH_CHAT_BACKGROUND_MAX_BYTES + 1 })).toMatch(/2 MB/)
    expect(normalizeFreshChatBackground(`data:image/png;base64,${'a'.repeat(FRESH_CHAT_BACKGROUND_MAX_BYTES * 2)}`)).toBe('')
  })

  it('derives a contrast-safe dark palette from dark pixels', () => {
    const palette = deriveChatBackgroundPalette(new Uint8ClampedArray([
      24, 38, 82, 255,
      40, 58, 120, 255,
      28, 42, 94, 255,
    ]))
    expect(palette.mode).toBe('dark')
    expect(palette.primary).toMatch(/^hsl\(/)
    expect(palette.foreground).not.toBe(palette.background)
    expect(normalizeChatBackgroundPalette(palette)).toEqual(palette)
  })

  it('derives a light palette from a bright image and rejects malformed palettes', () => {
    const palette = deriveChatBackgroundPalette(new Uint8ClampedArray([
      246, 226, 235, 255,
      235, 222, 245, 255,
    ]))
    expect(palette.mode).toBe('light')
    expect(normalizeChatBackgroundPalette({ ...palette, primary: 'url(javascript:bad)' })).toBeNull()
  })

  it('shows the image in fresh chats and requires opt-in after the first message', () => {
    expect(shouldShowChatBackground({ threadView: 'chat', hasBackground: true, messageCount: 0, showInRegularChats: false })).toBe(true)
    expect(shouldShowChatBackground({ threadView: 'chat', hasBackground: true, messageCount: 1, showInRegularChats: false })).toBe(false)
    expect(shouldShowChatBackground({ threadView: 'chat', hasBackground: true, messageCount: 1, showInRegularChats: true })).toBe(true)
    expect(shouldShowChatBackground({ threadView: 'md', hasBackground: true, messageCount: 0, showInRegularChats: true })).toBe(false)
  })
})

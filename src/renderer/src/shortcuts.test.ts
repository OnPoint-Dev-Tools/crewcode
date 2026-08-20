import { beforeAll, describe, expect, it } from 'vitest'

import {
  matchesChord,
  keysFileToOverrides,
  overridesToKeysFile,
  effectiveChord,
  LOCAL_SHORTCUTS,
  SHORTCUTS,
} from './shortcuts'

// matchesChord branches on navigator.userAgent (Mac vs not). Pin it to a
// non-Mac UA so ⌘ resolves to ctrlKey deterministically across Node versions.
beforeAll(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'vitest-linux' },
    configurable: true,
  })
})

type KeyInit = Partial<Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>>
const ev = (init: KeyInit): KeyboardEvent =>
  ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: '', ...init } as KeyboardEvent)

describe('matchesChord', () => {
  it('matches a plain letter chord (⌘ → ctrl off-Mac)', () => {
    expect(matchesChord(ev({ ctrlKey: true, key: 'l' }), ['⌘', 'L'])).toBe(true)
    expect(matchesChord(ev({ ctrlKey: true, key: 'L' }), ['⌘', 'L'])).toBe(true)
  })

  it('matches a shifted symbol when the browser reports the shifted glyph', () => {
    // The next-tab bug: Ctrl+Shift+] reports key "}" — must still match "]".
    expect(matchesChord(ev({ ctrlKey: true, shiftKey: true, key: '}' }), ['⌘', '⇧', ']'])).toBe(true)
    expect(matchesChord(ev({ ctrlKey: true, shiftKey: true, key: '{' }), ['⌘', '⇧', '['])).toBe(true)
  })

  it('still matches when the raw key equals the bound symbol', () => {
    expect(matchesChord(ev({ ctrlKey: true, shiftKey: true, key: ']' }), ['⌘', '⇧', ']'])).toBe(true)
  })

  it('accepts the Cmd word token like the ⌘ glyph', () => {
    expect(matchesChord(ev({ ctrlKey: true, key: 'k' }), ['Cmd', 'K'])).toBe(true)
  })

  it('rejects when modifiers differ', () => {
    expect(matchesChord(ev({ ctrlKey: true, key: 'l' }), ['⌘', '⇧', 'L'])).toBe(false)
    expect(matchesChord(ev({ key: 'l' }), ['⌘', 'L'])).toBe(false)
  })

  it('normalizes glyph aliases for Enter/Tab', () => {
    expect(matchesChord(ev({ metaKey: false, ctrlKey: true, key: 'Enter' }), ['⌘', '↵'])).toBe(true)
    expect(matchesChord(ev({ ctrlKey: true, key: 'Tab' }), ['⌃', '⇥'])).toBe(true)
  })
})

describe('shortcut registry', () => {
  it('exposes the prompt picker as a rebindable Ctrl/Cmd+P action', () => {
    const promptPicker = SHORTCUTS.find(s => s.id === 'prompt-picker')
    expect(promptPicker).toMatchObject({ group: 'navigation', act: 'Open prompt picker', keys: ['⌘', 'P'] })
  })

  it('uses workspace-local tab cycling bindings and omits recent-chat navigation', () => {
    expect(SHORTCUTS.find(s => s.id === 'next-tab')?.keys).toEqual(['⌃', '⇥'])
    expect(SHORTCUTS.find(s => s.id === 'prev-tab')?.keys).toEqual(['⌃', '⇧', '⇥'])
    expect(SHORTCUTS.some(s => (s.id as string) === 'next-chat' || (s.id as string) === 'prev-chat')).toBe(false)
  })

  it('exposes rebindable component-local voice start and end actions', () => {
    expect(SHORTCUTS.find(s => s.id === 'start-voice')).toMatchObject({
      group: 'composer',
      act: 'Start voice orb microphone',
      keys: ['⌃', '⌥', 'V'],
    })
    expect(SHORTCUTS.find(s => s.id === 'end-voice')).toMatchObject({
      group: 'composer',
      act: 'End voice orb microphone',
      keys: ['⌃', '⌥', 'X'],
    })
    expect(LOCAL_SHORTCUTS.has('start-voice')).toBe(true)
    expect(LOCAL_SHORTCUTS.has('end-voice')).toBe(true)
  })
})

describe('keys.json converters', () => {
  it('round-trips overrides through the file format', () => {
    const overrides = keysFileToOverrides({ 'next-tab': ['Ctrl', 'Shift', ']'], 'switch-model': ['Cmd', 'M'] })
    // Stored under group → label internally.
    expect(effectiveChord('next-tab', overrides)).toEqual(['Ctrl', 'Shift', ']'])
    expect(effectiveChord('switch-model', overrides)).toEqual(['Cmd', 'M'])

    const file = overridesToKeysFile(overrides)
    expect(file['next-tab']).toEqual(['Ctrl', 'Shift', ']'])
    expect(file['switch-model']).toEqual(['Cmd', 'M'])
  })

  it('ignores comments and unknown action ids in the file', () => {
    const overrides = keysFileToOverrides({ _comment: 'hi', 'not-an-action': ['X'], 'next-tab': ['Ctrl', 'N'] })
    expect(overridesToKeysFile(overrides)).toEqual({ 'next-tab': ['Ctrl', 'N'] })
  })

  it('drops malformed entries (non-string-array values)', () => {
    const overrides = keysFileToOverrides({ 'next-tab': 'Ctrl+N' as unknown as string[] })
    expect(overridesToKeysFile(overrides)).toEqual({})
  })
})

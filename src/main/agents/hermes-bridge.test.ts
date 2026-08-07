import { describe, expect, it } from 'vitest'

import { hermesThinkingDelta } from './hermes-bridge'

describe('hermes thinking deltas', () => {
  it('preserves short ellipsis-ended provider thoughts', () => {
    expect(hermesThinkingDelta('', '( ˘⌣˘)♡ brainstorming...')).toEqual({
      delta: '( ˘⌣˘)♡ brainstorming...',
      next: '( ˘⌣˘)♡ brainstorming...',
    })
  })
  it('passes through plain incremental chunks', () => {
    expect(hermesThinkingDelta('abc', 'def')).toEqual({ delta: 'def', next: 'abcdef' })
  })

  it('drops an exact final cumulative duplicate', () => {
    expect(hermesThinkingDelta('thinking text', 'thinking text')).toEqual({ delta: '', next: 'thinking text' })
  })

  it('keeps only the suffix from a cumulative replay', () => {
    expect(hermesThinkingDelta('thinking', 'thinking more')).toEqual({ delta: ' more', next: 'thinking more' })
  })

  it('drops short duplicate tails emitted after streaming', () => {
    expect(hermesThinkingDelta('abc final', 'final')).toEqual({ delta: '', next: 'abc final' })
  })
})

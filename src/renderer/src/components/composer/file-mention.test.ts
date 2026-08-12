import { describe, expect, it } from 'vitest'

import { findFileMentionAt, insertFileMention } from './file-mention'

describe('file mentions', () => {
  it('finds a mention at the start or after punctuation', () => {
    expect(findFileMentionAt('@src/mai', 8)).toEqual({ start: 0, query: 'src/mai' })
    expect(findFileMentionAt('review (@auth', 13)).toEqual({ start: 8, query: 'auth' })
  })

  it('does not treat email-like text or completed tokens as mentions', () => {
    expect(findFileMentionAt('dev@example', 11)).toBeNull()
    expect(findFileMentionAt('@src/main.ts then', 17)).toBeNull()
  })

  it('replaces the active query and preserves text after the caret', () => {
    expect(insertFileMention('check @src/ma please', { start: 6, query: 'src/ma' }, 13, 'src/main.ts'))
      .toEqual({ value: 'check @src/main.ts  please', caret: 19 })
  })
})

import { describe, expect, it } from 'vitest'
import { insertDictationText } from './composer-dictation-text'

describe('insertDictationText', () => {
  it('inserts into an empty composer', () => {
    expect(insertDictationText('', 0, 0, '  fix the tests  ')).toEqual({
      value: 'fix the tests',
      caret: 13,
    })
  })

  it('preserves readable spacing at the caret', () => {
    expect(insertDictationText('Please now', 6, 6, 'fix this')).toEqual({
      value: 'Please fix this now',
      caret: 15,
    })
  })

  it('replaces a selection without auto-submitting anything', () => {
    expect(insertDictationText('old request', 0, 3, 'new')).toEqual({
      value: 'new request',
      caret: 3,
    })
  })
})

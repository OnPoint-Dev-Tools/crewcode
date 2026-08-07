import { describe, it, expect } from 'vitest'
import { completionText, stripReasoningBlocks } from './completion-text'

describe('stripReasoningBlocks', () => {
  it('removes a complete think block and keeps the code after it', () => {
    expect(stripReasoningBlocks('<think>the user wants a loop</think>\nfor (const x of xs) {')).toBe('for (const x of xs) {')
  })

  it('handles <thinking> and <reasoning> variants and attributes', () => {
    expect(stripReasoningBlocks('<thinking>a</thinking>x')).toBe('x')
    expect(stripReasoningBlocks('<reasoning>a</reasoning>x')).toBe('x')
    expect(stripReasoningBlocks('<think signature="abc">a</think>x')).toBe('x')
  })

  it('returns null when the response is nothing but an unterminated think block', () => {
    expect(stripReasoningBlocks('<think>still reasoning about the cursor')).toBeNull()
  })

  it('returns null when only reasoning remains', () => {
    expect(stripReasoningBlocks('<think>done</think>   ')).toBeNull()
  })

  it('leaves ordinary code untouched', () => {
    expect(stripReasoningBlocks('const a = b < c && d > e')).toBe('const a = b < c && d > e')
  })
})

describe('completionText', () => {
  it('strips reasoning before unwrapping the fence', () => {
    expect(completionText('<think>hmm</think>\n```ts\nconst a = 1\n```')).toBe('const a = 1')
  })

  it('unwraps a plain fence', () => {
    expect(completionText('```\nconst a = 1\n```')).toBe('const a = 1')
  })

  it('normalizes CRLF and trims trailing whitespace', () => {
    expect(completionText('const a = 1\r\nconst b = 2  \n\n')).toBe('const a = 1\nconst b = 2')
  })

  it('returns empty string for pure reasoning output', () => {
    expect(completionText('<think>no useful completion</think>')).toBe('')
  })
})

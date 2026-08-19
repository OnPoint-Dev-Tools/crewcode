import { describe, expect, it } from 'vitest'

import { isNearBottom } from './useStickToBottom'

/** Minimal stand-in for the scroll geometry the hook reads off a thread element. */
function el(scrollHeight: number, scrollTop: number, clientHeight: number): HTMLElement {
  return { scrollHeight, scrollTop, clientHeight } as HTMLElement
}

describe('isNearBottom', () => {
  it('is pinned when scrolled exactly to the bottom', () => {
    expect(isNearBottom(el(1000, 800, 200))).toBe(true)
  })

  it('stays pinned inside the threshold so a streaming row does not unpin the thread', () => {
    // 71px from the bottom — one appended row must not stop the follow.
    expect(isNearBottom(el(1000, 729, 200))).toBe(true)
  })

  it('unpins once the operator scrolls past the threshold to read history', () => {
    expect(isNearBottom(el(1000, 700, 200))).toBe(false)
  })

  it('treats a thread shorter than its viewport as pinned', () => {
    expect(isNearBottom(el(120, 0, 400))).toBe(true)
  })

  it('honors a caller-supplied threshold', () => {
    expect(isNearBottom(el(1000, 700, 200), 100)).toBe(true)
    expect(isNearBottom(el(1000, 700, 200), 10)).toBe(false)
  })
})

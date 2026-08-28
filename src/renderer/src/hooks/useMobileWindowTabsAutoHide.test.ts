import { describe, expect, it } from 'vitest'

import {
  initialMobileTabScrollState,
  initialMobileTabSwipeState,
  updateMobileTabScroll,
  updateMobileTabSwipe,
} from './useMobileWindowTabsAutoHide'

describe('mobile WindowTabs scroll decisions', () => {
  it('ignores small downward movement and hides after deliberate travel', () => {
    let state = initialMobileTabScrollState(0)
    let update = updateMobileTabScroll(state, 10)
    state = update.state
    expect(update.visibility).toBeNull()

    update = updateMobileTabScroll(state, 25)
    state = update.state
    expect(update.visibility).toBeNull()

    update = updateMobileTabScroll(state, 38)
    expect(update.visibility).toBe('hide')
  })

  it('reveals quickly when scrolling upward', () => {
    let state = initialMobileTabScrollState(120)
    let update = updateMobileTabScroll(state, 114)
    state = update.state
    expect(update.visibility).toBeNull()

    update = updateMobileTabScroll(state, 107)
    expect(update.visibility).toBe('show')
  })

  it('resets travel when direction changes to prevent jitter', () => {
    let state = initialMobileTabScrollState(80)
    state = updateMobileTabScroll(state, 88).state
    state = updateMobileTabScroll(state, 94).state
    const update = updateMobileTabScroll(state, 90)
    expect(update.state.direction).toBe('up')
    expect(update.state.travel).toBe(4)
    expect(update.visibility).toBeNull()
  })

  it('always reveals when returning to the top', () => {
    const update = updateMobileTabScroll(initialMobileTabScrollState(50), 3)
    expect(update.visibility).toBe('show')
    expect(update.state.travel).toBe(0)
  })

  it('reveals from a downward finger gesture even if scroll events are missed', () => {
    let state = initialMobileTabSwipeState(100, 100)
    let update = updateMobileTabSwipe(state, 100, 107)
    state = update.state
    expect(update.visibility).toBeNull()
    update = updateMobileTabSwipe(state, 100, 112)
    expect(update.visibility).toBe('show')
  })

  it('locks onto slow vertical swipes using total gesture travel', () => {
    let state = initialMobileTabSwipeState(100, 100)
    for (const y of [102, 104, 106, 108, 111]) state = updateMobileTabSwipe(state, 100, y).state
    const update = updateMobileTabSwipe(state, 100, 114)
    expect(update.state.axis).toBe('vertical')
    expect(update.visibility).toBe('show')
  })

  it('hides from an upward finger gesture and ignores horizontal tab-like swipes', () => {
    let state = initialMobileTabSwipeState(100, 100)
    let update = updateMobileTabSwipe(state, 100, 82)
    state = update.state
    expect(update.visibility).toBeNull()
    update = updateMobileTabSwipe(state, 100, 70)
    expect(update.visibility).toBe('hide')

    state = initialMobileTabSwipeState(100, 100)
    update = updateMobileTabSwipe(state, 75, 96)
    state = update.state
    update = updateMobileTabSwipe(state, 50, 88)
    expect(update.state.axis).toBe('horizontal')
    expect(update.visibility).toBeNull()
  })
})

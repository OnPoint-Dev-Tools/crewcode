import { describe, expect, it } from 'vitest'

import { terminalColumnIsVisible } from './terminal-column-visibility'

describe('terminal column visibility', () => {
  it('lets the global Tweaks value hide a populated terminal column', () => {
    expect(terminalColumnIsVisible(2, false, false)).toBe(false)
  })

  it('lets the global Tweaks value reveal existing terminal panes', () => {
    expect(terminalColumnIsVisible(2, true, true)).toBe(true)
  })

  it('does not render an empty terminal column', () => {
    expect(terminalColumnIsVisible(0, true, false)).toBe(false)
  })
})

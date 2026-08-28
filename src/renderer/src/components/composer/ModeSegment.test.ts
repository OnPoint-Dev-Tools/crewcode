import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { ModeSegment } from './ModeSegment'

describe('ModeSegment locking', () => {
  it('disables the execution-mode button while a CrewCoder profile owns behavior', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(ModeSegment, {
        mode: 'Build',
        onChange: vi.fn(),
        disabled: true,
        disabledReason: 'CrewCoder profile active',
      }))
    })

    const button = renderer.root.findByType('button')
    expect(button.props.disabled).toBe(true)
    expect(button.props.title).toBe('CrewCoder profile active')
    act(() => renderer.unmount())
  })
})

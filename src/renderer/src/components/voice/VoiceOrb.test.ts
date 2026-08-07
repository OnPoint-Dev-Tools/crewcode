import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { VoiceControlSurface } from '../../../../shared/voice-types'
import { VoiceOrb } from './VoiceOrb'

function control(stop = vi.fn()): VoiceControlSurface {
  return {
    phase: 'waiting',
    status: 'Running tools',
    active: true,
    disabled: false,
    confirmationText: '',
    start: vi.fn(),
    stop,
    setConfirmationText: vi.fn(),
    confirmPrompt: vi.fn(),
    cancelPrompt: vi.fn(),
  }
}

describe('VoiceOrb', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('hides and restores the overlay without stopping the active voice session', () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    const stop = vi.fn()
    let renderer: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(VoiceOrb, {
        control: control(stop),
        placement: 'header',
      }))
    })

    act(() => {
      renderer!.root.findByProps({ className: 'voice-overlay-close' }).props.onClick()
    })

    expect(stop).not.toHaveBeenCalled()
    expect(renderer!.root.findByProps({ className: 'voice-orb-trigger voice-orb-restore' })).toBeTruthy()

    act(() => {
      renderer!.root.findByProps({ className: 'voice-orb-trigger voice-orb-restore' }).props.onClick()
    })
    expect(renderer!.root.findByProps({ className: 'voice-orb-overlay' })).toBeTruthy()
  })
})

import { describe, expect, it } from 'vitest'

import {
  LOCAL_VOICE_SPEED_DEFAULT,
  normalizeLocalVoiceSpeed,
} from './voice-types'

describe('normalizeLocalVoiceSpeed', () => {
  it('defaults malformed values and clamps persisted speed to Kokoro limits', () => {
    expect(normalizeLocalVoiceSpeed(undefined)).toBe(LOCAL_VOICE_SPEED_DEFAULT)
    expect(normalizeLocalVoiceSpeed(Number.NaN)).toBe(LOCAL_VOICE_SPEED_DEFAULT)
    expect(normalizeLocalVoiceSpeed(0.1)).toBe(0.5)
    expect(normalizeLocalVoiceSpeed(3)).toBe(2)
    expect(normalizeLocalVoiceSpeed(1.349)).toBe(1.35)
  })
})

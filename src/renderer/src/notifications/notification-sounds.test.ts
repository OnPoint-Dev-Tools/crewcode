import { describe, expect, it } from 'vitest'
import {
  NOTIFICATION_SOUND_IDS,
  normalizeNotificationSound,
  usesNativeNotificationSound,
} from './notification-sounds'

describe('notification sounds', () => {
  it('keeps the curated sound list stable', () => {
    expect(NOTIFICATION_SOUND_IDS).toEqual(['system', 'bell', 'ding', 'knock', 'none'])
  })

  it('falls back to the platform sound for missing or invalid persisted values', () => {
    expect(normalizeNotificationSound(undefined)).toBe('system')
    expect(normalizeNotificationSound('unknown')).toBe('system')
  })

  it('uses native audio only for the system option', () => {
    expect(usesNativeNotificationSound('system')).toBe(true)
    expect(usesNativeNotificationSound('bell')).toBe(false)
    expect(usesNativeNotificationSound('none')).toBe(false)
  })
})

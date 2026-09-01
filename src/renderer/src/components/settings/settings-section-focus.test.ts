import { afterEach, describe, expect, it } from 'vitest'
import {
  requestSettingsSection,
  takePendingSettingsSection,
} from './settings-section-focus'

afterEach(() => {
  takePendingSettingsSection()
})

describe('settings section focus', () => {
  it('stores a pending section so Settings can scroll after it mounts', () => {
    requestSettingsSection('updates')
    expect(takePendingSettingsSection()).toBe('updates')
    expect(takePendingSettingsSection()).toBeNull()
  })

  it('ignores blank ids', () => {
    requestSettingsSection('   ')
    expect(takePendingSettingsSection()).toBeNull()
  })
})

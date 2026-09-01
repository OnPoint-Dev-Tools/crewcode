import { describe, expect, it } from 'vitest'
import { updaterNoticeForEvent } from './updater-notices'

describe('updaterNoticeForEvent', () => {
  it('announces an available version without requiring Settings to be open', () => {
    expect(updaterNoticeForEvent({ type: 'available', version: '0.2.4' })).toEqual({
      key: 'available:0.2.4',
      type: 'info',
      message: 'CrewCode 0.2.4 is available',
    })
  })

  it('announces a downloaded update that still needs a restart', () => {
    expect(updaterNoticeForEvent({ type: 'downloaded', version: '0.2.4' })).toEqual({
      key: 'downloaded:0.2.4',
      type: 'success',
      message: 'CrewCode 0.2.4 is ready · restart to install',
    })
  })

  it('keeps a usable message when the version is missing', () => {
    expect(updaterNoticeForEvent({ type: 'available' })?.message).toBe('A CrewCode update is available')
    expect(updaterNoticeForEvent({ type: 'downloaded' })?.message).toBe(
      'A CrewCode update is ready · restart to install',
    )
  })

  it('ignores check/progress/error noise from the launch auto-check', () => {
    expect(updaterNoticeForEvent({ type: 'checking' })).toBeNull()
    expect(updaterNoticeForEvent({ type: 'not-available', version: '0.2.3' })).toBeNull()
    expect(updaterNoticeForEvent({ type: 'progress', percent: 40 })).toBeNull()
    expect(updaterNoticeForEvent({ type: 'error', message: 'network' })).toBeNull()
    expect(updaterNoticeForEvent({ type: 'unconfigured', message: 'dev build' })).toBeNull()
  })
})

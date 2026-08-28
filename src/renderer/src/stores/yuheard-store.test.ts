/**
 * Tests for the YuHeard renderer store.
 *
 * Mocks the notification sound and the IPC bridge; verifies that
 * `complete` reports play sound + fire OS notify, that `running` reports
 * are silent, and that the dedupe window prevents double-firing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// hoisted() is the supported way to share mutable mock state between the
// top-level `vi.mock` factories (which are hoisted above imports) and
// the test bodies that read/reset the mocks.
const { playSound, notify, getSettings } = vi.hoisted(() => ({
  playSound: vi.fn(),
  notify: vi.fn(),
  getSettings: vi.fn(() => ({
    yuheardEnabled: true,
    nativeNotifications: true,
  })),
}))

vi.mock('../notifications/notification-sounds', () => ({
  playNotificationSound: playSound,
}))

vi.mock('../hooks/useSettings', () => ({
  getCurrentSettings: getSettings,
}))

import { useYuHeardStore } from './yuheard-store'

function installDom({ hasFocus = false, focusedPaneId }: { hasFocus?: boolean; focusedPaneId?: string } = {}) {
  class MockElement {
    constructor(private readonly paneId?: string) {}
    closest(selector: string) {
      if (selector !== '[data-yuheard-pane-id]' || !this.paneId) return null
      return {
        getAttribute: (name: string) => name === 'data-yuheard-pane-id' ? this.paneId! : null,
      }
    }
  }
  vi.stubGlobal('window', {
    electronAPI: { notify },
  })
  vi.stubGlobal('Element', MockElement)
  vi.stubGlobal('document', {
    hasFocus: () => hasFocus,
    activeElement: focusedPaneId ? new MockElement(focusedPaneId) : null,
  })
}

beforeEach(() => {
  playSound.mockReset()
  notify.mockReset()
  // Reset the store between tests.
  useYuHeardStore.setState({ stateByPane: {}, lastNotifiedAt: {} })
  installDom()
})

describe('useYuHeardStore.applyReport', () => {
  it('does not play sound or notify on a running report', () => {
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'running', message: null, source: 'cli', at: 1 })
    expect(playSound).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('records the report in stateByPane', () => {
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'running', message: 'hi', source: 'cli', at: 1 })
    expect(useYuHeardStore.getState().stateByPane['pn-1']).toEqual({
      state: 'running', message: 'hi', source: 'cli', at: 1,
    })
  })

  it('plays the knock sound and fires an OS notify on a complete report', () => {
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'complete', message: 'all done', source: 'claude-hook', at: 1 })
    expect(playSound).toHaveBeenCalledWith('knock')
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Terminal agent finished',
      body: 'all done',
      scopeId: 'pane:pn-1',
      silent: true,
    }))
  })

  it('plays knock but skips the OS notify when the window is focused', () => {
    installDom({ hasFocus: true })
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'complete', message: null, source: 'claude-hook', at: 1 })
    expect(playSound).toHaveBeenCalledWith('knock')
    expect(notify).not.toHaveBeenCalled()
  })

  it('suppresses every alert when the exact completing terminal has keyboard focus', () => {
    installDom({ hasFocus: true, focusedPaneId: 'pn-1' })
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'complete', message: null, source: 'claude-hook', at: 1 })
    expect(playSound).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(useYuHeardStore.getState().lastNotifiedAt['pn-1']).toBeGreaterThan(0)
  })

  it('still alerts when a different terminal has keyboard focus', () => {
    installDom({ hasFocus: true, focusedPaneId: 'pn-2' })
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'complete', message: null, source: 'claude-hook', at: 1 })
    expect(playSound).toHaveBeenCalledWith('knock')
    expect(notify).not.toHaveBeenCalled()
  })

  it('alerts when the window is unfocused even if xterm remains the active DOM element', () => {
    installDom({ hasFocus: false, focusedPaneId: 'pn-1' })
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'complete', message: null, source: 'claude-hook', at: 1 })
    expect(playSound).toHaveBeenCalledWith('knock')
    expect(notify).toHaveBeenCalled()
  })

  it('plays knock but skips the OS notify when nativeNotifications is off', () => {
    getSettings.mockReturnValueOnce({ yuheardEnabled: true, nativeNotifications: false })
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'complete', message: null, source: 'cli', at: 1 })
    expect(playSound).toHaveBeenCalledWith('knock')
    expect(notify).not.toHaveBeenCalled()
  })

  it('is a no-op when yuheardEnabled is off', () => {
    getSettings.mockReturnValueOnce({ yuheardEnabled: false, nativeNotifications: true })
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'complete', message: null, source: 'cli', at: 1 })
    expect(playSound).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('ignores leftover bridge-sourced completes so solo chat is not double-notified', () => {
    useYuHeardStore.getState().applyReport({ paneId: 'chat:tab-1', state: 'complete', message: 'hi', source: 'bridge', at: 1 })
    expect(playSound).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('dedupes two complete reports for the same pane within 500ms', () => {
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'complete', message: 'first', source: 'cli', at: 1 })
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'complete', message: 'second', source: 'pty-idle', at: 2 })
    expect(playSound).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: 'first' }))
  })

  it('fires for distinct panes independently', () => {
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'complete', message: 'a', source: 'cli', at: 1 })
    useYuHeardStore.getState().applyReport({ paneId: 'pn-2', state: 'complete', message: 'b', source: 'cli', at: 2 })
    expect(playSound).toHaveBeenCalledTimes(2)
    expect(notify).toHaveBeenCalledTimes(2)
  })
})

describe('useYuHeardStore.applyComplete', () => {
  it('is a thin wrapper around applyReport with state=complete', () => {
    useYuHeardStore.getState().applyComplete('pn-x', 'preview text', 'pty')
    expect(playSound).toHaveBeenCalledWith('knock')
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      body: 'preview text',
      scopeId: 'pane:pn-x',
    }))
  })

  it('defaults to source=bridge and no message', () => {
    useYuHeardStore.getState().applyComplete('pn-y')
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Terminal agent finished',
      body: 'A terminal agent finished a turn.',
      scopeId: 'pane:pn-y',
    }))
  })
})

describe('useYuHeardStore.clearPane', () => {
  it('removes both the state and the dedupe record', () => {
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'complete', message: null, source: 'cli', at: 1 })
    useYuHeardStore.getState().clearPane('pn-1')
    expect(useYuHeardStore.getState().stateByPane['pn-1']).toBeUndefined()
    expect(useYuHeardStore.getState().lastNotifiedAt['pn-1']).toBeUndefined()
  })

  it('allows a fresh alert to fire after the pane is cleared', () => {
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'complete', message: null, source: 'cli', at: 1 })
    useYuHeardStore.getState().clearPane('pn-1')
    useYuHeardStore.getState().applyReport({ paneId: 'pn-1', state: 'complete', message: null, source: 'cli', at: 2 })
    expect(playSound).toHaveBeenCalledTimes(2)
  })
})

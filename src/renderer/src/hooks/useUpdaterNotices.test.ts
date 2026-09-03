import { createElement, useEffect } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdaterEvent } from '../../../shared/updater-types'
import { NotificationsProvider, useNotifications } from './useNotifications'
import { SettingsProvider } from './useSettings'

const updaterConfigure = vi.fn(async () => ({ ok: true }))
const listeners: Array<(event: UpdaterEvent) => void> = []

vi.mock('../runtime/crewcode-client', () => ({
  getCrewCodeRuntime: () => ({
    kind: 'electron',
    client: {
      updaterConfigure,
      onUpdaterEvent: (cb: (event: UpdaterEvent) => void) => {
        listeners.push(cb)
        return () => {
          const index = listeners.indexOf(cb)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
    },
  }),
}))

import { useUpdaterNotices } from './useUpdaterNotices'

function fire(event: UpdaterEvent): void {
  act(() => {
    for (const listener of listeners) listener(event)
  })
}

function Probe({ onOpen }: { onOpen: () => void }): null {
  useUpdaterNotices(onOpen)
  return null
}

function Notices({ onOpen, onNotices }: { onOpen: () => void; onNotices: (messages: string[]) => void }) {
  const { notices } = useNotifications()
  useEffect(() => { onNotices(notices.map(notice => notice.message)) }, [notices, onNotices])
  return createElement(Probe, { onOpen })
}

describe('useUpdaterNotices', () => {
  beforeEach(() => {
    listeners.length = 0
    updaterConfigure.mockClear()
    vi.stubGlobal('window', {
      electronAPI: undefined,
      setTimeout,
      clearTimeout,
    })
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    })
  })

  afterEach(() => {
    listeners.length = 0
    vi.unstubAllGlobals()
  })

  it('pushes updater config on mount and shows a persistent available notice', () => {
    const onOpen = vi.fn()
    let messages: string[] = []
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(
        SettingsProvider,
        null,
        createElement(
          NotificationsProvider,
          null,
          createElement(Notices, { onOpen, onNotices: next => { messages = next } }),
        ),
      ))
    })

    expect(updaterConfigure).toHaveBeenCalled()
    fire({ type: 'checking' })
    expect(messages).toEqual([])
    fire({ type: 'available', version: '0.3.0' })
    expect(messages).toEqual(['CrewCode 0.3.0 is available'])
    fire({ type: 'available', version: '0.3.0' })
    expect(messages).toEqual(['CrewCode 0.3.0 is available'])
    fire({ type: 'downloaded', version: '0.3.0' })
    expect(messages).toEqual(['CrewCode 0.3.0 is ready · restart to install'])
    renderer.unmount()
  })
})

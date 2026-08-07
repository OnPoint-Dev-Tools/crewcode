import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { act, renderHook } from './hook-test-host'
import { useTerminalSessions } from './useTerminalSessions'

const STORAGE_KEY = 'crewcode:terminalSessions:v1'

function installStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  const storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value) }),
    removeItem: vi.fn((key: string) => { data.delete(key) }),
    clear: vi.fn(() => { data.clear() }),
  }
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', { electronAPI: { ptyKill: vi.fn(), ptyWrite: vi.fn() } })
  return { data, storage }
}

function persistedTerminalSession(paneCount = 2) {
  return JSON.stringify({
    'ws1-terminal': {
      panes: Array.from({ length: paneCount }, (_, i) => ({
        type:  'shell',
        wsId:  'ws1',
        title: `shell ${i + 1}`,
        sub:   '/repo',
        cwd:   '/repo',
        shell: 'auto',
      })),
      columns:    [Array.from({ length: paneCount }, (_, i) => i)],
      colWeights: [1],
      rowWeights: [Array.from({ length: paneCount }, () => 1)],
      split:      'right',
      width:      340,
      height:     320,
    },
  })
}

describe('useTerminalSessions restore', () => {
  beforeEach(() => {
    installStorage({ [STORAGE_KEY]: persistedTerminalSession(2) })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not add an auto shell on top of restored terminal panes', () => {
    const hook = renderHook(() => useTerminalSessions(), undefined)

    act(() => {
      hook.result.current.restoreTab('ws1-terminal')
      hook.result.current.ensurePane('ws1-terminal', 'ws1', '/repo', 'auto')
    })

    expect(hook.result.current.getTabPanes('ws1-terminal')).toHaveLength(2)
    expect(hook.result.current.getTabLayout('ws1-terminal').columns.flat()).toHaveLength(2)

    hook.unmount()
  })

  it('is idempotent when restore is requested more than once', () => {
    const hook = renderHook(() => useTerminalSessions(), undefined)

    act(() => {
      hook.result.current.restoreTab('ws1-terminal')
      hook.result.current.restoreTab('ws1-terminal')
    })

    expect(hook.result.current.getTabPanes('ws1-terminal')).toHaveLength(2)

    hook.unmount()
  })

  it('can auto-open a fresh shell after the restored panes are closed', () => {
    const hook = renderHook(() => useTerminalSessions(), undefined)

    act(() => {
      hook.result.current.restoreTab('ws1-terminal')
    })

    const restoredPaneIds = hook.result.current.getTabPanes('ws1-terminal').map(p => p.paneId)
    act(() => {
      for (const paneId of restoredPaneIds) hook.result.current.close(paneId)
    })
    expect(hook.result.current.getTabPanes('ws1-terminal')).toHaveLength(0)

    act(() => {
      hook.result.current.ensurePane('ws1-terminal', 'ws1', '/repo', 'auto')
    })

    expect(hook.result.current.getTabPanes('ws1-terminal')).toHaveLength(1)

    hook.unmount()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { act, renderHook } from './hook-test-host'
import { useWorkspaceTabs } from './useWorkspaceTabs'
import type { RegisteredPluginTab } from '../../../shared/plugin-types'

const STORAGE_KEY = 'crewcode:workspaceTabs:v1'

function installStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed))
  const storage = {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value) }),
    removeItem: vi.fn((key: string) => { data.delete(key) }),
    clear: vi.fn(() => { data.clear() }),
  }
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  return { data, storage }
}

function pluginTab(partial: Partial<RegisteredPluginTab> = {}): RegisteredPluginTab {
  return {
    id: 'main',
    pluginId: 'dogfood',
    registrationId: 'dogfood:main',
    title: 'Dogfood Panel',
    entry: 'panel.html',
    singleton: true,
    ...partial,
  }
}

describe('useWorkspaceTabs plugin lifecycle', () => {
  beforeEach(() => {
    installStorage()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens, closes, and re-opens singleton plugin tabs without duplicates', () => {
    const hook = renderHook(useWorkspaceTabs, { activeWs: 'ws1', workspaceName: 'Workspace One' })
    const tab = pluginTab()

    act(() => {
      const first = hook.result.current.openPluginTab(tab, { source: 'command-palette' })
      const second = hook.result.current.openPluginTab(tab, { source: 'plugin-menu' })
      expect(second).toBe(first)
    })

    expect(hook.result.current.tabs.filter(t => t.kind === 'plugin' && t.pluginRegistrationId === tab.registrationId)).toHaveLength(1)

    const openedId = hook.result.current.tabs.find(t => t.kind === 'plugin')?.id
    expect(openedId).toBe('ws1-plugin-dogfood-main')

    act(() => {
      hook.result.current.closeTab(openedId ?? '')
    })
    expect(hook.result.current.tabs.some(t => t.id === openedId)).toBe(false)

    act(() => {
      hook.result.current.openPluginTab(tab, { source: 'command-palette' })
    })
    expect(hook.result.current.tabs.filter(t => t.kind === 'plugin' && t.pluginRegistrationId === tab.registrationId)).toHaveLength(1)

    hook.unmount()
  })

  it('persists a newly opened tab immediately, without waiting on the debounce', () => {
    vi.unstubAllGlobals()
    const { storage } = installStorage()
    const hook = renderHook(useWorkspaceTabs, { activeWs: 'ws1', workspaceName: 'Workspace One' })

    storage.setItem.mockClear()
    act(() => {
      hook.result.current.openPluginTab(pluginTab(), { source: 'command-palette' })
    })

    // Structural change (a tab was added) must hit storage synchronously — a
    // debounced write here let an abrupt quit orphan a fresh conversation's
    // messages, which the startup prune then wiped.
    const persisted = storage.setItem.mock.calls.find(([key]) => key === STORAGE_KEY)
    expect(persisted).toBeDefined()
    expect(persisted?.[1]).toContain('ws1-plugin-dogfood-main')

    hook.unmount()
  })

  it('resolves the remembered or default tab for local and remote workspace ids', () => {
    vi.unstubAllGlobals()
    installStorage({
      [STORAGE_KEY]: JSON.stringify({
        wsTabs: {
          local: [{ id: 'local-chat', kind: 'chat', label: 'Local', live: false }],
          remote: [
            { id: 'remote-chat', kind: 'chat', label: 'Remote', live: false },
            { id: 'remote-terminal', kind: 'terminal', label: 'Terminal', live: false },
          ],
        },
        activeByWs: { local: 'local-chat', remote: 'remote-terminal' },
        splitMap: {},
      }),
    })
    const hook = renderHook(useWorkspaceTabs, { activeWs: 'local', workspaceName: 'Local' })

    expect(hook.result.current.getActiveTabIdForWorkspace('remote')).toBe('remote-terminal')
    expect(hook.result.current.getActiveTabIdForWorkspace('new-remote')).toBe('new-remote-chat')

    hook.unmount()
  })

  it('allows multiple non-singleton plugin tab instances', () => {
    const hook = renderHook(useWorkspaceTabs, { activeWs: 'ws1', workspaceName: 'Workspace One' })
    const tab = pluginTab({ singleton: false })

    act(() => {
      hook.result.current.openPluginTab(tab, { source: 'command-palette' })
      hook.result.current.openPluginTab(tab, { source: 'plugin-menu' })
    })

    const opened = hook.result.current.tabs.filter(t => t.kind === 'plugin' && t.pluginRegistrationId === tab.registrationId)
    expect(opened).toHaveLength(2)
    expect(new Set(opened.map(t => t.id)).size).toBe(2)

    hook.unmount()
  })

  it('restores singleton and non-singleton plugin tabs from persisted workspace state', () => {
    vi.unstubAllGlobals()
    installStorage({
      [STORAGE_KEY]: JSON.stringify({
        wsTabs: {
          ws1: [
            { id: 'ws1-chat', kind: 'chat', label: 'Workspace One', live: false },
            { id: 'ws1-plugin-dogfood-main', kind: 'plugin', label: 'Dogfood Panel', live: false, pluginId: 'dogfood', pluginTabId: 'main', pluginRegistrationId: 'dogfood:main', pluginEntry: 'panel.html', pluginSingleton: true },
            { id: 'ws1-plugin-a', kind: 'plugin', label: 'Dogfood Detail', live: false, pluginId: 'dogfood', pluginTabId: 'detail', pluginRegistrationId: 'dogfood:detail', pluginEntry: 'detail.html', pluginSingleton: false },
            { id: 'ws1-plugin-b', kind: 'plugin', label: 'Dogfood Detail', live: false, pluginId: 'dogfood', pluginTabId: 'detail', pluginRegistrationId: 'dogfood:detail', pluginEntry: 'detail.html', pluginSingleton: false },
          ],
        },
        activeByWs: { ws1: 'ws1-plugin-dogfood-main' },
        splitMap: {},
      }),
    })

    const hook = renderHook(useWorkspaceTabs, { activeWs: 'ws1', workspaceName: 'Workspace One' })

    expect(hook.result.current.activeTabId).toBe('ws1-plugin-dogfood-main')
    expect(hook.result.current.tabs.filter(t => t.kind === 'plugin' && t.pluginRegistrationId === 'dogfood:main')).toHaveLength(1)
    expect(hook.result.current.tabs.filter(t => t.kind === 'plugin' && t.pluginRegistrationId === 'dogfood:detail')).toHaveLength(2)

    hook.unmount()
  })

  it('drops duplicated persisted singleton plugin tabs', () => {
    vi.unstubAllGlobals()
    installStorage({
      [STORAGE_KEY]: JSON.stringify({
        wsTabs: {
          ws1: [
            { id: 'ws1-plugin-dogfood-main', kind: 'plugin', label: 'Dogfood Panel', live: false, pluginId: 'dogfood', pluginTabId: 'main', pluginRegistrationId: 'dogfood:main', pluginEntry: 'panel.html', pluginSingleton: true },
            { id: 'ws1-plugin-dogfood-main-copy', kind: 'plugin', label: 'Dogfood Panel', live: false, pluginId: 'dogfood', pluginTabId: 'main', pluginRegistrationId: 'dogfood:main', pluginEntry: 'panel.html', pluginSingleton: true },
          ],
        },
        activeByWs: { ws1: 'ws1-plugin-dogfood-main' },
        splitMap: {},
      }),
    })

    const hook = renderHook(useWorkspaceTabs, { activeWs: 'ws1', workspaceName: 'Workspace One' })

    expect(hook.result.current.tabs.filter(t => t.kind === 'plugin' && t.pluginRegistrationId === 'dogfood:main')).toHaveLength(1)

    hook.unmount()
  })
})

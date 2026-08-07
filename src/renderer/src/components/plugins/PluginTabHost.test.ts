import { createElement } from 'react'
import TestRenderer from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { act, flush } from '../../hooks/hook-test-host'
import { PluginTabHost } from './PluginTabHost'
import type { Tab, Workspace } from '../../types'

function pluginTab(): Tab {
  return {
    id: 'ws1-plugin-dogfood-main',
    kind: 'plugin',
    label: 'Dogfood Panel',
    live: false,
    pluginId: 'dogfood',
    pluginTabId: 'main',
    pluginRegistrationId: 'dogfood:main',
    pluginEntry: 'panel.html',
    pluginSingleton: true,
  }
}

function remoteWorkspace(): Workspace {
  return {
    id: 'remote-ws',
    name: 'remote ws',
    path: 'ssh://dev@box/home/dev/repo',
    branch: null,
    dirty: 0,
    status: 'ready',
    kind: 'remote',
    pinned: false,
    folder: null,
    remote: null,
    agents: [],
    updated: '',
    worktrees: [],
    github: null,
  }
}

function installPluginHostWindow() {
  const pluginsResolveTab = vi.fn(async () => ({
    ok: true as const,
    pluginId: 'dogfood',
    registrationId: 'dogfood:main',
    title: 'Dogfood Panel',
    url: 'crewcode-plugin://dogfood/panel.html',
    permissions: [],
  }))
  vi.stubGlobal('window', {
    electronAPI: {
      pluginsResolveTab,
      onPluginsChanged: vi.fn(() => undefined),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
  return { pluginsResolveTab }
}

describe('PluginTabHost lifecycle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('re-resolves the plugin panel when the user clicks reload', async () => {
    const { pluginsResolveTab } = installPluginHostWindow()

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(PluginTabHost, { tab: pluginTab(), workspace: null }))
    })
    await flush()

    expect(pluginsResolveTab).toHaveBeenCalledTimes(1)

    const reload = renderer.root.findByProps({ children: 'reload' })
    await act(async () => {
      reload.props.onClick()
    })
    await flush()

    expect(pluginsResolveTab).toHaveBeenCalledTimes(2)
    act(() => { renderer.unmount() })
  })

  it('shows remote workspace limitations instead of failing silently', async () => {
    installPluginHostWindow()

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(PluginTabHost, { tab: pluginTab(), workspace: remoteWorkspace() }))
    })
    await flush()

    expect(renderer.root.findByProps({ children: 'remote workspace: plugin file capabilities are local-only in v0 until safe remote routes exist.' })).toBeTruthy()
    act(() => { renderer.unmount() })
  })
})

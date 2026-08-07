import TestRenderer, { act } from 'react-test-renderer'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PluginGitCandidate, PluginRegistrySnapshot } from '../../../../shared/plugin-types'
import { PluginsPage } from './PluginsPage'

function emptyRegistry(): PluginRegistrySnapshot {
  const contributions = {
    commands: [],
    tabs: [],
    sidebarPanels: [],
    statusItems: [],
    editorActions: [],
    chatActions: [],
    chatHeaderItems: [],
    mcpServers: [],
    agentProviders: [],
    gitLenses: [],
    missionWidgets: [],
    terminalWatchers: [],
    browserActions: [],
  }
  return {
    root: '/home/test/.crewcode/plugins',
    plugins: [],
    errors: [],
    declaredContributions: contributions,
    contributions,
  }
}

function nodeText(node: TestRenderer.ReactTestInstance): string {
  return node.children.filter(child => typeof child === 'string').join('')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PluginsPage Git installer', () => {
  it('reviews a repository before installing it unapproved', async () => {
    const registry = emptyRegistry()
    const candidate: PluginGitCandidate = {
      token: 'review-token',
      id: 'community-plugin',
      name: 'Community Plugin',
      version: '1.0.0',
      description: 'A shared CrewCode plugin.',
      repositoryUrl: 'https://github.com/example/community-plugin',
      revision: '1234567890abcdef',
      permissions: ['workspace:read'],
      mode: 'install',
      permissionsChanged: false,
      updateAvailable: true,
      fileCount: 4,
      totalBytes: 2048,
    }
    const pluginsInspectGit = vi.fn().mockResolvedValue({ ok: true, candidate })
    const pluginsInstallGit = vi.fn().mockResolvedValue({
      ok: true,
      pluginId: candidate.id,
      registry,
    })
    vi.stubGlobal('window', {
      electronAPI: {
        pluginsRefresh: vi.fn().mockResolvedValue(registry),
        pluginsList: vi.fn().mockResolvedValue(registry),
        pluginsAudit: vi.fn().mockResolvedValue([]),
        onPluginsChanged: vi.fn().mockReturnValue(() => {}),
        pluginsInspectGit,
        pluginsInstallGit,
      },
    })

    let renderer: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(
        createElement(PluginsPage, {
          workspaces: [],
          activeWorkspaceId: '',
          pluginWorkspaceEnabled: {},
          setSetting: vi.fn(),
        }),
      )
    })

    const installButton = renderer!.root.findAllByType('button').find(button => nodeText(button).includes('install plugin'))
    expect(installButton).toBeDefined()
    act(() => installButton!.props.onClick())

    const input = renderer!.root.findByType('input')
    act(() => input.props.onChange({ target: { value: candidate.repositoryUrl } }))
    const form = renderer!.root.findByType('form')
    await act(async () => {
      form.props.onSubmit({ preventDefault: vi.fn() })
    })

    expect(pluginsInspectGit).toHaveBeenCalledWith({ repositoryUrl: candidate.repositoryUrl })
    expect(JSON.stringify(renderer!.toJSON())).toContain('Community Plugin')
    expect(JSON.stringify(renderer!.toJSON())).toContain('read local workspace files')

    const confirmButton = renderer!.root.findAllByType('button').find(button => nodeText(button).includes('install unapproved'))
    expect(confirmButton).toBeDefined()
    await act(async () => {
      confirmButton!.props.onClick()
    })

    expect(pluginsInstallGit).toHaveBeenCalledWith(candidate.token)
    expect(JSON.stringify(renderer!.toJSON())).toContain('Review its permissions and approve it before use.')
  })
})

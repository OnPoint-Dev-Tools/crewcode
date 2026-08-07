import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { PLUGIN_PERMISSION_INFO } from '../shared/plugin-permissions'
import { CREWCODE_PLUGIN_API_VERSION, type InstalledPlugin } from '../shared/plugin-types'
import {
  invokePluginCapabilityWithPlugins,
  pluginAssetHeaders,
  pluginAssetMimeType,
  pluginPermissionFingerprint,
  resolvePluginAssetTarget,
  requiredPermissionForPluginContribution,
  requiredPermissionsForPluginAgentRuntime,
  validatePluginManifest,
} from './plugin-contract'

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `crewcode-${name}-`))
}

function plugin(partial: Partial<InstalledPlugin> = {}): InstalledPlugin {
  const root = partial.path ?? tempDir('plugin')
  return {
    id: 'safe-plugin',
    dirName: 'safe-plugin',
    path: root,
    enabled: true,
    approved: true,
    approvalState: 'approved',
    permissionFingerprint: 'workspace:read',
    approvedPermissionFingerprint: 'workspace:read',
    manifest: {
      id: 'safe-plugin',
      name: 'Safe Plugin',
      version: '0.1.0',
      permissions: ['workspace:read'],
      contributes: { tabs: [{ id: 'main', title: 'Safe Plugin', entry: 'panel.html' }] },
    },
    ...partial,
  }
}

const minimalManifest = {
  id: 'safe-plugin',
  name: 'Safe Plugin',
  version: '0.1.0',
  permissions: ['workspace:read'],
  contributes: { tabs: [{ id: 'main', title: 'Safe Plugin', entry: 'panel.html' }] },
}

function pluginSchema(): Record<string, any> {
  return JSON.parse(readFileSync(join(process.cwd(), 'schemas', 'crewcode.plugin.schema.json'), 'utf8')) as Record<string, any>
}

describe('plugin manifest schema contract', () => {
  it('pins the documented API version to the runtime-supported version', () => {
    expect(pluginSchema().properties.crewcode.properties.apiVersion.const).toBe(CREWCODE_PLUGIN_API_VERSION)
  })

  it('documents every known plugin permission exactly once', () => {
    const schemaPermissions = pluginSchema().properties.permissions.items.enum
    expect([...schemaPermissions].sort()).toEqual(Object.keys(PLUGIN_PERMISSION_INFO).sort())
  })

  it('documents every v0 contribution point', () => {
    expect(Object.keys(pluginSchema().properties.contributes.properties).sort()).toEqual([
      'agentProviders',
      'browserActions',
      'chatActions',
      'chatHeaderItems',
      'commands',
      'editorActions',
      'gitLenses',
      'mcpServers',
      'missionWidgets',
      'sidebarPanels',
      'statusItems',
      'tabs',
      'terminalWatchers',
    ].sort())
  })
})

describe('plugin contribution permission gates', () => {
  it('maps gated contribution points to their manifest permissions', () => {
    expect(requiredPermissionForPluginContribution('agentProviders')).toBe('agent:provider')
    expect(requiredPermissionForPluginContribution('mcpServers')).toBe('mcp:server')
  })
})

describe('plugin agent provider permission gates', () => {
  it('maps each provider runtime to its required permissions', () => {
    expect(requiredPermissionsForPluginAgentRuntime('mock')).toEqual(['agent:provider'])
    expect(requiredPermissionsForPluginAgentRuntime('exec')).toEqual(['agent:provider', 'terminal:spawn'])
    expect(requiredPermissionsForPluginAgentRuntime('stdio-jsonrpc')).toEqual(['agent:provider', 'terminal:spawn'])
    expect(requiredPermissionsForPluginAgentRuntime('http')).toEqual(['agent:provider', 'network:fetch'])
    expect(requiredPermissionsForPluginAgentRuntime('sse-http')).toEqual(['agent:provider', 'network:fetch'])
    expect(requiredPermissionsForPluginAgentRuntime('openai-compatible')).toEqual(['agent:provider', 'network:fetch'])
    expect(requiredPermissionsForPluginAgentRuntime('websocket')).toEqual(['agent:provider', 'network:fetch'])
  })
})

describe('pluginPermissionFingerprint', () => {
  it('is stable across permission order changes', () => {
    expect(pluginPermissionFingerprint(['workspace:write', 'workspace:read']))
      .toBe(pluginPermissionFingerprint(['workspace:read', 'workspace:write']))
  })
})

describe('validatePluginManifest', () => {
  it('accepts the stable v0 manifest shape', () => {
    const manifest = validatePluginManifest(minimalManifest, tempDir('manifest'))
    expect(manifest.id).toBe('safe-plugin')
    expect(manifest.crewcode?.apiVersion).toBe('0.1')
  })

  it('rejects unknown permissions', () => {
    expect(() => validatePluginManifest({ ...minimalManifest, permissions: ['workspace:delete'] }, tempDir('manifest')))
      .toThrow('unknown permission')
  })

  it('rejects unsupported API versions with a compatibility hint', () => {
    expect(() => validatePluginManifest({
      ...minimalManifest,
      crewcode: { apiVersion: '0.2' },
    }, tempDir('manifest'))).toThrow('unsupported crewcode.apiVersion "0.2"; this CrewCode build supports 0.1')
  })

  it('rejects tab entries that escape the plugin folder', () => {
    expect(() => validatePluginManifest({
      ...minimalManifest,
      contributes: { tabs: [{ id: 'main', title: 'Bad', entry: '../outside.html' }] },
    }, tempDir('manifest'))).toThrow('escapes plugin folder')
  })

  it('rejects absolute tab entries', () => {
    expect(() => validatePluginManifest({
      ...minimalManifest,
      contributes: { tabs: [{ id: 'main', title: 'Bad', entry: '/tmp/panel.html' }] },
    }, tempDir('manifest'))).toThrow('entry must be relative')
  })

  it('accepts sidebar panel contributions', () => {
    const manifest = validatePluginManifest({
      ...minimalManifest,
      contributes: { sidebarPanels: [{ id: 'graph', title: 'Graph', entry: 'panel.html' }] },
    }, tempDir('manifest'))
    expect(manifest.contributes?.sidebarPanels?.[0].id).toBe('graph')
  })

  it('rejects sidebar panel entries that escape the plugin folder', () => {
    expect(() => validatePluginManifest({
      ...minimalManifest,
      contributes: { sidebarPanels: [{ id: 'graph', title: 'Graph', entry: '../outside.html' }] },
    }, tempDir('manifest'))).toThrow('contributes.sidebarPanels[0].entry escapes plugin folder')
  })

  it('accepts status item contributions', () => {
    const manifest = validatePluginManifest({
      ...minimalManifest,
      contributes: { statusItems: [{ id: 'graph-ready', title: 'Graph Ready', text: 'graph', sidebarPanel: 'graph' }] },
    }, tempDir('manifest'))
    expect(manifest.contributes?.statusItems?.[0].text).toBe('graph')
  })

  it('rejects invalid status item ids', () => {
    expect(() => validatePluginManifest({
      ...minimalManifest,
      contributes: { statusItems: [{ id: 'bad id', title: 'Bad' }] },
    }, tempDir('manifest'))).toThrow('contributes.statusItems[0] has invalid id')
  })

  it('accepts editor action contributions', () => {
    const manifest = validatePluginManifest({
      ...minimalManifest,
      contributes: { editorActions: [{ id: 'show-in-graph', title: 'Show in Graph', sidebarPanel: 'graph' }] },
    }, tempDir('manifest'))
    expect(manifest.contributes?.editorActions?.[0].sidebarPanel).toBe('graph')
  })

  it('rejects invalid editor action ids', () => {
    expect(() => validatePluginManifest({
      ...minimalManifest,
      contributes: { editorActions: [{ id: 'bad id', title: 'Bad' }] },
    }, tempDir('manifest'))).toThrow('contributes.editorActions[0] has invalid id')
  })

  it('accepts chat action contributions', () => {
    const manifest = validatePluginManifest({
      ...minimalManifest,
      contributes: { chatActions: [{ id: 'inspect-chat', title: 'Inspect Chat', sidebarPanel: 'graph', messageRole: 'any' }] },
    }, tempDir('manifest'))
    expect(manifest.contributes?.chatActions?.[0].messageRole).toBe('any')
  })

  it('accepts chat header item contributions', () => {
    const manifest = validatePluginManifest({
      ...minimalManifest,
      contributes: { chatHeaderItems: [{ id: 'ticket', title: 'Ticket Context', text: 'ticket', sidebarPanel: 'panel' }] },
    }, tempDir('manifest'))
    expect(manifest.contributes?.chatHeaderItems?.[0].text).toBe('ticket')
  })

  it('rejects invalid chat action message roles', () => {
    expect(() => validatePluginManifest({
      ...minimalManifest,
      contributes: { chatActions: [{ id: 'inspect-chat', title: 'Bad', messageRole: 'system' }] },
    }, tempDir('manifest'))).toThrow('messageRole must be user, agent, or any')
  })

  it('accepts MCP server contributions', () => {
    const manifest = validatePluginManifest({
      ...minimalManifest,
      permissions: ['mcp:server'],
      contributes: { mcpServers: [{ id: 'linear', title: 'Linear MCP', command: 'npx', args: ['-y', '@company/linear-mcp'], category: 'issues' }] },
    }, tempDir('manifest'))
    expect(manifest.contributes?.mcpServers?.[0].command).toBe('npx')
  })

  it('rejects invalid MCP server args', () => {
    expect(() => validatePluginManifest({
      ...minimalManifest,
      permissions: ['mcp:server'],
      contributes: { mcpServers: [{ id: 'linear', title: 'Bad', command: 'npx', args: ['ok', 42] }] },
    }, tempDir('manifest'))).toThrow('contributes.mcpServers[0].args must be an array of strings')
  })

  it('accepts mock agent provider contributions', () => {
    const manifest = validatePluginManifest({
      ...minimalManifest,
      permissions: ['agent:provider'],
      contributes: { agentProviders: [{ id: 'mock-reviewer', title: 'Mock Reviewer', runtime: 'mock', models: ['mock-default'] }] },
    }, tempDir('manifest'))
    expect(manifest.contributes?.agentProviders?.[0].runtime).toBe('mock')
  })

  it('accepts exec and http agent provider runtimes', () => {
    const manifest = validatePluginManifest({
      ...minimalManifest,
      permissions: ['agent:provider', 'terminal:spawn', 'network:fetch'],
      contributes: { agentProviders: [
        { id: 'copilot', title: 'Copilot', runtime: 'exec', command: 'gh', args: ['copilot', 'suggest', '{{prompt}}'] },
        { id: 'company', title: 'Company', runtime: 'http', endpoint: 'http://localhost:8787/agent' },
      ] },
    }, tempDir('manifest'))
    expect(manifest.contributes?.agentProviders?.[0].runtime).toBe('exec')
    expect(manifest.contributes?.agentProviders?.[1].runtime).toBe('http')
  })

  it('accepts compatibility agent provider runtimes', () => {
    const manifest = validatePluginManifest({
      ...minimalManifest,
      permissions: ['agent:provider', 'terminal:spawn', 'network:fetch'],
      contributes: { agentProviders: [
        { id: 'openai', title: 'OpenAI Compatible', runtime: 'openai-compatible', endpoint: 'http://localhost:4000/v1', apiKeyEnv: 'LOCAL_AGENT_KEY', timeoutMs: 120000, maxOutputBytes: 524288, requestFormat: 'openai-chat', responsePath: 'choices.0.message.content' },
        { id: 'sse', title: 'SSE Agent', runtime: 'sse-http', endpoint: 'http://localhost:4001/events' },
        { id: 'rpc', title: 'JSON RPC Agent', runtime: 'stdio-jsonrpc', command: 'agent-rpc' },
        { id: 'ws', title: 'WebSocket Agent', runtime: 'websocket', endpoint: 'ws://localhost:4002/agent' },
      ] },
    }, tempDir('manifest'))
    expect(manifest.contributes?.agentProviders?.map(provider => provider.runtime)).toEqual(['openai-compatible', 'sse-http', 'stdio-jsonrpc', 'websocket'])
    expect(manifest.contributes?.agentProviders?.[0].timeoutMs).toBe(120000)
    expect(manifest.contributes?.agentProviders?.[0].responsePath).toBe('choices.0.message.content')
  })

  it('rejects invalid agent provider runtime knobs', () => {
    expect(() => validatePluginManifest({
      ...minimalManifest,
      permissions: ['agent:provider', 'network:fetch'],
      contributes: { agentProviders: [{ id: 'bad-format', title: 'Bad', runtime: 'http', endpoint: 'http://localhost:8787/agent', requestFormat: 'xml' }] },
    }, tempDir('manifest'))).toThrow('requestFormat must be crewcode or openai-chat')
    expect(() => validatePluginManifest({
      ...minimalManifest,
      permissions: ['agent:provider', 'network:fetch'],
      contributes: { agentProviders: [{ id: 'bad-timeout', title: 'Bad', runtime: 'http', endpoint: 'http://localhost:8787/agent', timeoutMs: -1 }] },
    }, tempDir('manifest'))).toThrow('timeoutMs must be a positive integer')
  })

  it('rejects unsupported agent provider runtimes', () => {
    expect(() => validatePluginManifest({
      ...minimalManifest,
      permissions: ['agent:provider'],
      contributes: { agentProviders: [{ id: 'aider', title: 'Aider', runtime: 'pty' }] },
    }, tempDir('manifest'))).toThrow('contributes.agentProviders[0].runtime must be one of')
  })

  it('requires command or endpoint for real agent provider runtimes', () => {
    expect(() => validatePluginManifest({
      ...minimalManifest,
      permissions: ['agent:provider'],
      contributes: { agentProviders: [{ id: 'bad', title: 'Bad', runtime: 'exec' }] },
    }, tempDir('manifest'))).toThrow('command is required for exec runtime')
    expect(() => validatePluginManifest({
      ...minimalManifest,
      permissions: ['agent:provider'],
      contributes: { agentProviders: [{ id: 'bad-http', title: 'Bad HTTP', runtime: 'http' }] },
    }, tempDir('manifest'))).toThrow('endpoint is required for http runtime')
  })

  it('accepts deeper dogfood UI contributions', () => {
    const manifest = validatePluginManifest({
      ...minimalManifest,
      contributes: {
        gitLenses: [{ id: 'risk', title: 'Risk Lens', sidebarPanel: 'risk', placement: 'sidebar' }],
        missionWidgets: [{ id: 'ci', title: 'CI', text: 'ci ready', sidebarPanel: 'ci' }],
        terminalWatchers: [{ id: 'watch', title: 'Watch', sidebarPanel: 'watchdog', mode: 'opt-in' }],
        browserActions: [{ id: 'docs', title: 'Docs', sidebarPanel: 'docs', browserContext: 'selection' }],
      },
    }, tempDir('manifest'))
    expect(manifest.contributes?.gitLenses?.[0].placement).toBe('sidebar')
    expect(manifest.contributes?.terminalWatchers?.[0].mode).toBe('opt-in')
  })
})

describe('plugin asset hardening', () => {
  it('sets explicit MIME types and nosniff headers', () => {
    expect(pluginAssetMimeType('panel.html')).toBe('text/html; charset=utf-8')
    expect(pluginAssetMimeType('assets/app.js')).toBe('text/javascript; charset=utf-8')
    expect(pluginAssetMimeType('assets/app.css')).toBe('text/css; charset=utf-8')
    expect(pluginAssetHeaders('panel.html')['X-Content-Type-Options']).toBe('nosniff')
  })

  it('adds restrictive CSP to HTML plugin panels', () => {
    const csp = pluginAssetHeaders('panel.html')['Content-Security-Policy']
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("form-action 'none'")
    // CrewCode's trusted renderer has a different origin from crewcode-plugin://;
    // frame-ancestors 'self' would block every plugin panel iframe.
    expect(csp).not.toContain('frame-ancestors')
  })
})

describe('resolvePluginAssetTarget', () => {
  it('serves assets inside the enabled plugin folder', () => {
    const root = tempDir('asset')
    writeFileSync(join(root, 'panel.html'), '<html></html>')
    const result = resolvePluginAssetTarget(plugin({ path: root }), 'panel.html')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.target).toBe(join(root, 'panel.html'))
  })

  it('blocks protocol asset path traversal', () => {
    const root = tempDir('asset')
    writeFileSync(join(root, 'panel.html'), '<html></html>')
    const result = resolvePluginAssetTarget(plugin({ path: root }), '../panel.html')
    expect(result).toMatchObject({ ok: false, status: 403 })
  })

  it('blocks absolute protocol asset paths', () => {
    const result = resolvePluginAssetTarget(plugin(), '/tmp/panel.html')
    expect(result).toMatchObject({ ok: false, status: 400 })
  })
})

describe('invokePluginCapabilityWithPlugins', () => {
  it('allows listFiles and readFile with workspace:read', () => {
    const workspace = tempDir('workspace')
    writeFileSync(join(workspace, 'README.md'), 'hello')

    const list = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'workspace:listFiles',
      workspaceRoot: workspace,
    }, [plugin()])
    expect(list).toEqual({ ok: true, result: { files: ['README.md'] } })

    const read = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'workspace:readFile',
      workspaceRoot: workspace,
      params: { sub: 'README.md' },
    }, [plugin()])
    expect(read).toEqual({ ok: true, result: { text: 'hello', rel: 'README.md', size: 5 } })
  })

  it('denies reads without workspace:read', () => {
    const p = plugin({ manifest: { ...plugin().manifest, permissions: [] } })
    const result = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'workspace:readFile',
      workspaceRoot: tempDir('workspace'),
      params: { sub: 'README.md' },
    }, [p])
    expect(result).toEqual({ ok: false, error: 'plugin capability denied: workspace:readFile requires workspace:read' })
  })

  it('blocks workspace read path traversal', () => {
    const workspace = tempDir('workspace')
    const result = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'workspace:readFile',
      workspaceRoot: workspace,
      params: { sub: '../secret.txt' },
    }, [plugin()])
    expect(result).toEqual({ ok: false, error: 'path escapes workspace' })
  })

  it('denies writes without workspace:write', () => {
    const workspace = tempDir('workspace')
    const result = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'workspace:writeFile',
      workspaceRoot: workspace,
      params: { sub: 'notes.txt', text: 'hello' },
    }, [plugin()])
    expect(result).toEqual({ ok: false, error: 'plugin capability denied: workspace:writeFile requires workspace:write' })
    expect(existsSync(join(workspace, 'notes.txt'))).toBe(false)
  })

  it('blocks workspace write path traversal', () => {
    const workspace = tempDir('workspace')
    const p = plugin({ manifest: { ...plugin().manifest, permissions: ['workspace:write'] } })
    const result = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'workspace:writeFile',
      workspaceRoot: workspace,
      params: { sub: '../notes.txt', text: 'hello' },
    }, [p])
    expect(result).toEqual({ ok: false, error: 'path escapes workspace' })
    expect(existsSync(join(workspace, '..', 'notes.txt'))).toBe(false)
  })

  it('allows writes with workspace:write while keeping them under root', () => {
    const workspace = tempDir('workspace')
    const p = plugin({ manifest: { ...plugin().manifest, permissions: ['workspace:write'] } })
    const result = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'workspace:writeFile',
      workspaceRoot: workspace,
      params: { sub: 'notes/plugin.txt', text: 'hello' },
    }, [p])
    expect(result).toEqual({ ok: true, result: { rel: 'notes/plugin.txt' } })
    expect(existsSync(join(workspace, 'notes/plugin.txt'))).toBe(true)
  })

  it('explains unapproved plugin capability denial', () => {
    const result = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'workspace:listFiles',
      workspaceRoot: tempDir('workspace'),
    }, [plugin({ approved: false, approvalState: 'needs-approval' })])
    expect(result).toEqual({ ok: false, error: 'plugin capability denied: plugin "safe-plugin" approval is required' })
  })

  it('explains changed-permission plugin capability denial', () => {
    const result = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'workspace:listFiles',
      workspaceRoot: tempDir('workspace'),
    }, [plugin({ approved: false, approvalState: 'permissions-changed' })])
    expect(result).toEqual({ ok: false, error: 'plugin capability denied: plugin "safe-plugin" permissions changed and need approval' })
  })

  it('denies network fetch from iframes even when declared', () => {
    const noPerm = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'network:fetch',
      params: { input: 'https://example.com' },
    }, [plugin()])
    expect(noPerm).toEqual({ ok: false, error: 'plugin capability denied: network:fetch is reserved for future audited host networking; provider runtimes are the v0 network path' })

    const withPerm = plugin({ manifest: { ...plugin().manifest, permissions: ['network:fetch'] } })
    const result = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'network:fetch',
      params: { input: 'https://example.com' },
    }, [withPerm])
    expect(result).toEqual({ ok: false, error: 'plugin capability denied: network:fetch is reserved for future audited host networking; provider runtimes are the v0 network path' })
  })

  it('denies secret reads from iframes even when declared', () => {
    const noPerm = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'secrets:get',
      params: { key: 'token' },
    }, [plugin()])
    expect(noPerm).toEqual({ ok: false, error: 'plugin capability denied: secrets:get is reserved until first-class plugin secret storage exists' })

    const withPerm = plugin({ manifest: { ...plugin().manifest, permissions: ['secrets:read'] } })
    const result = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'secrets:get',
      params: { key: 'token' },
    }, [withPerm])
    expect(result).toEqual({ ok: false, error: 'plugin capability denied: secrets:get is reserved until first-class plugin secret storage exists' })
  })

  it('explains disabled plugin capability denial', () => {
    const result = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'workspace:listFiles',
      workspaceRoot: tempDir('workspace'),
    }, [plugin({ enabled: false })])
    expect(result).toEqual({ ok: false, error: 'plugin capability denied: plugin "safe-plugin" is disabled' })
  })

  it('explains remote SSH workspace denial', () => {
    const result = invokePluginCapabilityWithPlugins({
      registrationId: 'safe-plugin:main',
      method: 'workspace:listFiles',
      workspaceRoot: 'ssh://dev@box/home/dev/project',
    }, [plugin()])
    expect(result).toEqual({ ok: false, error: 'plugin capability denied: remote SSH workspaces are local-only in plugin API v0 until safe remote capability routes exist' })
  })
})

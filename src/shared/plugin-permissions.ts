import type { PluginPermission, PluginPermissionInfo } from './plugin-types'

export const PLUGIN_PERMISSION_INFO: Record<PluginPermission, PluginPermissionInfo> = {
  'workspace:read': {
    permission: 'workspace:read',
    label: 'read local workspace files',
    description: 'Can list and read files in the active local workspace. Remote SSH workspaces are blocked in v0.',
    risk: 'medium',
  },
  'workspace:write': {
    permission: 'workspace:write',
    label: 'write local workspace files',
    description: 'Can create or overwrite files inside the active local workspace. Remote SSH workspaces are blocked in v0.',
    risk: 'high',
  },
  'git:read': {
    permission: 'git:read',
    label: 'read git state',
    description: 'Reserved for read-only git lenses and future audited git capability calls.',
    risk: 'medium',
  },
  'git:write': {
    permission: 'git:write',
    label: 'change git state',
    description: 'Reserved for future audited git operations that modify branches, commits, or remotes.',
    risk: 'high',
  },
  'terminal:spawn': {
    permission: 'terminal:spawn',
    label: 'spawn local processes',
    description: 'Allows exec and stdio-jsonrpc agent provider runtimes to start local processes without shell interpolation.',
    risk: 'high',
  },
  'terminal:read': {
    permission: 'terminal:read',
    label: 'read terminal output',
    description: 'Reserved for future audited terminal watchers; v0 watcher actions do not receive output streams.',
    risk: 'medium',
  },
  'agent:prompt': {
    permission: 'agent:prompt',
    label: 'prompt agents',
    description: 'Reserved for future audited agent prompt actions. v0 provider plugins only register providers.',
    risk: 'high',
  },
  'agent:provider': {
    permission: 'agent:provider',
    label: 'contribute agent providers',
    description: 'Can register plugin-powered agent providers that appear in CrewCode agent selection and crew config.',
    risk: 'high',
  },
  'browser:read': {
    permission: 'browser:read',
    label: 'read browser context',
    description: 'Reserved for future audited browser reads. v0 browser actions receive only explicit open context such as URL.',
    risk: 'medium',
  },
  'mcp:server': {
    permission: 'mcp:server',
    label: 'contribute MCP servers',
    description: 'Can register local MCP server commands for CrewCode-controlled agent tool routing.',
    risk: 'high',
  },
  'network:fetch': {
    permission: 'network:fetch',
    label: 'use network provider runtimes',
    description: 'Allows HTTP, SSE, OpenAI-compatible, and WebSocket agent provider runtimes. Plugin iframes cannot call network:fetch in v0.',
    risk: 'high',
  },
  'secrets:read': {
    permission: 'secrets:read',
    label: 'read saved secrets',
    description: 'Reserved until first-class plugin secret storage exists. Plugin iframes cannot call secrets:get in v0.',
    risk: 'high',
  },
}

export function pluginPermissionInfo(permission: PluginPermission): PluginPermissionInfo {
  return PLUGIN_PERMISSION_INFO[permission]
}

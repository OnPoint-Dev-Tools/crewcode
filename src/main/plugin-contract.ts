import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'path'

import {
  CREWCODE_PLUGIN_API_VERSION,
  type CrewCodePluginManifest,
  type InstalledPlugin,
  type PluginAgentProviderContribution,
  type PluginAgentProviderRuntime,
  type PluginCommandContribution,
  type PluginInvokeRequest,
  type PluginInvokeResult,
  type PluginPermission,
  type PluginPanelContribution,
  type PluginBrowserActionContribution,
  type PluginChatActionContribution,
  type PluginChatHeaderItemContribution,
  type PluginEditorActionContribution,
  type PluginGitLensContribution,
  type PluginMcpServerContribution,
  type PluginMissionWidgetContribution,
  type PluginStatusItemContribution,
  type PluginTerminalWatcherContribution,
} from '../shared/plugin-types'
import { IGNORE, MAX_FILE_BYTES } from './fs-constants'
import { isRemoteRoot } from './remote/ssh-target'

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i
const SUPPORTED_PLUGIN_API_VERSIONS = new Set([CREWCODE_PLUGIN_API_VERSION])
const KNOWN_PERMISSIONS = new Set<PluginPermission>([
  'workspace:read',
  'workspace:write',
  'git:read',
  'git:write',
  'terminal:spawn',
  'terminal:read',
  'agent:prompt',
  'agent:provider',
  'browser:read',
  'mcp:server',
  'network:fetch',
  'secrets:read',
])

export function pluginPermissionFingerprint(permissions: readonly PluginPermission[] | undefined): string {
  return [...(permissions ?? [])].sort().join('\n')
}

export function isSafePathUnder(root: string, target: string): boolean {
  const a = normalize(root)
  const b = normalize(target)
  return b === a || b.startsWith(a + sep)
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be a non-empty string`)
  return value.trim()
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value.trim() || undefined
}

function optionalPositiveInteger(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`)
  return value
}

function validateId(id: string, label: string): string {
  if (!ID_RE.test(id)) throw new Error(`${label} has invalid id "${id}"`)
  return id
}

function validatePluginApiVersion(raw: string | undefined): string {
  const apiVersion = raw ?? CREWCODE_PLUGIN_API_VERSION
  if (!SUPPORTED_PLUGIN_API_VERSIONS.has(apiVersion)) {
    throw new Error(`unsupported crewcode.apiVersion "${apiVersion}"; this CrewCode build supports ${[...SUPPORTED_PLUGIN_API_VERSIONS].join(', ')}. Update the plugin manifest or install a compatible CrewCode build.`)
  }
  return apiVersion
}

function validatePermissions(raw: unknown): PluginPermission[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('permissions must be an array')
  const out: PluginPermission[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !KNOWN_PERMISSIONS.has(item as PluginPermission)) {
      throw new Error(`unknown permission "${String(item)}"`)
    }
    if (!out.includes(item as PluginPermission)) out.push(item as PluginPermission)
  }
  return out
}

function validateStatusItems(raw: unknown): PluginStatusItemContribution[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('contributes.statusItems must be an array')
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`contributes.statusItems[${i}] must be an object`)
    const obj = item as Record<string, unknown>
    return {
      id: validateId(requireString(obj, 'id'), `contributes.statusItems[${i}]`),
      title: requireString(obj, 'title'),
      text: optionalString(obj, 'text'),
      icon: optionalString(obj, 'icon'),
      command: optionalString(obj, 'command'),
      tab: optionalString(obj, 'tab'),
      sidebarPanel: optionalString(obj, 'sidebarPanel'),
      when: optionalString(obj, 'when'),
    }
  })
}

function validateChatActions(raw: unknown): PluginChatActionContribution[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('contributes.chatActions must be an array')
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`contributes.chatActions[${i}] must be an object`)
    const obj = item as Record<string, unknown>
    const messageRole = obj.messageRole
    if (messageRole !== undefined && messageRole !== 'user' && messageRole !== 'agent' && messageRole !== 'any') {
      throw new Error(`contributes.chatActions[${i}].messageRole must be user, agent, or any`)
    }
    return {
      id: validateId(requireString(obj, 'id'), `contributes.chatActions[${i}]`),
      title: requireString(obj, 'title'),
      icon: optionalString(obj, 'icon'),
      command: optionalString(obj, 'command'),
      tab: optionalString(obj, 'tab'),
      sidebarPanel: optionalString(obj, 'sidebarPanel'),
      messageRole: messageRole as PluginChatActionContribution['messageRole'],
      when: optionalString(obj, 'when'),
    }
  })
}

function validateAgentProviders(raw: unknown): PluginAgentProviderContribution[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('contributes.agentProviders must be an array')
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`contributes.agentProviders[${i}] must be an object`)
    const obj = item as Record<string, unknown>
    const runtime = obj.runtime
    const supportedRuntimes = ['mock', 'exec', 'http', 'sse-http', 'openai-compatible', 'stdio-jsonrpc', 'websocket']
    if (!supportedRuntimes.includes(String(runtime))) throw new Error(`contributes.agentProviders[${i}].runtime must be one of ${supportedRuntimes.join(', ')}`)
    const models = obj.models
    if (models !== undefined && (!Array.isArray(models) || models.some(model => typeof model !== 'string'))) {
      throw new Error(`contributes.agentProviders[${i}].models must be an array of strings`)
    }
    const args = obj.args
    if (args !== undefined && (!Array.isArray(args) || args.some(arg => typeof arg !== 'string'))) {
      throw new Error(`contributes.agentProviders[${i}].args must be an array of strings`)
    }
    const command = optionalString(obj, 'command')
    const endpoint = optionalString(obj, 'endpoint')
    const apiKeyEnv = optionalString(obj, 'apiKeyEnv')
    const requestFormat = optionalString(obj, 'requestFormat')
    const responsePath = optionalString(obj, 'responsePath')
    if (requestFormat !== undefined && requestFormat !== 'crewcode' && requestFormat !== 'openai-chat') {
      throw new Error(`contributes.agentProviders[${i}].requestFormat must be crewcode or openai-chat`)
    }
    if ((runtime === 'exec' || runtime === 'stdio-jsonrpc') && !command) throw new Error(`contributes.agentProviders[${i}].command is required for ${runtime} runtime`)
    if (runtime === 'http' || runtime === 'sse-http' || runtime === 'openai-compatible') {
      if (!endpoint) throw new Error(`contributes.agentProviders[${i}].endpoint is required for ${runtime} runtime`)
      try {
        const url = new URL(endpoint)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol')
      } catch {
        throw new Error(`contributes.agentProviders[${i}].endpoint must be an http(s) URL`)
      }
    }
    if (runtime === 'websocket') {
      if (!endpoint) throw new Error(`contributes.agentProviders[${i}].endpoint is required for websocket runtime`)
      try {
        const url = new URL(endpoint)
        if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('bad protocol')
      } catch {
        throw new Error(`contributes.agentProviders[${i}].endpoint must be a ws(s) URL`)
      }
    }
    return {
      id: validateId(requireString(obj, 'id'), `contributes.agentProviders[${i}]`),
      title: requireString(obj, 'title'),
      runtime: runtime as PluginAgentProviderRuntime,
      description: optionalString(obj, 'description'),
      models: models as string[] | undefined,
      command,
      args: args as string[] | undefined,
      endpoint,
      apiKeyEnv,
      timeoutMs: optionalPositiveInteger(obj, 'timeoutMs'),
      maxOutputBytes: optionalPositiveInteger(obj, 'maxOutputBytes'),
      requestFormat: requestFormat as PluginAgentProviderContribution['requestFormat'],
      responsePath,
      when: optionalString(obj, 'when'),
    }
  })
}

function validateGitLenses(raw: unknown): PluginGitLensContribution[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('contributes.gitLenses must be an array')
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`contributes.gitLenses[${i}] must be an object`)
    const obj = item as Record<string, unknown>
    const placement = obj.placement
    if (placement !== undefined && placement !== 'sidebar' && placement !== 'diff') throw new Error(`contributes.gitLenses[${i}].placement must be sidebar or diff`)
    return { id: validateId(requireString(obj, 'id'), `contributes.gitLenses[${i}]`), title: requireString(obj, 'title'), icon: optionalString(obj, 'icon'), command: optionalString(obj, 'command'), tab: optionalString(obj, 'tab'), sidebarPanel: optionalString(obj, 'sidebarPanel'), placement: placement as PluginGitLensContribution['placement'], when: optionalString(obj, 'when') }
  })
}

function validateMissionWidgets(raw: unknown): PluginMissionWidgetContribution[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('contributes.missionWidgets must be an array')
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`contributes.missionWidgets[${i}] must be an object`)
    const obj = item as Record<string, unknown>
    return { id: validateId(requireString(obj, 'id'), `contributes.missionWidgets[${i}]`), title: requireString(obj, 'title'), text: optionalString(obj, 'text'), icon: optionalString(obj, 'icon'), command: optionalString(obj, 'command'), tab: optionalString(obj, 'tab'), sidebarPanel: optionalString(obj, 'sidebarPanel'), when: optionalString(obj, 'when') }
  })
}

function validateTerminalWatchers(raw: unknown): PluginTerminalWatcherContribution[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('contributes.terminalWatchers must be an array')
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`contributes.terminalWatchers[${i}] must be an object`)
    const obj = item as Record<string, unknown>
    const mode = obj.mode
    if (mode !== undefined && mode !== 'opt-in') throw new Error(`contributes.terminalWatchers[${i}].mode must be opt-in`)
    return { id: validateId(requireString(obj, 'id'), `contributes.terminalWatchers[${i}]`), title: requireString(obj, 'title'), icon: optionalString(obj, 'icon'), command: optionalString(obj, 'command'), tab: optionalString(obj, 'tab'), sidebarPanel: optionalString(obj, 'sidebarPanel'), mode: mode as PluginTerminalWatcherContribution['mode'], when: optionalString(obj, 'when') }
  })
}

function validateBrowserActions(raw: unknown): PluginBrowserActionContribution[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('contributes.browserActions must be an array')
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`contributes.browserActions[${i}] must be an object`)
    const obj = item as Record<string, unknown>
    const browserContext = obj.browserContext
    if (browserContext !== undefined && browserContext !== 'url' && browserContext !== 'selection') throw new Error(`contributes.browserActions[${i}].browserContext must be url or selection`)
    return { id: validateId(requireString(obj, 'id'), `contributes.browserActions[${i}]`), title: requireString(obj, 'title'), icon: optionalString(obj, 'icon'), command: optionalString(obj, 'command'), tab: optionalString(obj, 'tab'), sidebarPanel: optionalString(obj, 'sidebarPanel'), browserContext: browserContext as PluginBrowserActionContribution['browserContext'], when: optionalString(obj, 'when') }
  })
}

function validateMcpServers(raw: unknown): PluginMcpServerContribution[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('contributes.mcpServers must be an array')
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`contributes.mcpServers[${i}] must be an object`)
    const obj = item as Record<string, unknown>
    const args = obj.args
    if (args !== undefined && (!Array.isArray(args) || args.some(arg => typeof arg !== 'string'))) {
      throw new Error(`contributes.mcpServers[${i}].args must be an array of strings`)
    }
    return {
      id: validateId(requireString(obj, 'id'), `contributes.mcpServers[${i}]`),
      title: requireString(obj, 'title'),
      command: requireString(obj, 'command'),
      args: args as string[] | undefined,
      category: optionalString(obj, 'category'),
      description: optionalString(obj, 'description'),
      when: optionalString(obj, 'when'),
    }
  })
}

function validateChatHeaderItems(raw: unknown): PluginChatHeaderItemContribution[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('contributes.chatHeaderItems must be an array')
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`contributes.chatHeaderItems[${i}] must be an object`)
    const obj = item as Record<string, unknown>
    return {
      id: validateId(requireString(obj, 'id'), `contributes.chatHeaderItems[${i}]`),
      title: requireString(obj, 'title'),
      text: optionalString(obj, 'text'),
      icon: optionalString(obj, 'icon'),
      command: optionalString(obj, 'command'),
      tab: optionalString(obj, 'tab'),
      sidebarPanel: optionalString(obj, 'sidebarPanel'),
      when: optionalString(obj, 'when'),
    }
  })
}

function validateEditorActions(raw: unknown): PluginEditorActionContribution[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('contributes.editorActions must be an array')
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`contributes.editorActions[${i}] must be an object`)
    const obj = item as Record<string, unknown>
    return {
      id: validateId(requireString(obj, 'id'), `contributes.editorActions[${i}]`),
      title: requireString(obj, 'title'),
      icon: optionalString(obj, 'icon'),
      command: optionalString(obj, 'command'),
      tab: optionalString(obj, 'tab'),
      sidebarPanel: optionalString(obj, 'sidebarPanel'),
      filePattern: optionalString(obj, 'filePattern'),
      when: optionalString(obj, 'when'),
    }
  })
}

function validateCommands(raw: unknown): PluginCommandContribution[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('contributes.commands must be an array')
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`contributes.commands[${i}] must be an object`)
    const obj = item as Record<string, unknown>
    return {
      id: validateId(requireString(obj, 'id'), `contributes.commands[${i}]`),
      title: requireString(obj, 'title'),
      icon: optionalString(obj, 'icon'),
      group: optionalString(obj, 'group'),
      when: optionalString(obj, 'when'),
    }
  })
}

function validatePanelContributions(raw: unknown, pluginDir: string, key: 'tabs' | 'sidebarPanels'): PluginPanelContribution[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error(`contributes.${key} must be an array`)
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`contributes.${key}[${i}] must be an object`)
    const obj = item as Record<string, unknown>
    const entry = requireString(obj, 'entry')
    if (isAbsolute(entry)) throw new Error(`contributes.${key}[${i}].entry must be relative`)
    const entryPath = join(pluginDir, entry)
    if (!isSafePathUnder(pluginDir, entryPath)) throw new Error(`contributes.${key}[${i}].entry escapes plugin folder`)
    const singleton = obj.singleton
    if (singleton !== undefined && typeof singleton !== 'boolean') throw new Error(`contributes.${key}[${i}].singleton must be boolean`)
    return {
      id: validateId(requireString(obj, 'id'), `contributes.${key}[${i}]`),
      title: requireString(obj, 'title'),
      icon: optionalString(obj, 'icon'),
      entry,
      singleton,
    }
  })
}

export function validatePluginManifest(raw: unknown, pluginDir: string): CrewCodePluginManifest {
  if (!raw || typeof raw !== 'object') throw new Error('manifest must be an object')
  const obj = raw as Record<string, unknown>
  const id = validateId(requireString(obj, 'id'), 'plugin')
  const enabled = obj.enabled
  if (enabled !== undefined && typeof enabled !== 'boolean') throw new Error('enabled must be boolean')

  const rawCrewcode = obj.crewcode
  let crewcode: CrewCodePluginManifest['crewcode']
  if (rawCrewcode !== undefined) {
    if (!rawCrewcode || typeof rawCrewcode !== 'object') throw new Error('crewcode must be an object')
    const c = rawCrewcode as Record<string, unknown>
    const apiVersion = validatePluginApiVersion(optionalString(c, 'apiVersion'))
    crewcode = {
      minVersion: optionalString(c, 'minVersion'),
      maxVersion: optionalString(c, 'maxVersion'),
      apiVersion,
    }
  } else {
    crewcode = { apiVersion: CREWCODE_PLUGIN_API_VERSION }
  }

  const rawContributes = obj.contributes
  let contributes: CrewCodePluginManifest['contributes']
  if (rawContributes !== undefined) {
    if (!rawContributes || typeof rawContributes !== 'object') throw new Error('contributes must be an object')
    const c = rawContributes as Record<string, unknown>
    contributes = {
      commands: validateCommands(c.commands),
      tabs: validatePanelContributions(c.tabs, pluginDir, 'tabs'),
      sidebarPanels: validatePanelContributions(c.sidebarPanels, pluginDir, 'sidebarPanels'),
      statusItems: validateStatusItems(c.statusItems),
      editorActions: validateEditorActions(c.editorActions),
      chatActions: validateChatActions(c.chatActions),
      chatHeaderItems: validateChatHeaderItems(c.chatHeaderItems),
      mcpServers: validateMcpServers(c.mcpServers),
      agentProviders: validateAgentProviders(c.agentProviders),
      gitLenses: validateGitLenses(c.gitLenses),
      missionWidgets: validateMissionWidgets(c.missionWidgets),
      terminalWatchers: validateTerminalWatchers(c.terminalWatchers),
      browserActions: validateBrowserActions(c.browserActions),
    }
  }

  return {
    id,
    name: requireString(obj, 'name'),
    version: requireString(obj, 'version'),
    description: optionalString(obj, 'description'),
    author: optionalString(obj, 'author'),
    homepage: optionalString(obj, 'homepage'),
    enabled: enabled as boolean | undefined,
    crewcode,
    permissions: validatePermissions(obj.permissions),
    contributes,
  }
}

export function pluginAssetMimeType(rel: string): string {
  const lower = rel.toLowerCase().split('?')[0]
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html; charset=utf-8'
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8'
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.woff')) return 'font/woff'
  if (lower.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}

export function pluginAssetHeaders(rel: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': pluginAssetMimeType(rel),
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  }
  if (pluginAssetMimeType(rel).startsWith('text/html')) {
    headers['Content-Security-Policy'] = [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'none'",
      "media-src 'self' data: blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ')
  }
  return headers
}

export function resolvePluginAssetTarget(plugin: InstalledPlugin, rel: string) {
  if (!rel || isAbsolute(rel)) return { ok: false as const, status: 400, error: 'invalid plugin asset path' }
  const target = join(plugin.path, rel)
  if (!isSafePathUnder(plugin.path, target)) return { ok: false as const, status: 403, error: 'plugin asset escapes folder' }
  if (!existsSync(target)) return { ok: false as const, status: 404, error: 'plugin asset missing' }
  return { ok: true as const, target, headers: pluginAssetHeaders(rel) }
}

export function requiredPermissionForPluginContribution(contribution: 'agentProviders' | 'mcpServers'): PluginPermission {
  return contribution === 'agentProviders' ? 'agent:provider' : 'mcp:server'
}

export function requiredPermissionsForPluginAgentRuntime(runtime: PluginAgentProviderRuntime): PluginPermission[] {
  if (runtime === 'exec' || runtime === 'stdio-jsonrpc') return ['agent:provider', 'terminal:spawn']
  if (runtime === 'http' || runtime === 'sse-http' || runtime === 'openai-compatible' || runtime === 'websocket') return ['agent:provider', 'network:fetch']
  return ['agent:provider']
}

function hasPermission(plugin: InstalledPlugin, permission: PluginPermission): boolean {
  return (plugin.manifest.permissions ?? []).includes(permission)
}

function pluginUnavailableReason(registrationId: string | undefined, plugins: InstalledPlugin[]): string | null {
  if (!registrationId) return 'plugin capability denied: missing registration id'
  const pluginId = registrationId.split(':')[0]
  const plugin = plugins.find(p => p.id === pluginId)
  if (!plugin) return `plugin capability denied: plugin "${pluginId}" is not installed`
  if (!plugin.enabled) return `plugin capability denied: plugin "${pluginId}" is disabled`
  if (!plugin.approved) {
    const reason = plugin.approvalState === 'permissions-changed'
      ? 'permissions changed and need approval'
      : plugin.approvalState === 'revoked'
        ? 'approval was revoked'
        : 'approval is required'
    return `plugin capability denied: plugin "${pluginId}" ${reason}`
  }
  if (!registrationId.startsWith(`${plugin.id}:`)) return `plugin capability denied: registration "${registrationId}" does not belong to plugin "${plugin.id}"`
  return null
}

function permissionDenied(method: string, permission: PluginPermission): PluginInvokeResult {
  return { ok: false, error: `plugin capability denied: ${method} requires ${permission}` }
}

function remoteWorkspaceDenied(): PluginInvokeResult {
  return { ok: false, error: 'plugin capability denied: remote SSH workspaces are local-only in plugin API v0 until safe remote capability routes exist' }
}

function readWorkspaceFile(root: string, sub: string): PluginInvokeResult {
  if (isRemoteRoot(root)) return remoteWorkspaceDenied()
  if (!root || !isAbsolute(root)) return { ok: false, error: 'absolute workspace root required' }
  const target = join(root, sub)
  if (!isSafePathUnder(root, target)) return { ok: false, error: 'path escapes workspace' }
  if (!existsSync(target)) return { ok: false, error: 'file missing' }
  const st = statSync(target)
  if (st.isDirectory()) return { ok: false, error: 'is a directory' }
  if (st.size > MAX_FILE_BYTES) return { ok: false, error: 'file too large (>2MB)' }
  return { ok: true, result: { text: readFileSync(target, 'utf8'), rel: sub, size: st.size } }
}

function writeWorkspaceFile(root: string, sub: string, text: string): PluginInvokeResult {
  if (isRemoteRoot(root)) return remoteWorkspaceDenied()
  if (!root || !isAbsolute(root)) return { ok: false, error: 'absolute workspace root required' }
  const target = join(root, sub)
  if (!isSafePathUnder(root, target)) return { ok: false, error: 'path escapes workspace' }
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return { ok: false, error: 'file too large (>2MB)' }
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, text, 'utf8')
    return { ok: true, result: { rel: sub } }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

function listWorkspaceFiles(root: string): PluginInvokeResult {
  if (isRemoteRoot(root)) return remoteWorkspaceDenied()
  if (!root || !isAbsolute(root)) return { ok: false, error: 'absolute workspace root required' }
  if (!existsSync(root)) return { ok: false, error: 'workspace root missing' }
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (IGNORE.has(name)) continue
      const abs = join(dir, name)
      const st = statSync(abs)
      if (st.isDirectory()) walk(abs)
      else if (st.isFile()) files.push(relative(root, abs))
      if (files.length >= 5000) return
    }
  }
  walk(root)
  return { ok: true, result: { files } }
}

export function invokePluginCapabilityWithPlugins(request: unknown, plugins: InstalledPlugin[]): PluginInvokeResult {
  if (!request || typeof request !== 'object') return { ok: false, error: 'invalid plugin request' }
  const req = request as PluginInvokeRequest
  const unavailable = pluginUnavailableReason(req.registrationId, plugins)
  if (unavailable) return { ok: false, error: unavailable }
  const plugin = plugins.find(p => p.id === req.registrationId?.split(':')[0])
  if (!plugin) return { ok: false, error: 'plugin capability denied: plugin is unavailable' }

  if (req.method === 'workspace:listFiles') {
    if (!hasPermission(plugin, 'workspace:read')) return permissionDenied(req.method, 'workspace:read')
    return listWorkspaceFiles(req.workspaceRoot ?? '')
  }
  if (req.method === 'workspace:readFile') {
    if (!hasPermission(plugin, 'workspace:read')) return permissionDenied(req.method, 'workspace:read')
    const sub = req.params?.sub
    if (typeof sub !== 'string') return { ok: false, error: 'params.sub required' }
    return readWorkspaceFile(req.workspaceRoot ?? '', sub)
  }
  if (req.method === 'workspace:writeFile') {
    if (!hasPermission(plugin, 'workspace:write')) return permissionDenied(req.method, 'workspace:write')
    const sub = req.params?.sub
    const text = req.params?.text
    if (typeof sub !== 'string') return { ok: false, error: 'params.sub required' }
    if (typeof text !== 'string') return { ok: false, error: 'params.text required' }
    return writeWorkspaceFile(req.workspaceRoot ?? '', sub, text)
  }
  if (req.method === 'network:fetch') {
    return { ok: false, error: 'plugin capability denied: network:fetch is reserved for future audited host networking; provider runtimes are the v0 network path' }
  }
  if (req.method === 'secrets:get') {
    return { ok: false, error: 'plugin capability denied: secrets:get is reserved until first-class plugin secret storage exists' }
  }
  return { ok: false, error: `unsupported plugin method: ${String(req.method)}` }
}

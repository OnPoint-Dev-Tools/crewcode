import { BrowserWindow, app, ipcMain, protocol, shell } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'fs'
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'path'
import os from 'os'

import {
  CREWCODE_PLUGIN_API_VERSION,
  CREWCODE_PLUGIN_MANIFEST,
  type CrewCodePluginManifest,
  type InstalledPlugin,
  type PluginCommandContribution,
  type PluginApprovalResult,
  type PluginAuditEntry,
  type RegisteredPluginAgentProvider,
  type PluginCopyExampleResult,
  type PluginGitInspectRequest,
  type PluginGitInspectResult,
  type PluginGitInstallResult,
  type PluginInvokeRequest,
  type PluginInvokeResult,
  type PluginPermission,
  type PluginRegistryError,
  type PluginRegistrySnapshot,
  type RegisteredPluginBrowserAction,
  type RegisteredPluginChatAction,
  type RegisteredPluginChatHeaderItem,
  type RegisteredPluginCommand,
  type RegisteredPluginEditorAction,
  type RegisteredPluginGitLens,
  type RegisteredPluginMcpServer,
  type RegisteredPluginMissionWidget,
  type RegisteredPluginSidebarPanel,
  type RegisteredPluginStatusItem,
  type RegisteredPluginTab,
  type RegisteredPluginTerminalWatcher,
  type PluginTabContribution,
} from '../shared/plugin-types'
import { IGNORE, MAX_FILE_BYTES } from './fs-constants'
import { isRemoteRoot } from './remote/ssh-target'
import { invokePluginCapabilityWithPlugins, pluginPermissionFingerprint, requiredPermissionForPluginContribution, resolvePluginAssetTarget, validatePluginManifest } from './plugin-contract'
import { commitPluginGitInstall, inspectPluginGitRepository, readPluginGitSources } from './plugin-git-install'

export const PLUGIN_PROTOCOL = 'crewcode-plugin'

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/i
const PLUGIN_AUDIT_LIMIT = 300
const PLUGIN_APPROVALS_FILE = 'plugin-approvals.json'
const pluginAuditLog: PluginAuditEntry[] = []
let pluginWatchers: FSWatcher[] = []
let pluginWatchDebounce: NodeJS.Timeout | null = null
let pluginWatchSignature = ''

interface StoredPluginApproval {
  approved: boolean
  permissionFingerprint?: string
  approvedAt?: number
  revokedAt?: number
}

type StoredPluginApprovals = Record<string, StoredPluginApproval>

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

function crewcodeDir(): string {
  return join(os.homedir(), '.crewcode')
}

function pluginsDir(): string {
  return join(crewcodeDir(), 'plugins')
}

function pluginApprovalsPath(): string {
  return join(crewcodeDir(), PLUGIN_APPROVALS_FILE)
}

function readPluginApprovals(): StoredPluginApprovals {
  try {
    const file = pluginApprovalsPath()
    if (!existsSync(file)) return {}
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' ? raw as StoredPluginApprovals : {}
  } catch {
    return {}
  }
}

function writePluginApprovals(approvals: StoredPluginApprovals): void {
  const root = crewcodeDir()
  if (!existsSync(root)) mkdirSync(root, { recursive: true })
  writeFileSync(pluginApprovalsPath(), `${JSON.stringify(approvals, null, 2)}\n`, 'utf8')
}

function ensurePluginsDir(): string {
  const root = pluginsDir()
  if (!existsSync(root)) mkdirSync(root, { recursive: true })

  const readme = join(root, 'README.md')
  if (!existsSync(readme)) {
    writeFileSync(readme, [
      '# CrewCode local plugins',
      '',
      'Each plugin lives in its own folder under this directory and must include',
      `a ${CREWCODE_PLUGIN_MANIFEST} manifest.`,
      '',
      'Example layout:',
      '```txt',
      'codebase-graph/',
      `  ${CREWCODE_PLUGIN_MANIFEST}`,
      '  panel.html',
      '  assets/index.js',
      '```',
      '',
      'Minimal manifest:',
      '```json',
      '{',
      '  "id": "codebase-graph",',
      '  "name": "Codebase Graph",',
      '  "version": "0.1.0",',
      '  "crewcode": { "apiVersion": "0.1" },',
      '  "permissions": ["workspace:read"],',
      '  "contributes": {',
      '    "tabs": [',
      '      { "id": "main", "title": "Codebase Graph", "icon": "grid", "entry": "panel.html" }',
      '    ]',
      '  }',
      '}',
      '```',
      '',
      'React plugins should build to static web assets. `panel.html` is the',
      'isolated entry document CrewCode loads; it can include a bundled React',
      'script such as `assets/index.js`. Plugin UI does not receive the trusted',
      '`window.electronAPI`; it will talk to CrewCode through a narrow plugin API.',
      '',
    ].join('\n'))
  }
  return root
}

function safeUnder(root: string, target: string): boolean {
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

function validateId(id: string, label: string): string {
  if (!ID_RE.test(id)) throw new Error(`${label} has invalid id "${id}"`)
  return id
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

function validateTabs(raw: unknown, pluginDir: string): PluginTabContribution[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('contributes.tabs must be an array')
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object') throw new Error(`contributes.tabs[${i}] must be an object`)
    const obj = item as Record<string, unknown>
    const entry = requireString(obj, 'entry')
    if (isAbsolute(entry)) throw new Error(`contributes.tabs[${i}].entry must be relative`)
    const entryPath = join(pluginDir, entry)
    if (!safeUnder(pluginDir, entryPath)) throw new Error(`contributes.tabs[${i}].entry escapes plugin folder`)
    const singleton = obj.singleton
    if (singleton !== undefined && typeof singleton !== 'boolean') throw new Error(`contributes.tabs[${i}].singleton must be boolean`)
    return {
      id: validateId(requireString(obj, 'id'), `contributes.tabs[${i}]`),
      title: requireString(obj, 'title'),
      icon: optionalString(obj, 'icon'),
      entry,
      singleton,
    }
  })
}

function validateManifest(raw: unknown, pluginDir: string): CrewCodePluginManifest {
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
    crewcode = {
      minVersion: optionalString(c, 'minVersion'),
      maxVersion: optionalString(c, 'maxVersion'),
      apiVersion: optionalString(c, 'apiVersion') ?? CREWCODE_PLUGIN_API_VERSION,
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
      tabs: validateTabs(c.tabs, pluginDir),
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

function emptyContributions(): PluginRegistrySnapshot['contributions'] {
  return { commands: [], tabs: [], sidebarPanels: [], statusItems: [], editorActions: [], chatActions: [], chatHeaderItems: [], mcpServers: [], agentProviders: [], gitLenses: [], missionWidgets: [], terminalWatchers: [], browserActions: [] }
}

function collectContributions(plugins: InstalledPlugin[], opts: { declared?: boolean } = {}): PluginRegistrySnapshot['contributions'] {
  const commands: RegisteredPluginCommand[] = []
  const tabs: RegisteredPluginTab[] = []
  const sidebarPanels: RegisteredPluginSidebarPanel[] = []
  const statusItems: RegisteredPluginStatusItem[] = []
  const editorActions: RegisteredPluginEditorAction[] = []
  const chatActions: RegisteredPluginChatAction[] = []
  const chatHeaderItems: RegisteredPluginChatHeaderItem[] = []
  const mcpServers: RegisteredPluginMcpServer[] = []
  const agentProviders: RegisteredPluginAgentProvider[] = []
  const gitLenses: RegisteredPluginGitLens[] = []
  const missionWidgets: RegisteredPluginMissionWidget[] = []
  const terminalWatchers: RegisteredPluginTerminalWatcher[] = []
  const browserActions: RegisteredPluginBrowserAction[] = []

  for (const plugin of plugins) {
    if (!opts.declared && (!plugin.enabled || !plugin.approved)) continue
    for (const command of plugin.manifest.contributes?.commands ?? []) {
      commands.push({
        ...command,
        pluginId: plugin.id,
        registrationId: `${plugin.id}:${command.id}`,
      })
    }
    for (const tab of plugin.manifest.contributes?.tabs ?? []) {
      tabs.push({
        ...tab,
        pluginId: plugin.id,
        registrationId: `${plugin.id}:${tab.id}`,
      })
    }
    for (const panel of plugin.manifest.contributes?.sidebarPanels ?? []) {
      sidebarPanels.push({
        ...panel,
        pluginId: plugin.id,
        registrationId: `${plugin.id}:${panel.id}`,
      })
    }
    for (const item of plugin.manifest.contributes?.statusItems ?? []) {
      statusItems.push({
        ...item,
        pluginId: plugin.id,
        registrationId: `${plugin.id}:${item.id}`,
      })
    }
    for (const action of plugin.manifest.contributes?.editorActions ?? []) {
      editorActions.push({
        ...action,
        pluginId: plugin.id,
        registrationId: `${plugin.id}:${action.id}`,
      })
    }
    for (const action of plugin.manifest.contributes?.chatActions ?? []) {
      chatActions.push({
        ...action,
        pluginId: plugin.id,
        registrationId: `${plugin.id}:${action.id}`,
      })
    }
    for (const item of plugin.manifest.contributes?.chatHeaderItems ?? []) {
      chatHeaderItems.push({
        ...item,
        pluginId: plugin.id,
        registrationId: `${plugin.id}:${item.id}`,
      })
    }
    if (opts.declared || (plugin.manifest.permissions ?? []).includes(requiredPermissionForPluginContribution('mcpServers'))) {
      for (const server of plugin.manifest.contributes?.mcpServers ?? []) {
        mcpServers.push({
          ...server,
          pluginId: plugin.id,
          registrationId: `${plugin.id}:${server.id}`,
          source: 'plugin',
        })
      }
    }
    if (opts.declared || (plugin.manifest.permissions ?? []).includes(requiredPermissionForPluginContribution('agentProviders'))) {
      for (const provider of plugin.manifest.contributes?.agentProviders ?? []) {
        agentProviders.push({
          ...provider,
          pluginId: plugin.id,
          registrationId: `${plugin.id}:${provider.id}`,
          source: 'plugin',
        })
      }
    }
    for (const lens of plugin.manifest.contributes?.gitLenses ?? []) gitLenses.push({ ...lens, pluginId: plugin.id, registrationId: `${plugin.id}:${lens.id}` })
    for (const widget of plugin.manifest.contributes?.missionWidgets ?? []) missionWidgets.push({ ...widget, pluginId: plugin.id, registrationId: `${plugin.id}:${widget.id}` })
    for (const watcher of plugin.manifest.contributes?.terminalWatchers ?? []) terminalWatchers.push({ ...watcher, pluginId: plugin.id, registrationId: `${plugin.id}:${watcher.id}` })
    for (const action of plugin.manifest.contributes?.browserActions ?? []) browserActions.push({ ...action, pluginId: plugin.id, registrationId: `${plugin.id}:${action.id}` })
  }

  return { commands, tabs, sidebarPanels, statusItems, editorActions, chatActions, chatHeaderItems, mcpServers, agentProviders, gitLenses, missionWidgets, terminalWatchers, browserActions }
}

export function loadPluginRegistry(): PluginRegistrySnapshot {
  const root = ensurePluginsDir()
  const plugins: InstalledPlugin[] = []
  const errors: PluginRegistryError[] = []

  let entries: string[] = []
  try { entries = readdirSync(root) }
  catch (err) {
    return {
      root,
      plugins,
      errors: [{ dirName: basename(root), path: root, error: (err as Error).message, category: 'manifest-validation' }],
      declaredContributions: emptyContributions(),
      contributions: emptyContributions()
    }
  }

  const approvals = readPluginApprovals()
  const gitSources = readPluginGitSources(crewcodeDir())

  for (const dirName of entries) {
    // Installer staging folders are intentionally invisible until their final
    // atomic rename makes the complete plugin available.
    if (dirName.startsWith('.')) continue
    const pluginPath = join(root, dirName)
    try {
      const st = statSync(pluginPath)
      if (!st.isDirectory()) continue
      const manifestPath = join(pluginPath, CREWCODE_PLUGIN_MANIFEST)
      if (!existsSync(manifestPath)) continue
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const manifest = validatePluginManifest(raw, pluginPath)
      const permissionFingerprint = pluginPermissionFingerprint(manifest.permissions)
      const approval = approvals[manifest.id]
      const approved = approval?.approved === true && approval.permissionFingerprint === permissionFingerprint
      const approvalState = approved
        ? 'approved'
        : approval?.approved === false
          ? 'revoked'
          : approval?.permissionFingerprint && approval.permissionFingerprint !== permissionFingerprint
            ? 'permissions-changed'
            : 'needs-approval'
      plugins.push({
        id: manifest.id,
        dirName,
        path: pluginPath,
        manifest,
        enabled: manifest.enabled !== false,
        approved,
        approvalState,
        permissionFingerprint,
        approvedPermissionFingerprint: approval?.permissionFingerprint,
        source: gitSources[manifest.id],
      })
    } catch (err) {
      errors.push({ dirName, path: pluginPath, error: (err as Error).message, category: 'manifest-validation' })
    }
  }

  plugins.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
  errors.sort((a, b) => a.dirName.localeCompare(b.dirName))
  return { root, plugins, errors, declaredContributions: collectContributions(plugins, { declared: true }), contributions: collectContributions(plugins) }
}

function findPluginForRegistration(registrationId: string): InstalledPlugin | null {
  if (!registrationId) return null
  const registry = loadPluginRegistry()
  return registry.plugins.find(p => p.enabled && p.approved && registrationId.startsWith(`${p.id}:`)) ?? null
}

function pluginResolveUnavailableReason(registrationId: string, plugins: InstalledPlugin[]): string | null {
  const pluginId = registrationId.split(':')[0]
  const plugin = plugins.find(p => p.id === pluginId)
  if (!plugin) return `plugin "${pluginId}" is not installed`
  if (!plugin.enabled) return `plugin "${pluginId}" is disabled`
  if (!plugin.approved) {
    const reason = plugin.approvalState === 'permissions-changed'
      ? 'permissions changed and need approval'
      : plugin.approvalState === 'revoked'
        ? 'approval was revoked'
        : 'approval is required'
    return `plugin "${pluginId}" ${reason}`
  }
  return null
}

function resolvePluginTab(registrationId: string) {
  if (!registrationId) return { ok: false, error: 'registration id required' }
  const registry = loadPluginRegistry()
  const unavailable = pluginResolveUnavailableReason(registrationId, registry.plugins)
  if (unavailable) return { ok: false, error: unavailable }
  const plugin = findPluginForRegistration(registrationId)
  if (!plugin) return { ok: false, error: 'plugin registration is unavailable' }
  const tab = [
    ...(plugin.manifest.contributes?.tabs ?? []),
    ...(plugin.manifest.contributes?.sidebarPanels ?? []),
  ].find(t => `${plugin.id}:${t.id}` === registrationId)
  if (!tab) return { ok: false, error: 'plugin panel not found' }

  const entryPath = join(plugin.path, tab.entry)
  if (!safeUnder(plugin.path, entryPath)) return { ok: false, error: 'plugin entry escapes plugin folder' }
  if (!existsSync(entryPath)) {
    recordPluginDebug({ pluginId: plugin.id, registrationId, method: 'runtime:error', ok: false, category: 'asset-load', error: 'plugin entry missing' })
    return { ok: false, error: 'plugin entry missing' }
  }

  return {
    ok: true,
    pluginId: plugin.id,
    registrationId,
    title: tab.title,
    url: `${PLUGIN_PROTOCOL}://${plugin.id}/${encodeURI(tab.entry)}`,
    permissions: plugin.manifest.permissions ?? [],
  }
}

function hasPermission(plugin: InstalledPlugin, permission: PluginPermission): boolean {
  return (plugin.manifest.permissions ?? []).includes(permission)
}

function readWorkspaceFile(root: string, sub: string): PluginInvokeResult {
  // Remote filesystem support will be routed through the SSH backend in a later
  // plugin API revision; v0 denies it instead of pretending local paths work.
  if (isRemoteRoot(root)) return { ok: false, error: 'remote workspaces are not supported by plugin API v0' }
  if (!root || !isAbsolute(root)) return { ok: false, error: 'absolute workspace root required' }
  const target = join(root, sub)
  if (!safeUnder(root, target)) return { ok: false, error: 'path escapes workspace' }
  if (!existsSync(target)) return { ok: false, error: 'file missing' }
  const st = statSync(target)
  if (st.isDirectory()) return { ok: false, error: 'is a directory' }
  if (st.size > MAX_FILE_BYTES) return { ok: false, error: 'file too large (>2MB)' }
  return { ok: true, result: { text: readFileSync(target, 'utf8'), rel: sub, size: st.size } }
}

function writeWorkspaceFile(root: string, sub: string, text: string): PluginInvokeResult {
  if (isRemoteRoot(root)) return { ok: false, error: 'remote workspaces are not supported by plugin API v0' }
  if (!root || !isAbsolute(root)) return { ok: false, error: 'absolute workspace root required' }
  const target = join(root, sub)
  if (!safeUnder(root, target)) return { ok: false, error: 'path escapes workspace' }
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
  if (isRemoteRoot(root)) return { ok: false, error: 'remote workspaces are not supported by plugin API v0' }
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

export function recordPluginDebug(entry: Omit<PluginAuditEntry, 'id' | 'at'>): void {
  pluginAuditLog.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    at: Date.now(),
    ...entry,
  })
  if (pluginAuditLog.length > PLUGIN_AUDIT_LIMIT) pluginAuditLog.length = PLUGIN_AUDIT_LIMIT
}

function pushPluginAudit(request: unknown, result: PluginInvokeResult): void {
  if (!request || typeof request !== 'object') return
  const req = request as PluginInvokeRequest
  if (!req.registrationId || !req.method) return
  const pluginId = req.registrationId.split(':')[0] || 'unknown'
  recordPluginDebug({
    pluginId,
    registrationId: req.registrationId,
    method: req.method,
    ok: result.ok,
    category: result.ok ? 'capability-denial' : 'capability-denial',
    error: result.ok ? undefined : result.error,
    workspaceRoot: req.workspaceRoot,
  })
}

function invokePluginCapability(request: unknown): PluginInvokeResult {
  if (!request || typeof request !== 'object') return { ok: false, error: 'invalid plugin request' }
  const result = invokePluginCapabilityWithPlugins(request, loadPluginRegistry().plugins)
  pushPluginAudit(request, result)
  return result
}

function listPluginAudit(): PluginAuditEntry[] {
  return pluginAuditLog.slice(0, 100)
}

function pluginWatchPaths(root: string): string[] {
  const paths = [root]
  const skip = new Set(['.git', 'node_modules', '.cache', '.turbo'])
  const walk = (dir: string) => {
    if (paths.length >= 500) return
    try {
      for (const name of readdirSync(dir)) {
        if (skip.has(name)) continue
        const child = join(dir, name)
        if (!statSync(child).isDirectory()) continue
        paths.push(child)
        walk(child)
      }
    } catch {
      // Watch setup is best-effort; manual refresh still works if fs.watch fails.
    }
  }
  walk(root)
  return paths
}

function broadcastPluginRegistryChanged(reason: 'watch' | 'manual' = 'watch'): PluginRegistrySnapshot {
  const registry = loadPluginRegistry()
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('plugins:changed', { at: Date.now(), reason, registry })
  })
  return registry
}

function startPluginWatcher(): { ok: boolean; registry: PluginRegistrySnapshot; error?: string } {
  const registry = loadPluginRegistry()
  const paths = pluginWatchPaths(registry.root)
  const signature = paths.join('\n')
  if (pluginWatchers.length > 0 && signature === pluginWatchSignature) return { ok: true, registry }

  for (const watcher of pluginWatchers) watcher.close()
  pluginWatchers = []
  pluginWatchSignature = signature

  try {
    pluginWatchers = paths.map(path => watch(path, { persistent: false }, () => {
      if (pluginWatchDebounce) clearTimeout(pluginWatchDebounce)
      pluginWatchDebounce = setTimeout(() => {
        const next = broadcastPluginRegistryChanged('watch')
        const nextSignature = pluginWatchPaths(next.root).join('\n')
        if (nextSignature !== pluginWatchSignature) void startPluginWatcher()
      }, 250)
    }))
    return { ok: true, registry }
  } catch (err) {
    for (const watcher of pluginWatchers) watcher.close()
    pluginWatchers = []
    return { ok: false, registry, error: (err as Error).message }
  }
}

function copyExamplePlugin(exampleId = 'codebase-graph-lite'): PluginCopyExampleResult {
  const allowed = new Set([
    'static-panel-template',
    'typescript-panel-template',
    'mock-agent-provider',
    'company-agent-http-adapter',
    'openai-compatible-provider',
    'mcp-server-template',
    'browser-docs-grabber',
    'git-risk-lens',
    'codebase-graph-lite',
  ])
  if (!allowed.has(exampleId)) return { ok: false, error: 'unknown example plugin' }

  const candidates = [
    join(process.cwd(), 'examples', 'plugins', exampleId),
    join(app.getAppPath(), 'examples', 'plugins', exampleId),
    join(process.resourcesPath, 'examples', 'plugins', exampleId),
  ]
  const source = candidates.find(candidate => existsSync(join(candidate, CREWCODE_PLUGIN_MANIFEST)))
  if (!source) return { ok: false, error: 'example plugin source missing' }

  const root = ensurePluginsDir()
  const dest = join(root, exampleId)
  if (existsSync(dest)) return { ok: false, error: `plugin already exists at ${dest}` }

  try {
    cpSync(source, dest, { recursive: true })
    const registry = broadcastPluginRegistryChanged('manual')
    void startPluginWatcher()
    return { ok: true, path: dest, registry }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

function setPluginApproval(pluginId: string, approved: boolean): PluginApprovalResult {
  const registry = loadPluginRegistry()
  const plugin = registry.plugins.find(p => p.id === pluginId)
  if (!plugin) return { ok: false, error: 'plugin not found' }
  const approvals = readPluginApprovals()
  approvals[pluginId] = approved
    ? { approved: true, permissionFingerprint: plugin.permissionFingerprint, approvedAt: Date.now() }
    : { approved: false, permissionFingerprint: plugin.permissionFingerprint, revokedAt: Date.now() }
  writePluginApprovals(approvals)
  return { ok: true, registry: loadPluginRegistry() }
}

async function inspectGitPlugin(request: PluginGitInspectRequest): Promise<PluginGitInspectResult> {
  try {
    if (!request || typeof request !== 'object') return { ok: false, error: 'invalid plugin repository request' }
    const registry = loadPluginRegistry()
    let repositoryUrl: string
    let expectedPluginId: string | undefined
    if ('pluginId' in request) {
      if (typeof request.pluginId !== 'string' || !request.pluginId.trim()) return { ok: false, error: 'plugin id is required' }
      const plugin = registry.plugins.find(item => item.id === request.pluginId)
      if (!plugin) return { ok: false, error: 'plugin not found' }
      if (!plugin.source) return { ok: false, error: 'plugin was not installed from a Git repository' }
      repositoryUrl = plugin.source.repositoryUrl
      expectedPluginId = plugin.id
    } else {
      if (typeof request.repositoryUrl !== 'string') return { ok: false, error: 'repository URL is required' }
      repositoryUrl = request.repositoryUrl
    }
    const candidate = await inspectPluginGitRepository(repositoryUrl, registry.plugins, expectedPluginId)
    return { ok: true, candidate }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

function installInspectedGitPlugin(token: string): PluginGitInstallResult {
  try {
    const result = commitPluginGitInstall(token, crewcodeDir(), ensurePluginsDir(), pluginId => {
      // New code always crosses the approval boundary again, even when an
      // update requests the same permissions as the approved revision.
      const approvals = readPluginApprovals()
      delete approvals[pluginId]
      writePluginApprovals(approvals)
    })
    const registry = broadcastPluginRegistryChanged('manual')
    void startPluginWatcher()
    return { ok: true, pluginId: result.pluginId, backupPath: result.backupPath, registry }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

function pluginById(pluginId: string): InstalledPlugin | null {
  return loadPluginRegistry().plugins.find(p => p.id === pluginId) ?? null
}

function setPluginEnabled(pluginId: string, enabled: boolean) {
  const registry = loadPluginRegistry()
  const plugin = registry.plugins.find(p => p.id === pluginId)
  if (!plugin) return { ok: false, error: 'plugin not found' }
  try {
    const manifestPath = join(plugin.path, CREWCODE_PLUGIN_MANIFEST)
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    raw.enabled = enabled
    writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    return { ok: true, registry: loadPluginRegistry() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export function registerPluginProtocol(): void {
  protocol.handle(PLUGIN_PROTOCOL, (request) => {
    try {
      const url = new URL(request.url)
      const pluginId = decodeURIComponent(url.hostname)
      const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const registry = loadPluginRegistry()
      const plugin = registry.plugins.find(p => p.enabled && p.approved && p.id === pluginId)
      if (!plugin) return new Response('plugin missing or disabled', { status: 404 })
      const asset = resolvePluginAssetTarget(plugin, rel)
      if (!asset.ok) return new Response(asset.error, { status: asset.status })
      return new Response(readFileSync(asset.target), { headers: asset.headers })
    } catch (err) {
      return new Response((err as Error).message, { status: 500 })
    }
  })
}

export function registerPluginIpc(): void {
  ipcMain.handle('plugins:list', () => loadPluginRegistry())
  ipcMain.handle('plugins:watch', () => startPluginWatcher())
  ipcMain.handle('plugins:refresh', () => broadcastPluginRegistryChanged('manual'))
  ipcMain.handle('plugins:copyExample', (_e, exampleId?: string) => copyExamplePlugin(exampleId))
  ipcMain.handle('plugins:inspectGit', (_e, request: PluginGitInspectRequest) => inspectGitPlugin(request))
  ipcMain.handle('plugins:installGit', (_e, token: string) => installInspectedGitPlugin(token))
  ipcMain.handle('plugins:resolveTab', (_e, registrationId: string) => resolvePluginTab(registrationId))
  ipcMain.handle('plugins:invoke', (_e, request: unknown) => invokePluginCapability(request))
  ipcMain.handle('plugins:audit', () => listPluginAudit())
  ipcMain.handle('plugins:setApproval', (_e, pluginId: string, approved: boolean) => setPluginApproval(pluginId, approved))
  ipcMain.handle('plugins:setEnabled', (_e, pluginId: string, enabled: boolean) => setPluginEnabled(pluginId, enabled))
  ipcMain.handle('plugins:recordRuntimeError', (_e, pluginId: string, registrationId: string, message: string) => {
    recordPluginDebug({ pluginId, registrationId, method: 'runtime:error', ok: false, category: 'runtime-iframe', error: message })
    return { ok: true }
  })

  ipcMain.handle('plugins:openDir', () => {
    const root = ensurePluginsDir()
    // Revealing the README avoids Linux setups where openPath(directory)
    // launches a terminal because of the user's directory MIME association.
    shell.showItemInFolder(join(root, 'README.md'))
    return { ok: true, path: root }
  })

  ipcMain.handle('plugins:openPluginDir', (_e, pluginId: string) => {
    const plugin = pluginById(pluginId)
    if (!plugin) return { ok: false, error: 'plugin not found' }
    shell.showItemInFolder(join(plugin.path, CREWCODE_PLUGIN_MANIFEST))
    return { ok: true, path: plugin.path }
  })

  ipcMain.handle('plugins:openManifest', (_e, pluginId: string) => {
    const plugin = pluginById(pluginId)
    if (!plugin) return { ok: false, error: 'plugin not found' }
    const manifestPath = join(plugin.path, CREWCODE_PLUGIN_MANIFEST)
    shell.openPath(manifestPath).catch(() => shell.showItemInFolder(manifestPath))
    return { ok: true, path: manifestPath }
  })
}

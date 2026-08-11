// Shared v0 plugin contracts. Keep this checked TypeScript (not .d.ts) so
// main, preload, and renderer agree on the same manifest shape.

export const CREWCODE_PLUGIN_MANIFEST = 'crewcode.plugin.json'
export const CREWCODE_PLUGIN_API_VERSION = '0.1'

// The exact sandbox token set for plugin iframes. `allow-same-origin` grants the
// frame ONLY its own crewcode-plugin://<pluginId> origin (a distinct standard
// scheme, cross-origin to the app renderer and to every other plugin), which it
// needs to load its own assets — it cannot reach `parent`. Deliberately WITHOUT
// allow-top-navigation, allow-popups, allow-modals, or allow-same-origin-to-parent.
// Guarded by security-boundary-proof.test.ts so it cannot silently gain tokens.
export const PLUGIN_IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms'

export type PluginPermission =
  | 'workspace:read'
  | 'workspace:write'
  | 'git:read'
  | 'git:write'
  | 'terminal:spawn'
  | 'terminal:read'
  | 'agent:prompt'
  | 'agent:provider'
  | 'browser:read'
  | 'mcp:server'
  | 'network:fetch'
  | 'secrets:read'

export interface PluginCommandContribution {
  id: string
  title: string
  icon?: string
  group?: string
  when?: string
}

export interface PluginActionTargetContribution {
  id: string
  title: string
  icon?: string
  command?: string
  tab?: string
  sidebarPanel?: string
  when?: string
}

export interface PluginStatusItemContribution extends PluginActionTargetContribution {
  text?: string
}

export interface PluginEditorActionContribution extends PluginActionTargetContribution {
  filePattern?: string
}

export interface PluginChatActionContribution extends PluginActionTargetContribution {
  messageRole?: 'user' | 'agent' | 'any'
}

export interface PluginChatHeaderItemContribution extends PluginActionTargetContribution {
  text?: string
}

export interface PluginGitLensContribution extends PluginActionTargetContribution {
  placement?: 'sidebar' | 'diff'
}

export interface PluginMissionWidgetContribution extends PluginActionTargetContribution {
  text?: string
}

export interface PluginTerminalWatcherContribution extends PluginActionTargetContribution {
  mode?: 'opt-in'
}

export interface PluginBrowserActionContribution extends PluginActionTargetContribution {
  browserContext?: 'url' | 'selection'
}

export interface PluginPanelContribution {
  id: string
  title: string
  icon?: string
  entry: string
  singleton?: boolean
}

export interface PluginMcpServerContribution {
  id: string
  title: string
  command: string
  args?: string[]
  category?: string
  description?: string
  when?: string
}

export type PluginAgentProviderRuntime =
  | 'mock'
  | 'exec'
  | 'http'
  | 'sse-http'
  | 'openai-compatible'
  | 'stdio-jsonrpc'
  | 'websocket'

export interface PluginAgentProviderContribution {
  id: string
  title: string
  runtime: PluginAgentProviderRuntime
  description?: string
  models?: string[]
  command?: string
  args?: string[]
  endpoint?: string
  apiKeyEnv?: string
  timeoutMs?: number
  maxOutputBytes?: number
  requestFormat?: 'crewcode' | 'openai-chat'
  responsePath?: string
  when?: string
}

export type PluginTabContribution = PluginPanelContribution
export type PluginSidebarPanelContribution = PluginPanelContribution

export interface PluginContributions {
  commands?: PluginCommandContribution[]
  tabs?: PluginTabContribution[]
  sidebarPanels?: PluginSidebarPanelContribution[]
  statusItems?: PluginStatusItemContribution[]
  editorActions?: PluginEditorActionContribution[]
  chatActions?: PluginChatActionContribution[]
  chatHeaderItems?: PluginChatHeaderItemContribution[]
  mcpServers?: PluginMcpServerContribution[]
  agentProviders?: PluginAgentProviderContribution[]
  gitLenses?: PluginGitLensContribution[]
  missionWidgets?: PluginMissionWidgetContribution[]
  terminalWatchers?: PluginTerminalWatcherContribution[]
  browserActions?: PluginBrowserActionContribution[]
}

export interface PluginCompatibility {
  minVersion?: string
  maxVersion?: string
  apiVersion?: string
}

export interface CrewCodePluginManifest {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  enabled?: boolean
  crewcode?: PluginCompatibility
  permissions?: PluginPermission[]
  contributes?: PluginContributions
}

export type PluginApprovalState = 'approved' | 'needs-approval' | 'permissions-changed' | 'revoked'

export interface PluginGitSource {
  repositoryUrl: string
  revision: string
  installedAt: number
  updatedAt: number
}

export interface InstalledPlugin {
  id: string
  dirName: string
  path: string
  manifest: CrewCodePluginManifest
  enabled: boolean
  approved: boolean
  approvalState: PluginApprovalState
  permissionFingerprint: string
  approvedPermissionFingerprint?: string
  source?: PluginGitSource
}

export interface RegisteredPluginCommand extends PluginCommandContribution {
  pluginId: string
  registrationId: string
}

export interface RegisteredPluginTab extends PluginTabContribution {
  pluginId: string
  registrationId: string
}

export interface RegisteredPluginSidebarPanel extends PluginSidebarPanelContribution {
  pluginId: string
  registrationId: string
}

export interface RegisteredPluginStatusItem extends PluginStatusItemContribution {
  pluginId: string
  registrationId: string
}

export interface RegisteredPluginEditorAction extends PluginEditorActionContribution {
  pluginId: string
  registrationId: string
}

export interface RegisteredPluginChatAction extends PluginChatActionContribution {
  pluginId: string
  registrationId: string
}

export interface RegisteredPluginChatHeaderItem extends PluginChatHeaderItemContribution {
  pluginId: string
  registrationId: string
}

export interface RegisteredPluginMcpServer extends PluginMcpServerContribution {
  pluginId: string
  registrationId: string
  source: 'plugin'
}

export interface RegisteredPluginAgentProvider extends PluginAgentProviderContribution {
  pluginId: string
  registrationId: string
  source: 'plugin'
}

export interface RegisteredPluginGitLens extends PluginGitLensContribution {
  pluginId: string
  registrationId: string
}

export interface RegisteredPluginMissionWidget extends PluginMissionWidgetContribution {
  pluginId: string
  registrationId: string
}

export interface RegisteredPluginTerminalWatcher extends PluginTerminalWatcherContribution {
  pluginId: string
  registrationId: string
}

export interface RegisteredPluginBrowserAction extends PluginBrowserActionContribution {
  pluginId: string
  registrationId: string
}

export interface PluginContributionRegistry {
  commands: RegisteredPluginCommand[]
  tabs: RegisteredPluginTab[]
  sidebarPanels: RegisteredPluginSidebarPanel[]
  statusItems: RegisteredPluginStatusItem[]
  editorActions: RegisteredPluginEditorAction[]
  chatActions: RegisteredPluginChatAction[]
  chatHeaderItems: RegisteredPluginChatHeaderItem[]
  mcpServers: RegisteredPluginMcpServer[]
  agentProviders: RegisteredPluginAgentProvider[]
  gitLenses: RegisteredPluginGitLens[]
  missionWidgets: RegisteredPluginMissionWidget[]
  terminalWatchers: RegisteredPluginTerminalWatcher[]
  browserActions: RegisteredPluginBrowserAction[]
}

export type PluginDebugCategory =
  | 'manifest-validation'
  | 'asset-load'
  | 'runtime-iframe'
  | 'capability-denial'
  | 'provider-spawn'
  | 'provider-http'
  | 'provider-success'

export interface PluginRegistryError {
  dirName: string
  path: string
  error: string
  category: PluginDebugCategory
}

export type PluginPermissionRisk = 'low' | 'medium' | 'high'

export interface PluginPermissionInfo {
  permission: PluginPermission
  label: string
  description: string
  risk: PluginPermissionRisk
}

export interface PluginAuditEntry {
  id: string
  at: number
  pluginId: string
  registrationId: string
  method: PluginInvokeMethod | 'runtime:error' | `provider:${PluginAgentProviderRuntime}`
  ok: boolean
  category: PluginDebugCategory
  error?: string
  workspaceRoot?: string
}

export interface PluginRegistrySnapshot {
  root: string
  plugins: InstalledPlugin[]
  errors: PluginRegistryError[]
  /** Contributions declared in manifests, before approval/enablement gates. */
  declaredContributions: PluginContributionRegistry
  /** Contributions currently active after global approval/enablement gates. */
  contributions: PluginContributionRegistry
}

export interface PluginRegistryChangedEvent {
  at: number
  reason: 'watch' | 'manual'
  registry: PluginRegistrySnapshot
}

export type PluginCopyExampleResult =
  | { ok: true; path: string; registry: PluginRegistrySnapshot }
  | { ok: false; error: string }

export type PluginSetEnabledResult =
  | { ok: true; registry: PluginRegistrySnapshot }
  | { ok: false; error: string }

export type PluginApprovalResult =
  | { ok: true; registry: PluginRegistrySnapshot }
  | { ok: false; error: string }

export interface PluginGitCandidate {
  token: string
  id: string
  name: string
  version: string
  description?: string
  author?: string
  repositoryUrl: string
  revision: string
  permissions: PluginPermission[]
  mode: 'install' | 'update'
  currentVersion?: string
  currentRevision?: string
  permissionsChanged: boolean
  updateAvailable: boolean
  fileCount: number
  totalBytes: number
}

export type PluginGitInspectRequest =
  | { repositoryUrl: string; pluginId?: never }
  | { pluginId: string; repositoryUrl?: never }

export type PluginGitInspectResult =
  | { ok: true; candidate: PluginGitCandidate }
  | { ok: false; error: string }

export type PluginGitInstallResult =
  | { ok: true; pluginId: string; backupPath?: string; registry: PluginRegistrySnapshot }
  | { ok: false; error: string }

export interface ResolvedPluginTab {
  ok: true
  pluginId: string
  registrationId: string
  title: string
  url: string
  permissions: PluginPermission[]
}

export interface PluginResolveError {
  ok: false
  error: string
}

export type PluginResolveTabResult = ResolvedPluginTab | PluginResolveError

export type PluginInvokeMethod =
  | 'workspace:listFiles'
  | 'workspace:readFile'
  | 'workspace:writeFile'
  | 'network:fetch'
  | 'secrets:get'

export interface PluginOpenContext {
  source:
    | 'command-palette'
    | 'plugin-menu'
    | 'status-item'
    | 'chat-action'
    | 'chat-header'
    | 'editor-action'
    | 'git-lens'
    | 'mission-widget'
    | 'terminal-watcher'
    | 'browser-action'
    | 'sidebar-panel'
    | 'restored-tab'
  filePath?: string
  browserUrl?: string
  terminalPaneId?: string
  chatMessageId?: string
}

export interface PluginInvokeRequest {
  registrationId: string
  method: PluginInvokeMethod
  workspaceRoot?: string
  params?: Record<string, unknown>
}

export type PluginInvokeResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string }

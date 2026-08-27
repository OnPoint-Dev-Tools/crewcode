import { randomBytes } from 'crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { basename, extname, join, normalize, sep } from 'path'
import os from 'os'
import { CREWCODE_PLUGIN_MANIFEST, type InstalledPlugin, type PluginInvokeRequest, type PluginRegistrySnapshot } from '../shared/plugin-types'
import { invokePluginCapabilityWithPlugins, pluginPermissionFingerprint, validatePluginManifest } from './plugin-contract'

const EMPTY = (): PluginRegistrySnapshot['contributions'] => ({ commands: [], tabs: [], sidebarPanels: [], statusItems: [], editorActions: [], chatActions: [], chatHeaderItems: [], mcpServers: [], agentProviders: [], gitLenses: [], missionWidgets: [], terminalWatchers: [], browserActions: [] })
type AssetGrant = { plugin: InstalledPlugin; expiresAt: number }
export class RemotePluginService {
  private grants = new Map<string, AssetGrant>()
  load(): PluginRegistrySnapshot {
    const root = join(os.homedir(), '.crewcode', 'plugins'); const plugins: InstalledPlugin[] = []; const errors: PluginRegistrySnapshot['errors'] = []
    let approvals: Record<string, { approved?: boolean; permissionFingerprint?: string }> = {}
    try { approvals = JSON.parse(readFileSync(join(os.homedir(), '.crewcode', 'plugin-approvals.json'), 'utf8')) } catch {}
    for (const dirName of existsSync(root) ? readdirSync(root) : []) { if (dirName.startsWith('.')) continue; const path = join(root, dirName); try { if (!statSync(path).isDirectory()) continue; const raw = JSON.parse(readFileSync(join(path, CREWCODE_PLUGIN_MANIFEST), 'utf8')); const manifest = validatePluginManifest(raw, path); const fingerprint = pluginPermissionFingerprint(manifest.permissions); const approval = approvals[manifest.id]; const approved = approval?.approved === true && approval.permissionFingerprint === fingerprint; plugins.push({ id: manifest.id, dirName, path, manifest, enabled: manifest.enabled !== false, approved, approvalState: approved ? 'approved' : 'needs-approval', permissionFingerprint: fingerprint }) } catch (error) { errors.push({ dirName, path, error: error instanceof Error ? error.message : String(error), category: 'manifest-validation' }) } }
    const contributions = EMPTY(); const declaredContributions = EMPTY()
    for (const plugin of plugins) for (const tab of plugin.manifest.contributes?.tabs ?? []) { const row = { ...tab, pluginId: plugin.id, registrationId: `${plugin.id}:${tab.id}` }; declaredContributions.tabs.push(row); if (plugin.enabled && plugin.approved) contributions.tabs.push(row) }
    return { root, plugins, errors, contributions, declaredContributions }
  }
  resolve(registrationId: string): { ok: boolean; error?: string; pluginId?: string; registrationId?: string; title?: string; url?: string; permissions?: InstalledPlugin['manifest']['permissions'] } { const plugin = this.load().plugins.find(item => item.enabled && item.approved && registrationId.startsWith(`${item.id}:`)); const tab = plugin?.manifest.contributes?.tabs?.find(item => `${plugin.id}:${item.id}` === registrationId); if (!plugin || !tab) return { ok: false, error: 'approved plugin panel not found' }; const token = randomBytes(24).toString('hex'); this.grants.set(token, { plugin, expiresAt: Date.now() + 60 * 60_000 }); return { ok: true, pluginId: plugin.id, registrationId, title: tab.title, url: `/api/v1/plugin-assets/${token}/${encodeURI(tab.entry)}`, permissions: plugin.manifest.permissions ?? [] } }
  invoke(request: PluginInvokeRequest, registeredRoot: (value: string) => string) { const workspaceRoot = request.workspaceRoot ? registeredRoot(request.workspaceRoot) : undefined; return invokePluginCapabilityWithPlugins({ ...request, workspaceRoot }, this.load().plugins) }
  asset(token: string, rel: string): { body: Buffer; contentType: string } | null { const grant = this.grants.get(token); if (!grant || grant.expiresAt < Date.now()) { this.grants.delete(token); return null } const root = normalize(grant.plugin.path); const target = normalize(join(root, decodeURIComponent(rel))); if (!target.startsWith(root + sep) || !existsSync(target) || !statSync(target).isFile()) return null; const mime: Record<string,string> = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json' }; let body = readFileSync(target); if (extname(target) === '.html') body = Buffer.from(body.toString('utf8').replace(/<head([^>]*)>/i, `<head$1><base href="/api/v1/plugin-assets/${token}/">`)); return { body, contentType: mime[extname(target)] ?? 'application/octet-stream' } }
}

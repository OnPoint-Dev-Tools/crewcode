import { useCallback, useEffect, useMemo, useState } from 'react'

import type { InstalledPlugin, PluginAuditEntry, PluginGitCandidate, PluginPermission, PluginRegistrySnapshot } from '../../../../shared/plugin-types'
import type { SetSetting, SettingsState } from '../../hooks/useSettings'
import type { Workspace } from '../../types'
import { pluginPermissionInfo } from '../../../../shared/plugin-permissions'
import { Icon } from '../ui/Icon'

function countContributions(plugin: InstalledPlugin) {
  const contributes = plugin.manifest.contributes
  return {
    tabs: contributes?.tabs?.length ?? 0,
    commands: contributes?.commands?.length ?? 0,
    mcpServers: contributes?.mcpServers?.length ?? 0,
    agentProviders: contributes?.agentProviders?.length ?? 0,
  }
}

function approvalLabel(plugin: InstalledPlugin): string {
  if (plugin.approved) return 'approved'
  if (plugin.approvalState === 'permissions-changed') return 'permissions changed'
  if (plugin.approvalState === 'revoked') return 'revoked'
  return 'needs approval'
}

function PluginDebugDropdown({ plugin, logs }: { plugin: InstalledPlugin; logs: PluginAuditEntry[] }) {
  return (
    <details className="plugin-debug-dropdown">
      <summary>
        <span><Icon name="terminal" size={12} />debug log</span>
        <span className="plugin-debug-count">{logs.length} event{logs.length === 1 ? '' : 's'}</span>
      </summary>
      <div className="plugin-debug-body">
        {logs.length === 0 ? (
          <div className="plugin-debug-empty">No runtime, capability, or provider events recorded for {plugin.manifest.name} yet.</div>
        ) : logs.slice(0, 8).map(entry => (
          <div key={entry.id} className={`plugin-debug-line ${entry.ok ? '' : 'bad'}`}>
            <span className="plugin-debug-time">{new Date(entry.at).toLocaleTimeString()}</span>
            <span className="plugin-debug-category">{entry.category}</span>
            <span className="plugin-debug-method">{entry.method}</span>
            <span className="plugin-debug-message">{entry.ok ? 'ok' : (entry.error ?? 'error')}</span>
          </div>
        ))}
      </div>
    </details>
  )
}

interface PluginsPageProps {
  workspaces: Workspace[]
  activeWorkspaceId: string
  pluginWorkspaceEnabled: SettingsState['pluginWorkspaceEnabled']
  setSetting: SetSetting
}

export function PluginsPage({ workspaces, activeWorkspaceId, pluginWorkspaceEnabled, setSetting }: PluginsPageProps) {
  const [registry, setRegistry] = useState<PluginRegistrySnapshot | null>(null)
  const [audit, setAudit] = useState<PluginAuditEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [installOpen, setInstallOpen] = useState(false)
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [candidate, setCandidate] = useState<PluginGitCandidate | null>(null)
  const [installBusy, setInstallBusy] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installNotice, setInstallNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [next, auditNext] = await Promise.all([
        window.electronAPI?.pluginsRefresh?.() ?? window.electronAPI?.pluginsList(),
        window.electronAPI?.pluginsAudit?.(),
      ])
      if (next) {
        setRegistry(next)
        setAudit(auditNext ?? [])
        setError(null)
      } else {
        setError('plugin API unavailable')
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const off = window.electronAPI?.onPluginsChanged?.((event) => {
      setRegistry(event.registry)
      void window.electronAPI?.pluginsAudit?.().then(next => setAudit(next ?? []))
    })
    return () => off?.()
  }, [])

  const setEnabled = async (pluginId: string, enabled: boolean) => {
    const result = await window.electronAPI?.pluginsSetEnabled(pluginId, enabled)
    if (result?.ok) {
      setRegistry(result.registry)
      setError(null)
    } else {
      setError(result?.error ?? 'failed to update plugin')
    }
  }

  const setApproval = async (pluginId: string, approved: boolean) => {
    const result = await window.electronAPI?.pluginsSetApproval?.(pluginId, approved)
    if (result?.ok) {
      setRegistry(result.registry)
      setError(null)
    } else {
      setError(result?.error ?? 'failed to update plugin approval')
    }
  }

  const inspectRepository = async (pluginId?: string) => {
    setInstallOpen(true)
    setCandidate(null)
    setInstallError(null)
    setInstallNotice(null)
    setInstallBusy(true)
    try {
      const result = await window.electronAPI?.pluginsInspectGit(
        pluginId ? { pluginId } : { repositoryUrl: repositoryUrl.trim() },
      )
      if (!result?.ok) {
        setInstallError(result?.error ?? 'failed to inspect repository')
        return
      }
      setCandidate(result.candidate)
      setRepositoryUrl(result.candidate.repositoryUrl)
    } catch (err) {
      setInstallError((err as Error).message)
    } finally {
      setInstallBusy(false)
    }
  }

  const installCandidate = async () => {
    if (!candidate) return
    setInstallBusy(true)
    setInstallError(null)
    try {
      const result = await window.electronAPI?.pluginsInstallGit(candidate.token)
      if (!result?.ok) {
        setInstallError(result?.error ?? 'failed to install plugin')
        return
      }
      setRegistry(result.registry)
      setCandidate(null)
      setRepositoryUrl('')
      setInstallOpen(false)
      setInstallNotice(`${candidate.name} ${candidate.mode === 'update' ? 'updated' : 'installed'} at ${candidate.revision.slice(0, 8)}. Review its permissions and approve it before use.`)
    } catch (err) {
      setInstallError((err as Error).message)
    } finally {
      setInstallBusy(false)
    }
  }

  const closeInstaller = () => {
    if (installBusy) return
    setInstallOpen(false)
    setCandidate(null)
    setRepositoryUrl('')
    setInstallError(null)
  }

  const pluginCount = registry?.plugins.length ?? 0
  const commandCount = registry?.contributions.commands.length ?? 0
  const tabCount = registry?.contributions.tabs.length ?? 0
  const mcpCount = registry?.contributions.mcpServers.length ?? 0
  const agentProviderCount = registry?.contributions.agentProviders.length ?? 0
  const deniedCount = audit.filter(entry => !entry.ok).length
  const activeWorkspace = workspaces.find(workspace => workspace.id === activeWorkspaceId) ?? null
  const workspacePluginState = activeWorkspace ? (pluginWorkspaceEnabled[activeWorkspace.id] ?? {}) : {}
  const setWorkspacePluginEnabled = (pluginId: string, enabled: boolean) => {
    if (!activeWorkspace) return
    setSetting('pluginWorkspaceEnabled', {
      ...pluginWorkspaceEnabled,
      [activeWorkspace.id]: {
        ...workspacePluginState,
        [pluginId]: enabled,
      },
    })
  }
  const auditByPlugin = useMemo(() => {
    const map = new Map<string, PluginAuditEntry[]>()
    for (const entry of audit) map.set(entry.pluginId, [...(map.get(entry.pluginId) ?? []), entry])
    return map
  }, [audit])

  return (
    <div className="ss-detail plugin-page">
      <div className="ss-detail-inner plugin-page-inner">
        <div className="plugin-page-hero">
          <div>
            <div className="ss-breadcrumb">
              <span>crewcode</span>
              <span className="sep">/</span>
              <span style={{ color: 'var(--foreground)' }}>plugins</span>
            </div>
            <h1 className="ss-h1">Plugins</h1>
            <p>Manage local-first extensions, approvals, and debug signals without crowding Preferences.</p>
          </div>
          <div className="plugin-page-actions">
            <button className="ss-btn" onClick={refresh}><Icon name="refresh" size={12} />refresh</button>
            <button className="ss-btn" onClick={() => window.electronAPI?.pluginsOpenDir()}><Icon name="folder" size={12} />open folder</button>
            <button className="ss-btn primary" onClick={() => { setInstallOpen(true); setInstallNotice(null) }}><Icon name="download" size={12} />install plugin</button>
          </div>
        </div>

        {installOpen && (
          <section className="plugin-install-panel" aria-label="Install plugin from Git">
            <div className="plugin-install-heading">
              <div>
                <span className="plugin-install-kicker">public Git repository</span>
                <h2>{candidate?.mode === 'update' ? 'Review plugin update' : 'Install from Git'}</h2>
                <p>CrewCode downloads checked-in files only. It never runs dependency installs, build scripts, or repository code during installation.</p>
              </div>
              <button className="ss-btn" onClick={closeInstaller} disabled={installBusy} aria-label="close plugin installer"><Icon name="x" size={12} /></button>
            </div>

            {!candidate && (
              <form className="plugin-install-form" onSubmit={(event) => { event.preventDefault(); void inspectRepository() }}>
                <label htmlFor="plugin-repository-url">Repository URL</label>
                <div className="plugin-install-input-row">
                  <input
                    id="plugin-repository-url"
                    type="url"
                    value={repositoryUrl}
                    onChange={event => setRepositoryUrl(event.target.value)}
                    placeholder="https://github.com/author/crewcode-plugin"
                    autoComplete="url"
                    disabled={installBusy}
                    required
                  />
                  <button className="ss-btn primary" type="submit" disabled={installBusy || !repositoryUrl.trim()}>
                    {installBusy ? 'validating…' : 'review'}
                  </button>
                </div>
              </form>
            )}

            {candidate && (
              <div className="plugin-install-review">
                <div className="plugin-install-review-main">
                  <div>
                    <span className="plugin-install-kicker">{candidate.mode} · commit {candidate.revision.slice(0, 8)}</span>
                    <h3>{candidate.name} <span>v{candidate.version}</span></h3>
                    <p>{candidate.description ?? candidate.id}</p>
                  </div>
                  <dl>
                    <div><dt>source</dt><dd title={candidate.repositoryUrl}>{new URL(candidate.repositoryUrl).hostname}</dd></div>
                    <div><dt>contents</dt><dd>{candidate.fileCount} files · {(candidate.totalBytes / 1024).toFixed(candidate.totalBytes < 1024 * 10 ? 1 : 0)} KB</dd></div>
                    {candidate.currentVersion && <div><dt>installed</dt><dd>v{candidate.currentVersion} · {candidate.currentRevision?.slice(0, 8) ?? 'local'}</dd></div>}
                  </dl>
                </div>

                <div className="plugin-install-permissions">
                  <span className="plugin-install-kicker">requested permissions</span>
                  {candidate.permissions.length === 0 ? (
                    <p>No host capabilities requested.</p>
                  ) : candidate.permissions.map(permission => {
                    const info = pluginPermissionInfo(permission)
                    return (
                      <div key={permission} className={`plugin-install-permission risk-${info.risk}`}>
                        <span>{info.label}</span>
                        <code>{permission}</code>
                        <p>{info.description}</p>
                      </div>
                    )
                  })}
                  {candidate.permissionsChanged && <div className="plugin-install-warning">This update changes the plugin’s requested permissions.</div>}
                  {!candidate.updateAvailable && <div className="plugin-install-current">This plugin is already on commit {candidate.revision.slice(0, 8)}.</div>}
                </div>

                <div className="plugin-install-actions">
                  <button className="ss-btn" onClick={() => { setCandidate(null); setInstallError(null) }} disabled={installBusy}>back</button>
                  <button className="ss-btn primary" onClick={() => void installCandidate()} disabled={installBusy || !candidate.updateAvailable}>
                    {installBusy ? 'installing…' : candidate.mode === 'update' ? 'install update' : 'install unapproved'}
                  </button>
                </div>
              </div>
            )}

            {installError && <div className="plugin-install-error"><Icon name="alert" size={13} />{installError}</div>}
          </section>
        )}

        {installNotice && <div className="plugin-page-notice"><Icon name="check" size={14} />{installNotice}</div>}

        <div className="plugin-summary-strip">
          <div><strong>{pluginCount}</strong><span>installed</span></div>
          <div><strong>{tabCount}</strong><span>tabs</span></div>
          <div><strong>{commandCount}</strong><span>commands</span></div>
          <div><strong>{mcpCount}</strong><span>mcp servers</span></div>
          <div><strong>{agentProviderCount}</strong><span>agent providers</span></div>
          <div className={deniedCount ? 'warn' : ''}><strong>{deniedCount}</strong><span>debug issues</span></div>
        </div>

        <section id="plugins" className="ss-section plugin-registry-section">
          <div className="ss-section-h">
            <h2>Local registry</h2>
            <span className="desc">{registry?.root ?? '~/.crewcode/plugins'}</span>
          </div>
          <p className="help plugin-registry-help">
            Plugin UI runs in sandboxed iframes and can only call approved capabilities. Active contributions are global approval + enablement + current workspace scope{activeWorkspace ? ` (${activeWorkspace.name})` : ''}. Use each plugin’s debug dropdown when testing manifests, panels, providers, or permission gates.
          </p>

          {error && (
            <div className="plugin-page-alert">
              <Icon name="alert" size={14} />
              <span>{error}</span>
            </div>
          )}

          {registry?.errors.map(err => (
            <div key={err.path} className="plugin-page-alert">
              <Icon name="alert" size={14} />
              <span>{err.dirName}: {err.category} · {err.error}</span>
            </div>
          ))}

          {registry?.plugins.length === 0 && (
            <div className="plugin-empty-state">
              <Icon name="plug" size={22} />
              <div>
                <h3>No local plugins installed</h3>
                <p>Install a public Git repository above, or add a development plugin folder containing crewcode.plugin.json.</p>
              </div>
            </div>
          )}

          <div className="plugin-list">
            {registry?.plugins.map(plugin => {
              const perms = plugin.manifest.permissions ?? []
              const counts = countContributions(plugin)
              const declaredTotal = Object.values(counts).reduce((sum, count) => sum + count, 0)
              const workspaceEnabled = activeWorkspace ? workspacePluginState[plugin.id] !== false : true
              const highRisk = perms.some(p => pluginPermissionInfo(p as PluginPermission).risk === 'high')
              const logs = auditByPlugin.get(plugin.id) ?? []
              const agentProviders = plugin.manifest.contributes?.agentProviders ?? []
              const providerNeedsAuthHint = agentProviders.some(provider => provider.runtime !== 'mock')
              return (
                <article key={plugin.id} className="plugin-list-item" data-q={`plugin ${plugin.id} ${plugin.manifest.name} ${perms.join(' ')}`}>
                  <div className="plugin-row-main">
                    <div className="plugin-row-icon"><Icon name="plug" size={18} /></div>
                    <div className="plugin-row-copy">
                      <div className="plugin-row-title">
                        <h3>{plugin.manifest.name}</h3>
                        <span className="plugin-version">v{plugin.manifest.version}</span>
                        <span className={`ss-pill ${plugin.enabled ? '' : 'muted'}`}><span className="dot" />{plugin.enabled ? 'enabled' : 'disabled'}</span>
                        <span className={`ss-pill ${plugin.approved ? '' : 'danger'}`}><span className="dot" />{approvalLabel(plugin)}</span>
                        {highRisk && <span className="ss-pill danger"><span className="dot" />dangerous</span>}
                      </div>
                      <p>{plugin.manifest.description ?? plugin.id}</p>
                      <div className="plugin-row-meta">
                        <span>{counts.tabs} tabs</span>
                        <span>{counts.commands} commands</span>
                        <span>{counts.mcpServers} mcp</span>
                        <span>{counts.agentProviders} agents</span>
                        <span>{declaredTotal} declared</span>
                        <span>{workspaceEnabled ? 'active here' : 'disabled here'}</span>
                        <span>{perms.length ? `${perms.length} permissions` : 'no permissions'}</span>
                        {plugin.source && <span title={plugin.source.repositoryUrl}>git {plugin.source.revision.slice(0, 8)}</span>}
                      </div>
                    </div>
                    <div className="plugin-row-actions">
                      {plugin.approved
                        ? <button className="ss-btn danger" onClick={() => setApproval(plugin.id, false)}>revoke</button>
                        : <button className="ss-btn primary" onClick={() => setApproval(plugin.id, true)}>approve</button>}
                      <div className="plugin-toggle-action">
                        <span>global</span>
                        <button
                          className={'ss-toggle' + (plugin.enabled ? ' on' : '')}
                          onClick={() => setEnabled(plugin.id, !plugin.enabled)}
                          role="switch"
                          aria-checked={plugin.enabled}
                          aria-label={`${plugin.enabled ? 'disable' : 'enable'} ${plugin.manifest.name} globally`}
                          title={plugin.enabled ? 'disable global' : 'enable global'}
                        />
                      </div>
                      {activeWorkspace && (
                        <div className="plugin-toggle-action">
                          <span>Current Workspace</span>
                          <button
                            className={'ss-toggle' + (workspaceEnabled ? ' on' : '')}
                            onClick={() => setWorkspacePluginEnabled(plugin.id, !workspaceEnabled)}
                            role="switch"
                            aria-checked={workspaceEnabled}
                            aria-label={`${workspaceEnabled ? 'disable' : 'enable'} ${plugin.manifest.name} in ${activeWorkspace.name}`}
                            title={workspaceEnabled ? 'disable here' : 'enable here'}
                          />
                        </div>
                      )}
                      <div className="plugin-secondary-actions">
                        {plugin.source && <button className="ss-btn" title="check repository for updates" onClick={() => void inspectRepository(plugin.id)}><Icon name="download" size={12} /></button>}
                        <button className="ss-btn" title="open plugin folder" onClick={() => window.electronAPI?.pluginsOpenPluginDir?.(plugin.id)}><Icon name="folder" size={12} /></button>
                        <button className="ss-btn" title="open manifest" onClick={() => window.electronAPI?.pluginsOpenManifest?.(plugin.id)}><Icon name="fileText" size={12} /></button>
                        <button className="ss-btn" title="reload panels" onClick={refresh}><Icon name="refresh" size={12} /></button>
                      </div>
                    </div>
                  </div>

                  {perms.length > 0 && (
                    <div className="plugin-permission-line">
                      {perms.map(raw => {
                        const info = pluginPermissionInfo(raw as PluginPermission)
                        return <span key={raw} className={info.risk === 'high' ? 'danger' : ''}>{info.permission}</span>
                      })}
                    </div>
                  )}

                  {providerNeedsAuthHint && (
                    <div className="plugin-page-alert">
                      <Icon name="alert" size={14} />
                      <span>provider auth is not stored in plugins yet. use CLI auth, local endpoints, or manifest apiKeyEnv environment variables.</span>
                    </div>
                  )}

                  <PluginDebugDropdown plugin={plugin} logs={logs} />
                </article>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}

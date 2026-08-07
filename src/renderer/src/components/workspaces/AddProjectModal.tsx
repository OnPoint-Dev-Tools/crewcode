import React, { useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'
import type { RemoteDirEntry, SshConfigHost } from '../../types'

type Mode = 'menu' | 'clone' | 'init' | 'remote'

interface AddProjectModalProps {
  open:         boolean
  onClose:      () => void
  onBrowse:     () => Promise<string | null>
  onClone:      (url: string, parentDir: string, folderName?: string) => Promise<{ id?: string; error?: string }>
  onInit:       (parentDir: string, folderName: string, asGit: boolean) => Promise<{ id?: string; error?: string }>
  onAddRemote:  (opts: { host: string; user?: string; port?: number; path: string; name?: string }) => Promise<{ id?: string; error?: string }>
  onPickFolder: () => Promise<string | null>
  onAdded:      (id: string) => void
}

interface OptionDef {
  id:    'browse' | 'clone' | 'remote' | 'init'
  icon:  'projects' | 'globe' | 'terminal' | 'plus'
  title: string
  hint:  string
}

const OPTIONS: OptionDef[] = [
  { id: 'browse', icon: 'projects', title: 'Browse folder',     hint: 'local git project or folder' },
  { id: 'clone',  icon: 'globe',    title: 'Clone from URL',    hint: 'remote git repository' },
  { id: 'remote', icon: 'terminal', title: 'Remote project',    hint: 'ssh connected target' },
  { id: 'init',   icon: 'plus',     title: 'Start from scratch', hint: 'create a git repository or plain folder' },
]

// Header badge icon per step — gives each mode a distinct visual anchor.
const HEAD_ICON: Record<Mode, OptionDef['icon']> = {
  menu:   'projects',
  clone:  'globe',
  remote: 'terminal',
  init:   'plus',
}

export function AddProjectModal({
  open, onClose, onBrowse, onClone, onInit, onAddRemote, onPickFolder, onAdded,
}: AddProjectModalProps) {
  const [mode,     setMode]     = useState<Mode>('menu')
  const [busy,     setBusy]     = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [url,      setUrl]      = useState('')
  const [parent,   setParent]   = useState('')
  const [folder,   setFolder]   = useState('')
  const [asGit,    setAsGit]    = useState(true)

  // remote (ssh) mode
  const [rmHost,      setRmHost]      = useState('')
  const [rmUser,      setRmUser]      = useState('')
  const [rmPort,      setRmPort]      = useState('')
  const [rmName,      setRmName]      = useState('')
  const [rmPath,      setRmPath]      = useState('')
  const [rmParent,    setRmParent]    = useState<string | null>(null)
  const [rmEntries,   setRmEntries]   = useState<RemoteDirEntry[]>([])
  const [rmConnected, setRmConnected] = useState(false)
  const [sshHosts,    setSshHosts]    = useState<SshConfigHost[]>([])

  useEffect(() => {
    if (open) {
      setMode('menu'); setBusy(false); setError(null)
      setUrl(''); setParent(''); setFolder(''); setAsGit(true)
      setRmHost(''); setRmUser(''); setRmPort(''); setRmName('')
      setRmPath(''); setRmParent(null); setRmEntries([]); setRmConnected(false)
      window.electronAPI?.sshListConfig().then(setSshHosts).catch(() => {})
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (mode === 'menu') onClose()
        else setMode('menu')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, mode, onClose])

  if (!open) return null

  async function pick() {
    const picked = await onPickFolder()
    if (picked) setParent(picked)
  }

  async function handleOption(id: OptionDef['id']) {
    setError(null)
    if (id === 'browse') {
      setBusy(true)
      try {
        const picked = await onBrowse()
        if (picked) { onAdded(picked); onClose() }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'could not open server folder')
      } finally {
        setBusy(false)
      }
      return
    }
    setMode(id)
  }

  function remoteSpec() {
    return {
      host: rmHost.trim(),
      user: rmUser.trim() || undefined,
      port: rmPort.trim() ? Number(rmPort.trim()) : undefined,
    }
  }

  async function browseRemote(path: string) {
    const api = window.electronAPI
    if (!api) return
    setBusy(true); setError(null)
    const res = await api.sshListRemoteDir(remoteSpec(), path)
    setBusy(false)
    if (res.error) { setError(res.error); return }
    setRmConnected(true)
    setRmPath(res.path ?? path)
    setRmParent(res.parent ?? null)
    setRmEntries(res.entries ?? [])
  }

  async function connectRemote() {
    const api = window.electronAPI
    if (!api || !rmHost.trim()) { setError('enter a host or ssh config alias'); return }
    setBusy(true); setError(null)
    const home = await api.sshRemoteHome(remoteSpec())
    setBusy(false)
    if (home.error) { setError(home.error); return }
    void browseRemote(home.path ?? '/')
  }

  async function submitRemote() {
    const api = window.electronAPI
    if (!api) return
    if (!rmConnected || !rmPath) { setError('connect and choose a folder first'); return }
    setBusy(true); setError(null)
    const res = await onAddRemote({ ...remoteSpec(), path: rmPath, name: rmName.trim() || undefined })
    setBusy(false)
    if (res.error || !res.id) { setError(res.error ?? 'could not add remote'); return }
    onAdded(res.id); onClose()
  }

  async function submitClone() {
    setBusy(true); setError(null)
    const result = await onClone(url, parent, folder || undefined)
    setBusy(false)
    if (result.error || !result.id) { setError(result.error ?? 'clone failed'); return }
    onAdded(result.id); onClose()
  }

  async function submitInit() {
    setBusy(true); setError(null)
    const result = await onInit(parent, folder, asGit)
    setBusy(false)
    if (result.error || !result.id) { setError(result.error ?? 'create failed'); return }
    onAdded(result.id); onClose()
  }

  return (
    <div className="ap-backdrop" onClick={onClose}>
      <div className="ap" onClick={e => e.stopPropagation()}>
        <div className="ap-head">
          <span className="ap-head-badge">
            <Icon name={HEAD_ICON[mode]} size={16} />
          </span>
          <div className="ap-title">
            <span className="ap-h1">{
              mode === 'menu'   ? 'Add a project'
              : mode === 'clone' ? 'Clone from URL'
              : mode === 'remote' ? 'Remote project'
              : 'Start from scratch'
            }</span>
            <span className="ap-h2">
              {mode === 'menu' && 'add another project to manage with CrewCode'}
              {mode === 'clone' && 'clone a remote git repository into a local folder'}
              {mode === 'init'  && 'create a git repository or plain folder and open it'}
              {mode === 'remote' && 'browse a host over ssh and mount a directory as a workspace'}
            </span>
          </div>
          <button className="ws-iconbtn" onClick={onClose} aria-label="close">
            <Icon name="close" size={13} />
          </button>
        </div>

        {mode === 'menu' && (
          <div className="ap-body">
            <div className="ap-options">
              {OPTIONS.map(o => (
                <button
                  key={o.id}
                  className="ap-option"
                  disabled={busy}
                  onClick={() => handleOption(o.id)}
                >
                  <span className="ap-option-ico"><Icon name={o.icon} size={15} /></span>
                  <span className="ap-option-text">
                    <span className="ap-option-title">{o.title}</span>
                    <span className="ap-option-hint">{o.hint}</span>
                  </span>
                  <Icon name="chevRight" size={13} />
                </button>
              ))}
            </div>
            {error && <div className="ap-error">{error}</div>}
          </div>
        )}

        {mode === 'clone' && (
          <div className="ap-body">
            <label className="ap-field">
              <span>repository url</span>
              <input
                autoFocus
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://github.com/user/repo.git"
              />
            </label>
            <label className="ap-field">
              <span>parent directory</span>
              <div className="ap-path-row">
                <input
                  value={parent}
                  onChange={e => setParent(e.target.value)}
                  placeholder="/path/to/projects"
                />
                <button className="ap-btn ghost" onClick={pick} disabled={busy}>browse</button>
              </div>
            </label>
            <label className="ap-field">
              <span>folder name <em>(optional)</em></span>
              <input
                value={folder}
                onChange={e => setFolder(e.target.value)}
                placeholder="defaults to repo name"
              />
            </label>
            {error && <div className="ap-error">{error}</div>}
            <div className="ap-actions">
              <button className="ap-btn back" onClick={() => setMode('menu')} disabled={busy}><Icon name="chevLeft" size={12} /> back</button>
              <button className="ap-btn primary" onClick={submitClone} disabled={busy || !url.trim() || !parent.trim()}>
                {busy ? 'cloning…' : 'clone repository'}
              </button>
            </div>
          </div>
        )}

        {mode === 'init' && (
          <div className="ap-body">
            <label className="ap-field">
              <span>parent directory</span>
              <div className="ap-path-row">
                <input
                  autoFocus
                  value={parent}
                  onChange={e => setParent(e.target.value)}
                  placeholder="/path/to/projects"
                />
                <button className="ap-btn ghost" onClick={pick} disabled={busy}>browse</button>
              </div>
            </label>
            <label className="ap-field">
              <span>project name</span>
              <input
                value={folder}
                onChange={e => setFolder(e.target.value)}
                placeholder="my-project"
              />
            </label>
            <label className="ap-check">
              <input type="checkbox" checked={asGit} onChange={e => setAsGit(e.target.checked)} />
              <span>initialize as a git repository</span>
            </label>
            {error && <div className="ap-error">{error}</div>}
            <div className="ap-actions">
              <button className="ap-btn back" onClick={() => setMode('menu')} disabled={busy}><Icon name="chevLeft" size={12} /> back</button>
              <button className="ap-btn primary" onClick={submitInit} disabled={busy || !parent.trim() || !folder.trim()}>
                {busy ? 'creating…' : 'create project'}
              </button>
            </div>
          </div>
        )}

        {mode === 'remote' && (
          <div className="ap-body">
            <label className="ap-field">
              <span>host or ssh config alias</span>
              <div className="ap-path-row">
                <input
                  autoFocus
                  value={rmHost}
                  list="ap-ssh-hosts"
                  onChange={e => { setRmHost(e.target.value); setRmConnected(false) }}
                  onKeyDown={e => { if (e.key === 'Enter') void connectRemote() }}
                  placeholder="build-box  or  user@1.2.3.4"
                />
                <button className="ap-btn ghost" onClick={connectRemote} disabled={busy || !rmHost.trim()}>connect</button>
              </div>
              <datalist id="ap-ssh-hosts">
                {sshHosts.map(h => <option key={h.host} value={h.host} />)}
              </datalist>
            </label>

            <div className="ap-path-row">
              <label className="ap-field" style={{ flex: 1 }}>
                <span>user <em>(optional)</em></span>
                <input value={rmUser} onChange={e => setRmUser(e.target.value)} placeholder="from ssh config" />
              </label>
              <label className="ap-field" style={{ width: 96 }}>
                <span>port</span>
                <input value={rmPort} onChange={e => setRmPort(e.target.value.replace(/[^0-9]/g, ''))} placeholder="22" />
              </label>
            </div>

            {rmConnected && (
              <>
                <label className="ap-field">
                  <span>remote folder</span>
                  <div className="ap-remote-path">{rmPath}</div>
                </label>
                <div className="ap-remote-browser">
                  {rmParent !== null && (
                    <button className="ap-remote-entry" onClick={() => browseRemote(rmParent)} disabled={busy}>
                      <Icon name="projects" size={12} /> ..
                    </button>
                  )}
                  {rmEntries.filter(e => e.kind === 'dir').map(e => (
                    <button
                      key={e.name}
                      className="ap-remote-entry"
                      disabled={busy}
                      onClick={() => browseRemote(rmPath.endsWith('/') ? rmPath + e.name : `${rmPath}/${e.name}`)}
                    >
                      <Icon name="projects" size={12} /> {e.name}
                    </button>
                  ))}
                  {rmEntries.filter(e => e.kind === 'dir').length === 0 && rmParent === null && (
                    <div className="ap-remote-empty">no sub-folders here</div>
                  )}
                </div>
                <label className="ap-field">
                  <span>display name <em>(optional)</em></span>
                  <input value={rmName} onChange={e => setRmName(e.target.value)} placeholder={rmHost.trim() || 'workspace name'} />
                </label>
              </>
            )}

            {error && <div className="ap-error">{error}</div>}
            <div className="ap-actions">
              <button className="ap-btn back" onClick={() => setMode('menu')} disabled={busy}><Icon name="chevLeft" size={12} /> back</button>
              <button className="ap-btn primary" onClick={submitRemote} disabled={busy || !rmConnected || !rmPath}>
                {busy ? 'working…' : 'mount this folder'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

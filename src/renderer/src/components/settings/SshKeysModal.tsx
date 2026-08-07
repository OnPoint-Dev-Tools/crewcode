import React, { useEffect, useState, useCallback } from 'react'
import { Icon } from '../ui/Icon'
import type { SshKeyFile } from '../../types'

interface Props {
  onClose: () => void
}

export function SshKeysModal({ onClose }: Props) {
  const [keys, setKeys]   = useState<SshKeyFile[]>([])
  const [busy, setBusy]   = useState<string | null>(null)   // path currently being added/removed
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [passFor, setPassFor] = useState<string | null>(null)  // key awaiting a passphrase
  const [passVal, setPassVal] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = await window.electronAPI?.sshListKeys()
      setKeys(list ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const add = async (path: string, passphrase?: string) => {
    setBusy(path); setError(null)
    const r = await window.electronAPI?.sshAddKey(path, passphrase)
    setBusy(null)
    if (r?.ok) {
      setPassFor(null); setPassVal('')
      await refresh()
      return
    }
    // A passphrase-protected key can't load non-interactively — reveal the input.
    if (r?.needsPassphrase) {
      setPassFor(path)
      if (passphrase) setError('incorrect passphrase — try again')
      return
    }
    setError(r?.error ?? 'failed to add key')
    await refresh()
  }

  const remove = async (path: string) => {
    setBusy(path); setError(null)
    const r = await window.electronAPI?.sshRemoveKey(path)
    setBusy(null)
    if (!r?.ok) setError(r?.error ?? 'failed to remove key')
    await refresh()
  }

  const openCfg = async () => {
    await window.electronAPI?.sshOpenConfig()
  }

  return (
    <div className="ss-rebind-backdrop" onClick={onClose}>
      <div className="ss-rebind-modal ss-ssh-modal" onClick={e => e.stopPropagation()}>
        <div className="ss-rebind-h">manage ssh keys</div>
        <div className="ss-ssh-modal-desc">
          keys discovered in <span className="kbd">~/.ssh</span> · click <b>load</b> to add to ssh-agent
        </div>

        <div className="ss-ssh-key-list">
          {loading && <div className="ss-ssh-empty">scanning ~/.ssh…</div>}
          {!loading && keys.length === 0 && (
            <div className="ss-ssh-empty">no private keys found in ~/.ssh</div>
          )}
          {keys.map(k => (
            <div key={k.path} className="ss-ssh-key-wrap">
              <div className="ss-ssh-key-row">
                <div className="ss-ssh-ico"><Icon name="key" size={14} /></div>
                <div className="ss-ssh-key-info">
                  <div className="ss-ssh-key-name">{k.name} <span className="v">{k.type}</span></div>
                  <div className="ss-ssh-key-meta">
                    {k.fingerprint ? <span className="fp">{k.fingerprint}</span> : <span>no public key file</span>}
                    {k.comment && <> · <span>{k.comment}</span></>}
                  </div>
                </div>
                {k.loaded
                  ? <span className="ss-pill"><span className="dot" />loaded</span>
                  : <span className="ss-pill muted"><span className="dot" />not loaded</span>}
                {k.loaded
                  ? <button className="ss-btn danger" disabled={busy === k.path} onClick={() => remove(k.path)}>
                      {busy === k.path ? '…' : 'unload'}
                    </button>
                  : <button className="ss-btn primary" disabled={busy === k.path}
                      onClick={() => (passFor === k.path ? add(k.path, passVal) : add(k.path))}>
                      {busy === k.path ? '…' : 'load'}
                    </button>}
              </div>
              {passFor === k.path && !k.loaded && (
                <div className="ss-ssh-pass-row">
                  <Icon name="key" size={12} />
                  <input
                    type="password"
                    autoFocus
                    className="ss-ssh-pass-input"
                    placeholder="key passphrase — enter to load"
                    value={passVal}
                    onChange={e => setPassVal(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && passVal) add(k.path, passVal)
                      else if (e.key === 'Escape') { setPassFor(null); setPassVal(''); setError(null) }
                    }}
                  />
                  <button className="ss-btn primary" disabled={busy === k.path || !passVal} onClick={() => add(k.path, passVal)}>
                    {busy === k.path ? '…' : 'unlock'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {error && <div className="ss-gh-error">{error}</div>}

        <div className="ss-rebind-actions">
          <button className="ss-btn" onClick={openCfg}><Icon name="code" size={12} />open ~/.ssh/config</button>
          <button className="ss-btn" onClick={refresh}><Icon name="refresh" size={12} />refresh</button>
          <button className="ss-btn primary" onClick={onClose}>done</button>
        </div>
      </div>
    </div>
  )
}

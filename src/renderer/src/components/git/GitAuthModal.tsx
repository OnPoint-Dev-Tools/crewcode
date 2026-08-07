import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'

interface GitAuthModalProps {
  open: boolean
  remoteUrl?: string
  error?: string
  onSubmit: (credentials: { username: string; password: string }) => void
  onCancel: () => void
}

export function GitAuthModal({ open, remoteUrl, error, onSubmit, onCancel }: GitAuthModalProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const userRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setPassword('')
    const id = window.setTimeout(() => userRef.current?.focus(), 30)
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => { window.clearTimeout(id); window.removeEventListener('keydown', onKey) }
  }, [open, onCancel])

  if (!open) return null

  const submit = () => {
    const cleanUser = username.trim()
    if (!cleanUser || !password) return
    onSubmit({ username: cleanUser, password })
  }

  return (
    <div className="im-backdrop" onClick={onCancel}>
      <div className="im-modal git-auth-modal" role="dialog" aria-modal="true" aria-label="Git authentication" onClick={event => event.stopPropagation()}>
        <div className="im-head">
          <span className="im-title"><Icon name="gitBranch" size={13} /> Git authentication</span>
          <button className="im-close" onClick={onCancel}><Icon name="close" size={12} /></button>
        </div>
        <div className="git-auth-copy">
          <p>Git needs credentials to push to this remote.</p>
          {remoteUrl && <code>{remoteUrl}</code>}
          {error && <div className="git-auth-error">{error}</div>}
        </div>
        <label className="im-label" htmlFor="git-auth-username">Username</label>
        <input
          id="git-auth-username"
          ref={userRef}
          className="ss-agent-edit-input"
          value={username}
          autoComplete="username"
          onChange={event => setUsername(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') submit() }}
          placeholder="git username"
        />
        <label className="im-label" htmlFor="git-auth-password">Password or token</label>
        <input
          id="git-auth-password"
          className="ss-agent-edit-input"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={event => setPassword(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') submit() }}
          placeholder="password / personal access token"
        />
        <div className="git-auth-note">Credentials are used once for this Git command and are not saved by CrewCode.</div>
        <div className="im-actions">
          <button className="ss-btn" onClick={onCancel}>cancel</button>
          <button className="ss-btn primary" disabled={!username.trim() || !password} onClick={submit}>retry push</button>
        </div>
      </div>
    </div>
  )
}

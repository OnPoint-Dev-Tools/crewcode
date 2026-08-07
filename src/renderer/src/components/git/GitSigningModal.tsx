import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'

interface GitSigningModalProps {
  open: boolean
  error?: string
  onSubmit: (passphrase: string) => void
  onCancel: () => void
}

/** One-shot prompt for a commit signing-key passphrase. The passphrase is used
 *  once for the retried commit and is never persisted by CrewCode. */
export function GitSigningModal({ open, error, onSubmit, onCancel }: GitSigningModalProps) {
  const [passphrase, setPassphrase] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setPassphrase('')
    const id = window.setTimeout(() => inputRef.current?.focus(), 30)
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => { window.clearTimeout(id); window.removeEventListener('keydown', onKey) }
  }, [open, onCancel])

  if (!open) return null

  const submit = () => {
    if (!passphrase) return
    onSubmit(passphrase)
  }

  return (
    <div className="im-backdrop" onClick={onCancel}>
      <div className="im-modal git-auth-modal" role="dialog" aria-modal="true" aria-label="Commit signing passphrase" onClick={event => event.stopPropagation()}>
        <div className="im-head">
          <span className="im-title"><Icon name="gitBranch" size={13} /> Unlock signing key</span>
          <button className="im-close" onClick={onCancel}><Icon name="close" size={12} /></button>
        </div>
        <div className="git-auth-copy">
          <p>Your commit signing key is passphrase-protected. Enter it to sign this commit.</p>
          {error && <div className="git-auth-error">{error}</div>}
        </div>
        <label className="im-label" htmlFor="git-signing-passphrase">Key passphrase</label>
        <input
          id="git-signing-passphrase"
          ref={inputRef}
          className="ss-agent-edit-input"
          type="password"
          value={passphrase}
          autoComplete="off"
          onChange={event => setPassphrase(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') submit() }}
          placeholder="signing key passphrase"
        />
        <div className="git-auth-note">Used once to sign this commit — not saved by CrewCode. Cancel to commit unsigned instead.</div>
        <div className="im-actions">
          <button className="ss-btn" onClick={onCancel}>commit unsigned</button>
          <button className="ss-btn primary" disabled={!passphrase} onClick={submit}>sign &amp; commit</button>
        </div>
      </div>
    </div>
  )
}

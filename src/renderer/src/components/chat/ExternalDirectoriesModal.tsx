import { useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'

interface ExternalDirectoriesModalProps {
  open: boolean
  directories: string[]
  providerId: string
  remote: boolean
  initialMode?: 'add' | 'remove'
  onClose: () => void
  onAdd: (path: string) => void
  onRemove: (path: string) => void
}

export function ExternalDirectoriesModal({ open, directories, providerId, remote, initialMode = 'add', onClose, onAdd, onRemove }: ExternalDirectoriesModalProps) {
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null

  const supported = (providerId === 'claude' || providerId === 'crewcoder') && !remote
  const browse = async () => {
    if (!supported) return
    setBusy(true)
    try {
      const result = await window.electronAPI?.pickExternalDirectory()
      if (result?.path) onAdd(result.path)
    } finally { setBusy(false) }
  }

  return (
    <div className="ap-backdrop" onClick={onClose}>
      <div className="ap external-dirs-modal" role="dialog" aria-modal="true" aria-label="External directories" onClick={event => event.stopPropagation()}>
        <div className="ap-head">
          <span className="ap-head-badge"><Icon name="projects" size={16} /></span>
          <div className="ap-title">
            <span className="ap-h1">External directories</span>
            <span className="ap-h2">session-only filesystem access · not added as workspaces</span>
          </div>
          <button className="ws-iconbtn" onClick={onClose} aria-label="close"><Icon name="close" size={13} /></button>
        </div>
        <div className="ap-body">
          {!supported && <div className="ap-error">{remote ? 'Local directories cannot be attached to a remote/SSH session.' : `${providerId} does not support additional directory roots yet. Claude and CrewCoder are currently supported.`}</div>}
          {directories.length === 0 ? (
            <div className="external-dirs-empty">No external directories attached to this session.</div>
          ) : (
            <div className="external-dirs-list">
              {directories.map(path => (
                <div className="external-dirs-row" key={path} title={path}>
                  <Icon name="projects" size={13} />
                  <span>{path}</span>
                  <button className="ws-iconbtn" onClick={() => onRemove(path)} aria-label={`remove ${path}`} title="Remove from session"><Icon name="trash" size={12} /></button>
                </div>
              ))}
            </div>
          )}
          <div className="ap-actions">
            <button className="ap-btn back" onClick={onClose}>done</button>
            <button className="ap-btn primary" autoFocus={initialMode === 'add'} disabled={!supported || busy} onClick={() => void browse()}>
              <Icon name="plus" size={12} /> {busy ? 'browsing…' : 'browse…'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

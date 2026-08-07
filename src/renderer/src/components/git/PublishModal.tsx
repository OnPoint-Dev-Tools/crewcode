/* PublishModal — collects repo name / visibility / description, then hands off
 * to onPublish (init + first commit + gh repo create + push). Shown from the
 * Git Sidebar's Publish card when the active repo has no remote. */
import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import type { GitPublishOpts } from './git-state'

interface PublishModalProps {
  open:        boolean
  defaultName: string
  onPublish:   (opts: GitPublishOpts) => Promise<boolean>
  onClose:     () => void
}

export function PublishModal({ open, defaultName, onPublish, onClose }: PublishModalProps) {
  const [name, setName]             = useState(defaultName)
  const [visibility, setVisibility] = useState<'private' | 'public'>('private')
  const [description, setDesc]      = useState('')
  const [publishing, setPublishing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setName(defaultName)
      setVisibility('private')
      setDesc('')
      setPublishing(false)
      const t = setTimeout(() => inputRef.current?.select(), 30)
      return () => clearTimeout(t)
    }
    return
  }, [open, defaultName])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !publishing) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, publishing, onClose])

  if (!open) return null

  async function commit() {
    const n = name.trim()
    if (!n || publishing) return
    setPublishing(true)
    try {
      const ok = await onPublish({ name: n, visibility, description: description.trim() || undefined })
      if (ok) onClose()
    } finally {
      setPublishing(false)
    }
  }

  return (
    <div className="im-backdrop" onClick={() => { if (!publishing) onClose() }}>
      <div className="im-modal" onClick={e => e.stopPropagation()}>
        <div className="im-head">
          <span className="im-title"><Icon name="github" size={13} /> Publish to GitHub</span>
          <button className="im-close" onClick={onClose} disabled={publishing}><Icon name="close" size={12} /></button>
        </div>

        <div className="im-label">repository name</div>
        <input
          ref={inputRef}
          className="im-input"
          autoFocus
          value={name}
          placeholder="my-repo"
          disabled={publishing}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter')  { e.preventDefault(); commit() }
            if (e.key === 'Escape') { e.preventDefault(); onClose() }
          }}
        />

        <div className="im-label">visibility</div>
        <div className="pm-visibility">
          <button
            className={`pm-vis ${visibility === 'private' ? 'on' : ''}`}
            disabled={publishing}
            onClick={() => setVisibility('private')}
          >
            <Icon name="key" size={11} /> private
          </button>
          <button
            className={`pm-vis ${visibility === 'public' ? 'on' : ''}`}
            disabled={publishing}
            onClick={() => setVisibility('public')}
          >
            <Icon name="globe" size={11} /> public
          </button>
        </div>

        <div className="im-label">description <span className="pm-opt">(optional)</span></div>
        <input
          className="im-input"
          value={description}
          disabled={publishing}
          placeholder="what is this repo?"
          onChange={e => setDesc(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
        />

        <div className="pm-note">
          Stages your files, creates an initial commit if needed, creates the GitHub repo, wires up <code>origin</code>, and pushes.
        </div>

        <div className="im-actions">
          <button className="im-btn" onClick={onClose} disabled={publishing}>Cancel</button>
          <button className="im-btn primary" onClick={commit} disabled={!name.trim() || publishing}>
            {publishing ? <span className="pm-spinner" /> : <Icon name="github" size={11} />}
            {publishing ? 'Publishing…' : 'Publish'}
          </button>
        </div>
      </div>
    </div>
  )
}

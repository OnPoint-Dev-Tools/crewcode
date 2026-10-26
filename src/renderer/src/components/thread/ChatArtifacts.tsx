import React, { createContext, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getCrewCodeClient, getCrewCodeRuntime } from '../../runtime/crewcode-client'
import { CHAT_ARTIFACT_MAX_CHARS, CHAT_ARTIFACT_PATH, chatArtifactFrameUrl } from '../../../../shared/chat-artifact-frame'
import { workspaceFilePathFromHref } from '../chat/workspace-link-targets'
import './chat-artifacts.css'
import { ImageViewer } from '../images/ImageViewer'
import { isImageFile } from '../../../../shared/image-files'

type Artifact = { title: string; html?: string; url?: string; text?: string; imagePath?: string; imageSrc?: string }
type ArtifactActions = { openHtml: (html: string, title: string) => void; openLink: (href: string, image?: boolean) => void }
const ArtifactContext = createContext<ArtifactActions | null>(null)
export const useChatArtifacts = () => useContext(ArtifactContext)

export function isArtifactLink(href: string): boolean {
  return /^https?:\/\//i.test(href) || isImageFile(href) || /\.(?:html?|md|txt)(?:[?#].*)?$/i.test(href)
}

export function ChatArtifacts({ workspacePath, onOpenLink, children }: {
  workspacePath?: string; onOpenLink?: (href: string) => void; children: React.ReactNode
}) {
  const [artifact, setArtifact] = useState<Artifact | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const previewBase = artifact && (artifact.html !== undefined || artifact.url) ? (getCrewCodeRuntime().kind === 'electron'
    ? 'crewcode-artifact://preview/' : new URL(CHAT_ARTIFACT_PATH, window.location.href).href) : ''
  const close = () => { generation.current++; setArtifact(null); setBusy(false); setError('') }
  useEffect(() => {
    close()
    return () => { generation.current++ }
  }, [workspacePath])
  useEffect(() => {
    if (!artifact) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [artifact])

  async function openLink(href: string, image = false) {
    const id = ++generation.current
    setError(''); setBusy(false)
    setArtifact({ title: href })
    if (/^data:image\/[\w.+-]+;base64,/i.test(href)) {
      if (href.length > 35_000_000) setError('Image exceeds the 25 MB preview limit')
      else setArtifact({ title: 'Chat image', imageSrc: href })
      return
    }
    if (/^https?:\/\//i.test(href)) {
      if (workspacePath?.startsWith('ssh://') && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(href).hostname)) {
        setError('This address belongs to the SSH host. Forward its port and open the forwarded URL to preview it here.')
      } else setArtifact(image || isImageFile(href) ? { title: href, imageSrc: href } : { title: href, url: href })
      return
    }
    const path = workspaceFilePathFromHref(href, workspacePath)
    if (!path || !workspacePath) { setError('Artifact must be inside the current workspace.'); return }
    if (image || isImageFile(path)) { setArtifact({ title: path, imagePath: path }); return }
    setBusy(true)
    try {
      const api = getCrewCodeClient()
      const result = await api.fsReadFile(workspacePath, path)
      if (id !== generation.current) return
      if (!result.ok || typeof result.text !== 'string') throw new Error(result.error || 'Cannot read artifact')
      if (result.text.length > 2_000_000) throw new Error('Artifact exceeds the 2 MB preview limit')
      setArtifact(/\.html?$/i.test(path) ? { title: path, html: result.text } : { title: path, text: result.text })
    } catch (cause) {
      if (id === generation.current) setError(cause instanceof Error ? cause.message : 'Cannot read artifact')
    } finally { if (id === generation.current) setBusy(false) }
  }

  return <ArtifactContext.Provider value={{
    openHtml: (html, title) => {
      generation.current++; setBusy(false)
      setError(html.length > CHAT_ARTIFACT_MAX_CHARS ? 'Artifact exceeds the 2 MB preview limit' : '')
      setArtifact(html.length > CHAT_ARTIFACT_MAX_CHARS ? { title } : { title, html })
    },
    openLink: (href, image) => { void openLink(href, image) },
  }}>
    {children}
    {artifact && createPortal(<aside className="chat-artifacts-panel" aria-label="Artifacts">
      <header><strong>Artifacts</strong><button type="button" onClick={close} aria-label="Close artifacts">Close</button></header>
      <div className="chat-artifacts-toolbar">
        <span title={artifact.title}>{artifact.title}</span>
        {artifact.url && onOpenLink && <button type="button" onClick={() => onOpenLink(artifact.url!)}>Open in app browser</button>}
      </div>
      {busy ? <p role="status">Loading artifact…</p> : error ? <p role="alert">{error}</p> :
        artifact.imagePath || artifact.imageSrc ? <ImageViewer root={workspacePath} path={artifact.imagePath} src={artifact.imageSrc} title={artifact.title} /> :
        artifact.text !== undefined ? <pre>{artifact.text}</pre> : <>
          {artifact.url && <p className="chat-artifacts-hint">If this site blocks embedding, use Open in app browser.</p>}
          {/* Opaque origin and no bridge keep generated scripts away from app authority. */}
          <iframe key={`${artifact.title}:${generation.current}`} title={`Artifact: ${artifact.title}`} sandbox="allow-scripts" referrerPolicy="no-referrer"
            src={artifact.url ?? chatArtifactFrameUrl(artifact.html ?? '', previewBase)} />
        </>}
    </aside>, document.body)}
  </ArtifactContext.Provider>
}

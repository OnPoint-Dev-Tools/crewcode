import React, { useEffect, useState } from 'react'
import { getCrewCodeClient, getCrewCodeRuntime } from '../../runtime/crewcode-client'
import { CHAT_ARTIFACT_PATH, chatArtifactFrameUrl } from '../../../../shared/chat-artifact-frame'
import './image-viewer.css'

export function ImageViewer({ root, path, src, title }: { root?: string; path?: string; src?: string; title: string }) {
  const [loaded, setLoaded] = useState<{ key: string; src?: string; error?: string } | null>(null)
  const [scale, setScale] = useState<number | null>(null)
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null)
  const [revision, setRevision] = useState(0)
  const key = JSON.stringify([root, path, src, revision])
  useEffect(() => {
    let cancelled = false
    setScale(null); setDimensions(null); setLoaded(null)
    if (src && /^(?:https?:\/\/|data:image\/[\w.+-]+;base64,)/i.test(src)) {
      setLoaded({ key, src })
    } else if (root && path) {
      void getCrewCodeClient().fsReadDataUrl(root, path).then(result => {
        if (cancelled) return
        // Only image data URLs enter an img element; SVG is never an active document.
        if (!result.ok || !result.dataUrl || !/^data:image\/[\w.+-]+;base64,/i.test(result.dataUrl)) {
          setLoaded({ key, error: result.error || 'Cannot read image' })
        } else setLoaded({ key, src: result.dataUrl })
      }).catch(error => { if (!cancelled) setLoaded({ key, error: String(error) }) })
    } else setLoaded({ key, error: 'Image is unavailable' })
    return () => { cancelled = true }
  }, [key, root, path, src])
  const current = loaded?.key === key ? loaded : null
  let remoteFrame: string | undefined
  if (current?.src && /^https?:\/\//i.test(current.src)) {
    const url = current.src.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const base = getCrewCodeRuntime().kind === 'electron' ? 'crewcode-artifact://preview/' : new URL(CHAT_ARTIFACT_PATH, window.location.href).href
    // Remote image access stays in the existing opaque preview boundary, preserving app CSP.
    remoteFrame = chatArtifactFrameUrl(`<style>html,body{margin:0;height:100%;}body{display:grid;place-items:safe center;overflow:auto}img{${scale === null ? 'max-width:100%;max-height:100vh;object-fit:contain' : `zoom:${scale}`}}</style><img alt="Image" referrerpolicy="no-referrer" src="${url}" onerror="document.body.textContent='This image could not be displayed.'">`, base)
  }
  return <section className="image-viewer" aria-label={`Image: ${title}`}>
    <div className="image-viewer-tools">
      <button type="button" onClick={() => setScale(null)}>Fit</button>
      <button type="button" onClick={() => setScale(1)}>Actual size</button>
      <button type="button" aria-label="Zoom out" onClick={() => setScale(s => Math.max(.1, (s ?? 1) / 1.25))}>−</button>
      <button type="button" aria-label="Zoom in" onClick={() => setScale(s => Math.min(8, (s ?? 1) * 1.25))}>+</button>
      <button type="button" onClick={() => setRevision(r => r + 1)}>Reload</button>
      <span>{scale === null ? 'Fit' : `${Math.round(scale * 100)}%`}{dimensions && ` · ${dimensions.width} × ${dimensions.height}`}</span>
    </div>
    <div className="image-viewer-canvas">
      {!current ? <p role="status">Loading image…</p> : current.error ? <p role="alert">{current.error}</p> : remoteFrame ?
        <iframe title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" src={remoteFrame} /> :
        <img src={current.src} alt={title} referrerPolicy="no-referrer" draggable={false}
          style={scale === null ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' } : { width: dimensions ? dimensions.width * scale : undefined, maxWidth: 'none', flexShrink: 0 }}
          onLoad={event => setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setLoaded({ key, error: 'This image could not be displayed.' })} />}
    </div>
  </section>
}

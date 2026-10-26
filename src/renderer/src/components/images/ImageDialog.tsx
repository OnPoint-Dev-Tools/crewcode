import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ImageViewer } from './ImageViewer'

export function ImageDialog({ root, path, onClose }: { root?: string; path: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.showModal()
    return () => { previous?.focus() }
  }, [])
  return createPortal(<dialog ref={ref} className="image-dialog" aria-label={path} onCancel={event => { event.preventDefault(); onClose() }}>
    <header><strong>{path}</strong><button type="button" onClick={onClose} autoFocus>Close image</button></header>
    <ImageViewer root={root} path={path} title={path} />
  </dialog>, document.body)
}

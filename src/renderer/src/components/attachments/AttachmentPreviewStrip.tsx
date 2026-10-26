import { useEffect, useState } from 'react'
import { Icon } from '../ui/Icon'
import type { ChatAttachment } from '../../types'
import { getCrewCodeClient } from '../../runtime/crewcode-client'
import { ImageDialog } from '../images/ImageDialog'

interface AttachmentPreviewStripProps {
  attachments: ChatAttachment[]
  workspacePath?: string
  variant: 'composer' | 'message'
  onRemove?: (rel: string) => void
}

const IMAGE_EXT_RE = /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp)$/i

function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(i + 1) : path
}

function isImageAttachment(attachment: ChatAttachment): boolean {
  if (attachment.mimeType?.startsWith('image/')) return true
  return IMAGE_EXT_RE.test(attachment.name || attachment.rel)
}

function attachmentName(attachment: ChatAttachment): string {
  return attachment.name || basename(attachment.rel)
}

function AttachmentImageTile({
  attachment,
  workspacePath,
  variant,
  onRemove,
}: {
  attachment: ChatAttachment
  workspacePath?: string
  variant: 'composer' | 'message'
  onRemove?: (rel: string) => void
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setSrc(null)
    if (!workspacePath) return
    let cancelled = false
    const api = getCrewCodeClient()
    // Load previews through IPC instead of file:// so sandboxed renderer code can
    // show local thumbnails without widening the browser's file access surface.
    void api.fsReadDataUrl(workspacePath, attachment.rel).then((res) => {
      if (cancelled || !res.ok || !res.dataUrl) return
      setSrc(res.dataUrl)
    }).catch(() => {
      if (!cancelled) setSrc(null)
    })
    return () => { cancelled = true }
  }, [attachment.rel, workspacePath])

  return (
    <div className={`attachment-tile attachment-tile-${variant}`} title={attachment.rel}>
      <div className="attachment-thumb">
        <button type="button" className="attachment-image-open" aria-label={`Open image ${attachmentName(attachment)}`} onClick={() => setOpen(true)}>{src
          ? <img src={src} alt={attachmentName(attachment)} draggable={false} />
          : <span className="attachment-thumb-fallback"><Icon name="fileText" size={18} /></span>}</button>
        {onRemove && (
          <button
            type="button"
            className="attachment-tile-remove"
            onClick={() => onRemove(attachment.rel)}
            aria-label={`remove ${attachmentName(attachment)}`}
          >
            <Icon name="x" size={10} />
          </button>
        )}
      </div>
      <div className="attachment-meta">
        <span className="attachment-name">{attachmentName(attachment)}</span>
      </div>
      {open && <ImageDialog root={workspacePath} path={attachment.rel} onClose={() => setOpen(false)} />}
    </div>
  )
}

function AttachmentFileChip({
  attachment,
  onRemove,
}: {
  attachment: ChatAttachment
  onRemove?: (rel: string) => void
}) {
  return (
    <span className="attach-chip" title={attachment.rel}>
      <Icon name="paperclip" size={11} />
      <span className="attach-name">{attachmentName(attachment)}</span>
      {onRemove && (
        <button
          type="button"
          className="attach-x"
          onClick={() => onRemove(attachment.rel)}
          aria-label={`remove ${attachmentName(attachment)}`}
        >
          <Icon name="x" size={10} />
        </button>
      )}
    </span>
  )
}

export function AttachmentPreviewStrip({ attachments, workspacePath, variant, onRemove }: AttachmentPreviewStripProps) {
  if (attachments.length === 0) return null

  return (
    <div className={`attachment-strip attachment-strip-${variant}`}>
      {attachments.map((attachment) => (
        isImageAttachment(attachment)
          ? <AttachmentImageTile key={attachment.rel} attachment={attachment} workspacePath={workspacePath} variant={variant} onRemove={onRemove} />
          : <AttachmentFileChip key={attachment.rel} attachment={attachment} onRemove={onRemove} />
      ))}
    </div>
  )
}

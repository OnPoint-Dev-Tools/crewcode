import React, { useEffect, useMemo, useState } from 'react'
import type { BrowserGrabRect } from '../../../../shared/browser-grab-types'

interface BrowserRegionOverlayProps {
  active: boolean
  onCancel: () => void
  onComplete: (rect: BrowserGrabRect) => void
}

interface Point {
  x: number
  y: number
}

function toRect(start: Point, end: Point): BrowserGrabRect {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  const width = Math.abs(end.x - start.x)
  const height = Math.abs(end.y - start.y)
  return { x, y, width, height }
}

export function BrowserRegionOverlay({ active, onCancel, onComplete }: BrowserRegionOverlayProps) {
  const [start, setStart] = useState<Point | null>(null)
  const [end, setEnd] = useState<Point | null>(null)

  useEffect(() => {
    if (!active) {
      setStart(null)
      setEnd(null)
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active, onCancel])

  const rect = useMemo(() => (start && end ? toRect(start, end) : null), [start, end])

  if (!active) return null

  return (
    <div
      className="browser-region-overlay"
      onPointerDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
        setStart(point)
        setEnd(point)
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!start) return
        const bounds = event.currentTarget.getBoundingClientRect()
        setEnd({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })
      }}
      onPointerUp={(event) => {
        if (!start) return
        const bounds = event.currentTarget.getBoundingClientRect()
        const nextRect = toRect(start, { x: event.clientX - bounds.left, y: event.clientY - bounds.top })
        setStart(null)
        setEnd(null)
        if (nextRect.width < 6 || nextRect.height < 6) {
          onCancel()
          return
        }
        onComplete(nextRect)
      }}
    >
      <div className="browser-region-hint">drag to capture region · esc to cancel</div>
      {rect && (
        <div
          className="browser-region-rect"
          style={{
            left: rect.x,
            top: rect.y,
            width: rect.width,
            height: rect.height,
          }}
        />
      )}
    </div>
  )
}

import React, { useEffect, useRef } from 'react'

interface SplitterProps {
  orientation: 'vertical' | 'horizontal'   // vertical handle (drags left/right) or horizontal handle (drags up/down)
  onDrag:      (deltaPx: number) => void
  onDragEnd?:  () => void
}

// A thin draggable handle that emits deltas while the user drags.
// Parent owns the actual size state — we just report deltas so it can clamp.
export function Splitter({ orientation, onDrag, onDragEnd }: SplitterProps) {
  const draggingRef = useRef(false)
  const lastRef = useRef(0)
  const activePointerIdRef = useRef<number | null>(null)
  const bodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null)
  const onDragRef = useRef(onDrag)
  const onDragEndRef = useRef(onDragEnd)
  const orientationRef = useRef(orientation)

  useEffect(() => { onDragRef.current = onDrag }, [onDrag])
  useEffect(() => { onDragEndRef.current = onDragEnd }, [onDragEnd])
  useEffect(() => { orientationRef.current = orientation }, [orientation])

  const finishDrag = () => {
    if (!draggingRef.current) return
    draggingRef.current = false
    activePointerIdRef.current = null
    const prev = bodyStyleRef.current
    document.body.style.cursor = prev?.cursor ?? ''
    document.body.style.userSelect = prev?.userSelect ?? ''
    bodyStyleRef.current = null
    onDragEndRef.current?.()
  }

  // Pointer capture keeps the resize lifecycle local to this handle. Without it,
  // a missed mouseup can leave body user-select disabled until the sidebar closes.
  useEffect(() => () => finishDrag(), [])

  return (
    <div
      className={`splitter splitter-${orientation}`}
      onPointerDown={e => {
        if (e.button !== 0) return
        e.preventDefault()
        draggingRef.current = true
        activePointerIdRef.current = e.pointerId
        lastRef.current = orientation === 'vertical' ? e.clientX : e.clientY
        bodyStyleRef.current = {
          cursor: document.body.style.cursor,
          userSelect: document.body.style.userSelect,
        }
        document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize'
        document.body.style.userSelect = 'none'
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={e => {
        if (!draggingRef.current || activePointerIdRef.current !== e.pointerId) return
        e.preventDefault()
        const cur = orientationRef.current === 'vertical' ? e.clientX : e.clientY
        const delta = cur - lastRef.current
        lastRef.current = cur
        if (delta !== 0) onDragRef.current(delta)
      }}
      onPointerUp={e => {
        if (activePointerIdRef.current === e.pointerId) finishDrag()
      }}
      onPointerCancel={e => {
        if (activePointerIdRef.current === e.pointerId) finishDrag()
      }}
      onLostPointerCapture={finishDrag}
    />
  )
}

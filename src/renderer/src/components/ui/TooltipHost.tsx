import React, { useEffect, useRef, useState } from 'react'

interface TooltipState {
  text: string
  x: number
  y: number
  placement: 'above' | 'below'
  tilt: string
}

const SHOW_DELAY_MS = 220
const TITLE_CACHE = 'data-crewcode-tooltip'

/**
 * Replaces native browser `title` bubbles with one consistent app tooltip.
 * Event delegation means existing buttons opt in automatically without each
 * component needing a wrapper or another React subtree.
 */
export function TooltipHost() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const timerRef = useRef<number | null>(null)
  const targetRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const restoreTitle = (element: HTMLElement | null) => {
      if (!element) return
      const title = element.dataset.crewcodeTooltip
      if (title) element.setAttribute('title', title)
      delete element.dataset.crewcodeTooltip
    }
    const hide = () => {
      clearTimer()
      restoreTitle(targetRef.current)
      targetRef.current = null
      setTooltip(null)
    }
    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return
      const target = (event.target as Element | null)?.closest<HTMLElement>('[title]')
      if (!target || target === targetRef.current) return
      hide()

      const text = target.getAttribute('title')?.trim()
      if (!text) return
      // Remove immediately so Chromium's native tooltip never races ours.
      target.dataset.crewcodeTooltip = text
      target.removeAttribute('title')
      targetRef.current = target
      timerRef.current = window.setTimeout(() => {
        if (targetRef.current !== target || !target.isConnected) return
        const rect = target.getBoundingClientRect()
        const roomAbove = rect.top
        const placement = roomAbove >= 52 ? 'above' : 'below'
        const degrees = 1.5 + Math.random() * 1.5
        setTooltip({
          text,
          x: Math.min(window.innerWidth - 12, Math.max(12, rect.left + rect.width / 2)),
          y: placement === 'above' ? rect.top - 9 : rect.bottom + 9,
          placement,
          tilt: `${Math.random() < 0.5 ? -degrees : degrees}deg`,
        })
      }, SHOW_DELAY_MS)
    }
    const onPointerOut = (event: PointerEvent) => {
      const target = targetRef.current
      if (!target) return
      const next = event.relatedTarget as Node | null
      if (next && target.contains(next)) return
      hide()
    }

    document.addEventListener('pointerover', onPointerOver, true)
    document.addEventListener('pointerout', onPointerOut, true)
    document.addEventListener('pointerdown', hide, true)
    window.addEventListener('blur', hide)
    window.addEventListener('resize', hide)
    return () => {
      hide()
      document.removeEventListener('pointerover', onPointerOver, true)
      document.removeEventListener('pointerout', onPointerOut, true)
      document.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
    }
  }, [])

  if (!tooltip) return null
  return (
    <div
      className={`cc-tooltip cc-tooltip-${tooltip.placement}`}
      role="tooltip"
      style={{
        left: tooltip.x,
        top: tooltip.y,
        ['--cc-tooltip-tilt' as string]: tooltip.tilt,
      }}
    >
      {tooltip.text}
    </div>
  )
}

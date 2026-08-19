import { useCallback, useEffect, useRef, useState } from 'react'

/** Treat "within this many px of the bottom" as pinned. Matches solo chat. */
const BOTTOM_THRESHOLD_PX = 72

export function isNearBottom(el: HTMLElement, threshold = BOTTOM_THRESHOLD_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
}

interface StickToBottom {
  /** Attach to the scrolling element. */
  ref: (el: HTMLDivElement | null) => void
  /** Attach to the element's `onScroll`. */
  onScroll: () => void
  /** True when the user has scrolled up — surface a jump-to-latest affordance. */
  scrolledUp: boolean
  /** Jump to the newest content and re-pin. */
  scrollToBottom: (behavior?: ScrollBehavior) => void
}

/**
 * Keeps a scrolling thread pinned to the newest content while an agent streams,
 * without hijacking the view when the user has deliberately scrolled up to read
 * history. Pinning is re-evaluated from the DOM on every user scroll, so
 * scrolling back down re-arms the follow.
 *
 * `dep` is whatever changes when new content arrives (a message array, a length,
 * a token counter). Scrolling happens in the next animation frame rather than a
 * layout effect so a streaming turn doesn't force a synchronous reflow of the
 * surrounding shell on every appended row.
 */
export function useStickToBottom(dep: unknown, enabled = true): StickToBottom {
  const elRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const [scrolledUp, setScrolledUp] = useState(false)

  const ref = useCallback((el: HTMLDivElement | null) => {
    elRef.current = el
    // A thread can mount already scrolled (restored messages): start at the end.
    if (el) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = elRef.current
    if (!el) return
    pinnedRef.current = true
    setScrolledUp(false)
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [])

  const onScroll = useCallback(() => {
    const el = elRef.current
    if (!el) return
    const pinned = isNearBottom(el)
    pinnedRef.current = pinned
    setScrolledUp(prev => (prev === !pinned ? prev : !pinned))
  }, [])

  useEffect(() => {
    if (!enabled) return undefined
    const frame = requestAnimationFrame(() => {
      const el = elRef.current
      if (!el) return
      if (pinnedRef.current) el.scrollTop = el.scrollHeight
      else setScrolledUp(!isNearBottom(el))
    })
    return () => cancelAnimationFrame(frame)
  }, [dep, enabled])

  return { ref, onScroll, scrolledUp, scrollToBottom }
}

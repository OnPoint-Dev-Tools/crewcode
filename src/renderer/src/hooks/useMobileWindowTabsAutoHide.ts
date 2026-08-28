import { useEffect, useState } from 'react'

const TOP_REVEAL_PX = 4
const MIN_HIDE_SCROLL_TOP_PX = 24
const HIDE_TRAVEL_PX = 28
const SHOW_TRAVEL_PX = 10
const TOUCH_AXIS_LOCK_PX = 6

type ScrollDirection = 'up' | 'down' | null

export interface MobileTabScrollState {
  top: number
  direction: ScrollDirection
  travel: number
}

export interface MobileTabScrollUpdate {
  state: MobileTabScrollState
  visibility: 'hide' | 'show' | null
}

export function initialMobileTabScrollState(top: number): MobileTabScrollState {
  return { top: Math.max(0, top), direction: null, travel: 0 }
}

/**
 * Accumulates deliberate travel in one direction so tiny scroll corrections do
 * not flicker mobile WindowTabs. Returning to the top always reveals them.
 */
export function updateMobileTabScroll(
  previous: MobileTabScrollState,
  nextTopValue: number,
): MobileTabScrollUpdate {
  const nextTop = Math.max(0, nextTopValue)
  if (nextTop <= TOP_REVEAL_PX) {
    return { state: initialMobileTabScrollState(nextTop), visibility: 'show' }
  }

  const delta = nextTop - previous.top
  if (Math.abs(delta) < 0.5) {
    return { state: { ...previous, top: nextTop }, visibility: null }
  }

  const direction: Exclude<ScrollDirection, null> = delta > 0 ? 'down' : 'up'
  const travel = previous.direction === direction
    ? previous.travel + Math.abs(delta)
    : Math.abs(delta)
  const state = { top: nextTop, direction, travel }

  if (direction === 'down' && nextTop >= MIN_HIDE_SCROLL_TOP_PX && travel >= HIDE_TRAVEL_PX) {
    return { state: { ...state, travel: 0 }, visibility: 'hide' }
  }
  if (direction === 'up' && travel >= SHOW_TRAVEL_PX) {
    return { state: { ...state, travel: 0 }, visibility: 'show' }
  }
  return { state, visibility: null }
}

function scrollElementFromEvent(event: Event): HTMLElement | null {
  if (event.target === document) return document.scrollingElement as HTMLElement | null
  return event.target instanceof HTMLElement ? event.target : null
}

const EXCLUDED_SURFACE_SELECTOR = '.window-tabs, .ws-drawer, .ws-dock, .sheet, .menulet, .sysmon, .composer, .picker-sheet, .picker-sheet-backdrop, [role="dialog"]'

function isPrimaryContentScroller(element: HTMLElement): boolean {
  if (element.closest(EXCLUDED_SURFACE_SELECTOR)) return false
  return element.scrollHeight > element.clientHeight + 1
}

function mobileGestureSurface(target: EventTarget | null): HTMLElement | null {
  let element = target instanceof Element ? target : null
  if (!element || element.closest(EXCLUDED_SURFACE_SELECTOR)) return null
  // Do not turn taps or drags on controls into navigation gestures.
  if (element.closest('button, input, textarea, select, a, [contenteditable="true"]')) return null

  const origin = element
  while (element && element !== document.body) {
    if (element instanceof HTMLElement && isPrimaryContentScroller(element)) return element
    element = element.parentElement
  }

  // A short/empty solo chat cannot scroll, but it must still support the
  // explicit swipe-up/swipe-down tab gesture from its content surface.
  return origin.closest<HTMLElement>('.chat-col, .ss-detail, .app-body') ?? null
}

export interface MobileTabSwipeState {
  startX: number
  startY: number
  x: number
  y: number
  downTravel: number
  upTravel: number
  axis: 'pending' | 'horizontal' | 'vertical'
}

export function initialMobileTabSwipeState(x: number, y: number): MobileTabSwipeState {
  return { startX: x, startY: y, x, y, downTravel: 0, upTravel: 0, axis: 'pending' }
}

export function updateMobileTabSwipe(
  previous: MobileTabSwipeState,
  x: number,
  y: number,
): { state: MobileTabSwipeState; visibility: 'hide' | 'show' | null } {
  const dx = x - previous.x
  const dy = y - previous.y
  let axis = previous.axis
  if (axis === 'pending') {
    const totalDx = x - previous.startX
    const totalDy = y - previous.startY
    if (Math.max(Math.abs(totalDx), Math.abs(totalDy)) >= TOUCH_AXIS_LOCK_PX) {
      axis = Math.abs(totalDy) > Math.abs(totalDx) ? 'vertical' : 'horizontal'
    }
  }
  if (axis !== 'vertical') {
    return { state: { ...previous, x, y, axis }, visibility: null }
  }

  // Finger moving down means the content is being scrolled upward: reveal.
  // Finger moving up means content is moving down the page: hide.
  const downTravel = dy > 0 ? previous.downTravel + dy : 0
  const upTravel = dy < 0 ? previous.upTravel + Math.abs(dy) : 0
  const state: MobileTabSwipeState = {
    startX: previous.startX,
    startY: previous.startY,
    x,
    y,
    downTravel,
    upTravel,
    axis,
  }
  if (downTravel >= SHOW_TRAVEL_PX) return { state: { ...state, downTravel: 0 }, visibility: 'show' }
  if (upTravel >= HIDE_TRAVEL_PX) return { state: { ...state, upTravel: 0 }, visibility: 'hide' }
  return { state, visibility: null }
}

interface UseMobileWindowTabsAutoHideOptions {
  enabled: boolean
  locked?: boolean
}

export function useMobileWindowTabsAutoHide({
  enabled,
  locked = false,
}: UseMobileWindowTabsAutoHideOptions): boolean {
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    if (!enabled || locked) setHidden(false)
  }, [enabled, locked])

  useEffect(() => {
    if (!enabled || locked) return

    const scrollStates = new WeakMap<HTMLElement, MobileTabScrollState>()
    let touchSurface: HTMLElement | null = null
    let swipeState: MobileTabSwipeState | null = null

    const onScroll = (event: Event) => {
      const element = scrollElementFromEvent(event)
      if (!element || !isPrimaryContentScroller(element)) return

      const top = element.scrollTop
      const previous = scrollStates.get(element)
      if (!previous) {
        scrollStates.set(element, initialMobileTabScrollState(top))
        if (top <= TOP_REVEAL_PX) setHidden(false)
        return
      }

      const update = updateMobileTabScroll(previous, top)
      scrollStates.set(element, update.state)
      if (update.visibility === 'hide') setHidden(true)
      else if (update.visibility === 'show') setHidden(false)
    }

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return
      touchSurface = mobileGestureSurface(event.target)
      const touch = event.touches[0]
      swipeState = touchSurface ? initialMobileTabSwipeState(touch.clientX, touch.clientY) : null
      if (touchSurface && isPrimaryContentScroller(touchSurface)) {
        scrollStates.set(touchSurface, initialMobileTabScrollState(touchSurface.scrollTop))
      }
    }

    const onTouchMove = (event: TouchEvent) => {
      if (!touchSurface || !swipeState || event.touches.length !== 1) return
      const touch = event.touches[0]
      const update = updateMobileTabSwipe(swipeState, touch.clientX, touch.clientY)
      swipeState = update.state
      if (update.visibility === 'show') setHidden(false)
      else if (update.visibility === 'hide') setHidden(true)
    }

    const clearTouch = () => {
      touchSurface = null
      swipeState = null
    }

    // Scroll does not bubble, but capture observes the thread, Settings detail,
    // editors, and other independently scrolling work surfaces from one place.
    // Touch direction is tracked as a second signal so collapsing the strip or
    // a missed/nested scroll event can never strand it off-screen.
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true })
    document.addEventListener('touchend', clearTouch, true)
    document.addEventListener('touchcancel', clearTouch, true)
    return () => {
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('touchstart', onTouchStart, true)
      document.removeEventListener('touchmove', onTouchMove, true)
      document.removeEventListener('touchend', clearTouch, true)
      document.removeEventListener('touchcancel', clearTouch, true)
    }
  }, [enabled, locked])

  return enabled && !locked && hidden
}

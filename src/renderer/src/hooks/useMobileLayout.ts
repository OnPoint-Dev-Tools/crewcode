import { useEffect, useState } from 'react'

const MOBILE_MAX = 768
const TABLET_MAX = 1024

function readViewport() {
  if (typeof window === 'undefined') return { isMobile: false, isTablet: false }
  const width = window.innerWidth
  return {
    isMobile: width <= MOBILE_MAX,
    isTablet: width > MOBILE_MAX && width <= TABLET_MAX,
  }
}

/**
 * Single source of truth for layout breakpoints across the renderer.
 * Mirrors the CSS breakpoints at 768px and 1024px. Reuses the same resize
 * listener pattern as `useMobileShell` so viewport state cannot drift between
 * shell sheets and responsive component branches.
 */
export function useMobileLayout() {
  const [layout, setLayout] = useState(readViewport)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const check = () => setLayout(readViewport())
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  return layout
}
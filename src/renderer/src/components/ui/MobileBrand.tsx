import { useEffect, useState } from 'react'
import darkLogo from '../../assets/icon-logo-dark.png'
import lightLogo from '../../assets/icon-logo-light.png'

function systemUsesDarkAppearance(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
}

/** Theme-aware CrewCode brand for the Hub's pre-runtime mobile surfaces. */
export function useHubMobileDarkMode(): boolean {
  const [isDark, setIsDark] = useState(systemUsesDarkAppearance)

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent): void => setIsDark(event.matches)
    setIsDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return isDark
}

export function MobileBrand({ isDark }: { isDark: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <img
        src={isDark ? darkLogo : lightLogo}
        alt=""
        aria-hidden="true"
        className="size-9 object-contain"
      />
      <span className="text-xl font-semibold tracking-tight">CrewCode</span>
    </div>
  )
}

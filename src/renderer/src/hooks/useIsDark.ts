import { useEffect, useState } from 'react'
import { useSettings } from './useSettings'

/**
 * Resolves the active light/dark appearance from the app theme setting,
 * tracking the OS preference live while `appTheme === 'system'`. Mirrors the
 * inline resolvers in LoadingScreen/Onboarding/AppMenu so theme-aware emblems
 * (the CrewCode mark, where icon-logo-dark.png is the light-on-dark variant)
 * stay in sync from one source.
 */
export function useIsDark(): boolean {
  const { state: { appTheme } } = useSettings()
  const [isDark, setIsDark] = useState(
    appTheme === 'dark' || (appTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches),
  )
  useEffect(() => {
    if (appTheme !== 'system') { setIsDark(appTheme === 'dark'); return }
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    setIsDark(mq.matches)
    const handler = (e: MediaQueryListEvent): void => setIsDark(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [appTheme])
  return isDark
}

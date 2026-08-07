import { useState, useCallback, useEffect } from 'react'

const STORAGE_KEY = 'crewcode:tweaks:v1'

function loadTweaks<T extends object>(defaults: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return defaults
    const parsed = JSON.parse(raw) as Partial<T>
    return { ...defaults, ...parsed }
  } catch {
    return defaults
  }
}

export function useTweaks<T extends object>(
  defaults: T
): [T, <K extends keyof T>(key: K, value: T[K]) => void] {
  const [state, setState] = useState<T>(() => loadTweaks(defaults))

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* quota */ }
  }, [state])

  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setState(prev => ({ ...prev, [key]: value }))
  }, [])

  return [state, set]
}

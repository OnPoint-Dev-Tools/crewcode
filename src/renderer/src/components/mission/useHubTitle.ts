/**
 * useHubTitle — Mission Control's own hero title, persisted in localStorage.
 *
 * Independent of CrewSession.name (crews keep their own name set in the crew
 * config panel). This lets the user label their Mission Control hub however
 * they want without entangling the two surfaces.
 */
import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'crewcode:mc:hub-title'
export const DEFAULT_HUB_TITLE = 'Crew Workers'

function readTitle(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_HUB_TITLE
    return raw
  } catch {
    return DEFAULT_HUB_TITLE
  }
}

export function useHubTitle(): {
  title: string
  setTitle: (next: string) => void
} {
  const [title, setTitleState] = useState<string>(() => readTitle())

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, title) } catch { /* quota */ }
  }, [title])

  const setTitle = useCallback((next: string): void => {
    setTitleState(next)
  }, [])

  return { title, setTitle }
}

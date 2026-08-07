import { useCallback, useEffect, useState } from 'react'
import type { ModeLevel } from '../types'

const STORAGE_KEY = 'crewcode:appliedModesBySession'

type Map = Record<string, ModeLevel | undefined>

function load(): Map {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Map : {}
  } catch {
    return {}
  }
}

export interface AppliedModesBySession {
  state:            Map
  lastDelivered:    (sessionId: string) => ModeLevel | undefined
  markDelivered:    (sessionId: string, mode: ModeLevel) => void
  forgetSession:    (sessionId: string) => void
}

export function useAppliedModesBySession(): AppliedModesBySession {
  const [state, setState] = useState<Map>(load)

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* quota */ }
  }, [state])

  const lastDelivered = useCallback((sessionId: string): ModeLevel | undefined => {
    return state[sessionId]
  }, [state])

  const markDelivered = useCallback((sessionId: string, mode: ModeLevel): void => {
    setState(prev => ({ ...prev, [sessionId]: mode }))
  }, [])

  const forgetSession = useCallback((sessionId: string): void => {
    setState(prev => {
      if (!(sessionId in prev)) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }, [])

  return { state, lastDelivered, markDelivered, forgetSession }
}

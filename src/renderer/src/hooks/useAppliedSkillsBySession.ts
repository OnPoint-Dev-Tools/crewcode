/**
 * Tracks which skill bodies have already been delivered to which chat session
 * as a system preamble. Each enabled skill is sent exactly once per session;
 * subsequent turns don't re-include it (the agent already has it in context).
 *
 * Persisted to localStorage so the same session resumed in a new app run won't
 * re-send the same skill block.
 */
import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'crewcode:appliedSkillsBySession'

type Map = Record<string, string[]>  // sessionId -> skill IDs

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

export interface AppliedSkillsBySession {
  state:           Map
  delivered:       (sessionId: string, skillId: string) => boolean
  markDelivered:   (sessionId: string, skillIds: string[]) => void
  forgetSession:   (sessionId: string) => void
}

export function useAppliedSkillsBySession(): AppliedSkillsBySession {
  const [state, setState] = useState<Map>(load)

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* quota */ }
  }, [state])

  const delivered = useCallback((sessionId: string, skillId: string): boolean => {
    return (state[sessionId] ?? []).includes(skillId)
  }, [state])

  const markDelivered = useCallback((sessionId: string, skillIds: string[]): void => {
    if (skillIds.length === 0) return
    setState(prev => {
      const cur = new Set(prev[sessionId] ?? [])
      for (const id of skillIds) cur.add(id)
      return { ...prev, [sessionId]: Array.from(cur) }
    })
  }, [])

  const forgetSession = useCallback((sessionId: string): void => {
    setState(prev => {
      if (!(sessionId in prev)) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }, [])

  return { state, delivered, markDelivered, forgetSession }
}

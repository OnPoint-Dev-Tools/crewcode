/**
 * useAllChatSessions — read-only mirror of the persisted `sessionsByTab` map
 * that lives in localStorage under `crewcode:sessionsByTab`.
 *
 * `useChatSessions` only exposes the active tab's sessions, so Mission Control
 * (which spans the whole app) reads the persisted blob directly and refreshes
 * on the `storage` event plus a focus tick.
 */
import { useEffect, useState } from 'react'
import type { Session } from '../../types'

const STORAGE_SESSIONS = 'crewcode:sessionsByTab'

function readSessions(): Record<string, Session[]> {
  try {
    const raw = localStorage.getItem(STORAGE_SESSIONS)
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, Session[]>
  } catch {
    return {}
  }
}

export function useAllChatSessions(refreshKey: unknown = 0): Record<string, Session[]> {
  const [sessions, setSessions] = useState<Record<string, Session[]>>(() => readSessions())

  useEffect(() => {
    setSessions(readSessions())
  }, [refreshKey])

  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === STORAGE_SESSIONS) setSessions(readSessions())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  return sessions
}

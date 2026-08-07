/**
 * useCompletedChats — tracks which chat sessions have actually finished an agent
 * turn, when they finished, and which ones the user has dismissed from the
 * drawer's Completed list. Both maps are persisted, so "completed 3h ago" and a
 * dismissal both survive a restart.
 *
 * Membership is completion-driven ON PURPOSE. This deliberately replaced an
 * older recency rank that seeded every scope holding a transcript, which made
 * the Completed list show chats the user had never worked on and re-show them on
 * every launch. A scope appears here only after a bridge reports a final turn.
 */

import { useCallback, useEffect, useState } from 'react'

import {
  boundCompletedMap,
  forgetScopes,
  parseCompletedMap,
  type CompletedMap,
} from './session-completed-store'

const STORAGE_COMPLETED = 'crewcode:sessionCompletedAt:v1'
const STORAGE_DISMISSED = 'crewcode:completedDismissedAt:v1'

function load(key: string): CompletedMap {
  try {
    return parseCompletedMap(localStorage.getItem(key))
  } catch {
    return {}
  }
}

function persist(key: string, map: CompletedMap): void {
  try {
    localStorage.setItem(key, JSON.stringify(boundCompletedMap(map)))
  } catch {
    /* quota — a lost completion/dismissal stamp is cosmetic, so swallow */
  }
}

export function useCompletedChats() {
  const [completedAtByScope, setCompletedAtByScope] = useState<CompletedMap>(() => load(STORAGE_COMPLETED))
  const [dismissedAtByScope, setDismissedAtByScope] = useState<CompletedMap>(() => load(STORAGE_DISMISSED))

  useEffect(() => { persist(STORAGE_COMPLETED, completedAtByScope) }, [completedAtByScope])
  useEffect(() => { persist(STORAGE_DISMISSED, dismissedAtByScope) }, [dismissedAtByScope])

  // A bridge reported a final turn for this scope.
  const markComplete = useCallback((scope: string) => {
    setCompletedAtByScope(prev => ({ ...prev, [scope]: Date.now() }))
  }, [])

  // Hide a completed chat. Stamping "now" means the next turn to complete has a
  // strictly larger completedAt and re-surfaces the chat on its own.
  const dismiss = useCallback((scope: string) => {
    setDismissedAtByScope(prev => ({ ...prev, [scope]: Date.now() }))
  }, [])

  // Drop scopes whose sessions were deleted, so stale stamps don't linger.
  const forget = useCallback((scopes: string[]) => {
    if (scopes.length === 0) return
    setCompletedAtByScope(prev => forgetScopes(prev, scopes))
    setDismissedAtByScope(prev => forgetScopes(prev, scopes))
  }, [])

  return { completedAtByScope, dismissedAtByScope, markComplete, dismiss, forget }
}

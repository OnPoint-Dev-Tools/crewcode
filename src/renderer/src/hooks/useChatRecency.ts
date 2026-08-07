/**
 * useChatRecency — assigns a monotonic recency rank to chat scopes (session ids)
 * so the next-chat/prev-chat shortcuts can cycle the most recently active chats.
 *
 * A scope's rank bumps when the caller explicitly touches it (user opened it, or
 * a bridge reported a final turn). Scopes never seen stay at rank 0.
 *
 * NOTE: this is recency, NOT completion. The drawer's Completed list must not be
 * built from these ranks — `initialRanks` seeds every scope that merely holds a
 * transcript, which would surface chats the user never worked on. Completion
 * state lives in useCompletedChats.
 */

import { useState, useCallback, useRef } from 'react'

import { useMessagesStore } from '../stores/chat-messages-store'

function initialRanks(): Record<string, number> {
  const scopes = Object.keys(useMessagesStore.getState().messagesByTab)
  const ranks: Record<string, number> = {}
  scopes.forEach((scope, idx) => { ranks[scope] = idx + 1 })
  return ranks
}

export function useChatRecency() {
  const [rankByScope, setRankByScope] = useState<Record<string, number>>(() => initialRanks())
  const seqRef = useRef(Object.keys(rankByScope).length)

  const touch = useCallback((scope: string) => {
    seqRef.current += 1
    const seq = seqRef.current
    setRankByScope(prev => ({ ...prev, [scope]: seq }))
  }, [])

  return { rankByScope, touch }
}

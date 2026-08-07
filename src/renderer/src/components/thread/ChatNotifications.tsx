import { useEffect, useRef, useState } from 'react'

import { useChatNotifications, type GlobalErrorNotice } from '../../hooks/useChatNotifications'
import { useMessagesForScope, useMessagesStore } from '../../stores/chat-messages-store'
import { stableTextKey } from '../../utils/stable-text-key'
import type { Message } from '../../types'

type ShowFn = (n: { type: 'info' | 'warning' | 'error'; message: string; duration?: number }) => void

interface ChatNotificationsProps {
  sessActive: string
  show: ShowFn
}

function errorNoticeForScope(tabId: string, tabMessages: Message[]): GlobalErrorNotice | null {
  for (let i = tabMessages.length - 1; i >= 0; i -= 1) {
    const msg = tabMessages[i]
    if (msg.kind === 'system' && msg.tone === 'error') {
      const text = msg.text.trim()
      if (!text) break
      const prevTurnId = i > 0 && 'turnId' in tabMessages[i - 1] ? (tabMessages[i - 1] as { turnId?: string }).turnId : undefined
      return { key: `err:${tabId}:${prevTurnId ?? stableTextKey(text)}`, text }
    }
  }
  return null
}

function latestErrorFromScopeMap(messagesByTab: Record<string, Message[]>, errorsByScope: Map<string, GlobalErrorNotice | null>): GlobalErrorNotice | null {
  let latestError: GlobalErrorNotice | null = null
  for (const scope of Object.keys(messagesByTab)) {
    const error = errorsByScope.get(scope)
    if (error) latestError = error
  }
  return latestError
}

function initialErrorsByScope(messagesByTab: Record<string, Message[]>): Map<string, GlobalErrorNotice | null> {
  return new Map(Object.entries(messagesByTab).map(([scope, messages]) => [scope, errorNoticeForScope(scope, messages)]))
}

function useLatestGlobalErrorNotice(): GlobalErrorNotice | null {
  const [initial] = useState(() => {
    const messagesByTab = useMessagesStore.getState().messagesByTab
    const errorsByScope = initialErrorsByScope(messagesByTab)
    return { errorsByScope, latestError: latestErrorFromScopeMap(messagesByTab, errorsByScope) }
  })
  const errorsByScopeRef = useRef(initial.errorsByScope)
  const [latestError, setLatestError] = useState(initial.latestError)
  const latestErrorKeyRef = useRef(initial.latestError?.key ?? '')

  useEffect(() => useMessagesStore.subscribe((state, prev) => {
    let changed = false
    const errorsByScope = errorsByScopeRef.current
    for (const scope in state.messagesByTab) {
      if (state.messagesByTab[scope] === prev.messagesByTab[scope]) continue
      errorsByScope.set(scope, errorNoticeForScope(scope, state.messagesByTab[scope] ?? []))
      changed = true
    }
    for (const scope in prev.messagesByTab) {
      if (scope in state.messagesByTab) continue
      errorsByScope.delete(scope)
      changed = true
    }
    if (!changed) return

    const nextLatest = latestErrorFromScopeMap(state.messagesByTab, errorsByScope)
    const nextKey = nextLatest?.key ?? ''
    if (nextKey === latestErrorKeyRef.current) return
    latestErrorKeyRef.current = nextKey
    setLatestError(nextLatest)
  }), [])

  return latestError
}

/**
 * Invisible host that runs the chat notification effects against the message
 * store. It subscribes narrowly so hidden-tab token deltas don't re-render the
 * active shell just to check for notifications. Renders null.
 */
export function ChatNotifications({
  sessActive, show,
}: ChatNotificationsProps): null {
  const messages = useMessagesForScope(sessActive)
  const latestGlobalError = useLatestGlobalErrorNotice()

  useChatNotifications({ messages, latestGlobalError, sessActive, show })
  return null
}

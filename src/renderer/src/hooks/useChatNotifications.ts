import { useEffect, useRef } from 'react'

import { subscribeLiveChatNotices } from '../stores/chat-messages-store'

type ShowFn = (n: { type: 'info' | 'warning' | 'error'; message: string; duration?: number }) => void

export interface UseChatNotificationsOpts {
  sessActive: string
  show: ShowFn
}

export function useChatNotifications({
  sessActive, show,
}: UseChatNotificationsOpts) {
  const activeScopeRef = useRef(sessActive)
  activeScopeRef.current = sessActive

  useEffect(() => {
    return subscribeLiveChatNotices((notice) => {
      if (notice.type === 'warning' && notice.scopeId !== activeScopeRef.current) return
      show({
        type: notice.type,
        message: notice.text,
        duration: notice.type === 'error' ? 5000 : 4200,
      })
    })
  }, [show])
}

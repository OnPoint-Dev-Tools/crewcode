import React, { createContext, useContext, useState, useCallback, useMemo } from 'react'

export type NoticeType = 'info' | 'success' | 'warning' | 'error'

export interface ChatReplyNotice {
  providerId: string
  chatName: string
  preview: string
  workspaceName?: string
}

export interface Notice {
  id: string
  message: string
  type: NoticeType
  duration?: number
  onClick?: () => void
  chatReply?: ChatReplyNotice
}

interface NotificationsCtx {
  notices: Notice[]
  show: (n: Omit<Notice, 'id'>) => string
  dismiss: (id: string) => void
}

const Ctx = createContext<NotificationsCtx | null>(null)

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([])

  const show = useCallback((n: Omit<Notice, 'id'>) => {
    const message = n.message.trim()
    if (!message) return ''
    const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const duration = n.duration === undefined ? 8000 : Math.max(0, n.duration)
    const notice: Notice = { ...n, message, id, duration }
    setNotices(prev => [notice, ...prev].slice(0, 5))
    return id
  }, [])

  const dismiss = useCallback((id: string) => {
    setNotices(prev => prev.filter(x => x.id !== id))
  }, [])

  const value = useMemo(() => ({ notices, show, dismiss }), [notices, show, dismiss])

  return (
    <Ctx.Provider value={value}>
      {children}
    </Ctx.Provider>
  )
}

export function useNotifications(): NotificationsCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useNotifications must be inside NotificationsProvider')
  return ctx
}

/**
 * Shared infrastructure hooks can publish live events when a notification host
 * is present while remaining usable in isolated tests and embedded surfaces.
 */
export function useOptionalNotifications(): NotificationsCtx | null {
  return useContext(Ctx)
}

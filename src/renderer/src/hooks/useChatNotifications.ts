import { useEffect, useRef } from 'react'

import { stableTextKey } from '../utils/stable-text-key'
import type { Message } from '../types'

type ShowFn = (n: { type: 'info' | 'warning' | 'error'; message: string; duration?: number }) => void

export interface GlobalErrorNotice {
  key: string
  text: string
}

export interface UseChatNotificationsOpts {
  messages: Message[]
  latestGlobalError: GlobalErrorNotice | null
  sessActive: string
  show: ShowFn
}

export function useChatNotifications({
  messages, latestGlobalError, sessActive, show,
}: UseChatNotificationsOpts) {
  const lastSoloNoticeRef = useRef<string | null>(null)
  const lastGlobalErrorNoticeRef = useRef<string>('')

  useEffect(() => {
    const latest = messages[messages.length - 1]
    if (!latest) return
    if (latest.kind === 'system' && latest.tone === 'info' && latest.text.startsWith('agent exited')) {
      const text = latest.text.trim()
      const key = `info:${sessActive}:${stableTextKey(text)}`
      if (!text || lastSoloNoticeRef.current === key) return
      lastSoloNoticeRef.current = key
      show({ type: 'warning', message: text, duration: 4200 })
      return
    }
  }, [messages, sessActive, show])

  useEffect(() => {
    if (!latestGlobalError || lastGlobalErrorNoticeRef.current === latestGlobalError.key) return
    lastGlobalErrorNoticeRef.current = latestGlobalError.key
    show({ type: 'error', message: latestGlobalError.text, duration: 5000 })
  }, [latestGlobalError, show])
}

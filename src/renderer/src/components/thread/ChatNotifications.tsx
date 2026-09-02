import { useChatNotifications } from '../../hooks/useChatNotifications'

type ShowFn = (n: { type: 'info' | 'warning' | 'error'; message: string; duration?: number }) => void

interface ChatNotificationsProps {
  sessActive: string
  show: ShowFn
}

/**
 * Invisible host for live chat notification events. Transcript restoration is
 * deliberately not an event source, so startup and session changes stay quiet.
 */
export function ChatNotifications({
  sessActive, show,
}: ChatNotificationsProps): null {
  useChatNotifications({ sessActive, show })
  return null
}

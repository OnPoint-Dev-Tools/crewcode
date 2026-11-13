import { useCallback, useRef, useState } from 'react'

interface PendingSend { scopeId: string }

/** Local startup state ends on Stop, independently of the provider's RPC lifetime. */
export function usePendingChatSend(scopeId: string) {
  const current = useRef<PendingSend | null>(null)
  const [pending, setPending] = useState<PendingSend | null>(null)
  const begin = useCallback(() => {
    const token = { scopeId }
    current.current = token
    setPending(token)
    return token
  }, [scopeId])
  const finish = useCallback((token: PendingSend) => {
    // A stopped startup can settle after a replacement send has already begun.
    if (current.current !== token) return
    current.current = null
    setPending(null)
  }, [])
  const cancel = useCallback(() => {
    if (current.current?.scopeId !== scopeId) return
    current.current = null
    setPending(null)
  }, [scopeId])
  return { pending: pending?.scopeId === scopeId, begin, finish, cancel }
}

import { useEffect, useRef } from 'react'
import { getCrewCodeRuntime } from '../runtime/crewcode-client'
import { updatePolicyToConfig, useSettings } from './useSettings'
import { updaterNoticeForEvent } from './updater-notices'
import { useNotifications } from './useNotifications'

/** Desktop-only: push the user's update policy as soon as App mounts (so the
 *  30s launch check honors channel/auto-download), then mirror available and
 *  downloaded updater events onto the global notification bar. */
export function useUpdaterNotices(onOpenUpdates: () => void): void {
  const { show, dismiss } = useNotifications()
  const { state } = useSettings()
  const lastKeyRef = useRef('')
  const lastIdRef = useRef('')
  const onOpenRef = useRef(onOpenUpdates)
  onOpenRef.current = onOpenUpdates

  useEffect(() => {
    const runtime = getCrewCodeRuntime()
    if (runtime.kind === 'web') return
    void runtime.client.updaterConfigure({
      channel: state.channel,
      ...updatePolicyToConfig(state.updatePolicy),
    })
  }, [state.channel, state.updatePolicy])

  useEffect(() => {
    const runtime = getCrewCodeRuntime()
    if (runtime.kind === 'web') return
    return runtime.client.onUpdaterEvent(event => {
      const notice = updaterNoticeForEvent(event)
      if (!notice || lastKeyRef.current === notice.key) return
      lastKeyRef.current = notice.key
      if (lastIdRef.current) dismiss(lastIdRef.current)
      lastIdRef.current = show({
        type: notice.type,
        message: notice.message,
        duration: 0,
        onClick: () => onOpenRef.current(),
      })
    })
  }, [show, dismiss])
}

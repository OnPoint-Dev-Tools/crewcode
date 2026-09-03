import type { NoticeType } from './useNotifications'
import type { UpdaterEvent } from '../../../shared/updater-types'

export interface UpdaterNotice {
  key: string
  type: NoticeType
  message: string
}

/** Map a main-process updater event onto the in-app notification bar.
 *  Checking, progress, errors, and "already current" stay off the bar so the
 *  30s launch auto-check cannot spam. Available/downloaded are the only states
 *  the user needs without opening Settings. */
export function updaterNoticeForEvent(event: UpdaterEvent): UpdaterNotice | null {
  const version = typeof event.version === 'string' ? event.version.trim() : ''
  if (event.type === 'available') {
    return {
      key: `available:${version || 'unknown'}`,
      type: 'info',
      message: version ? `CrewCode ${version} is available` : 'A CrewCode update is available',
    }
  }
  if (event.type === 'downloaded') {
    return {
      key: `downloaded:${version || 'unknown'}`,
      type: 'success',
      message: version
        ? `CrewCode ${version} is ready · restart to install`
        : 'A CrewCode update is ready · restart to install',
    }
  }
  return null
}

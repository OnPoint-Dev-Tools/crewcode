import { useEffect, useState } from 'react'
import type { AppBuildInfo } from '../../../shared/updater-types'
import { getCrewCodeClient } from '../runtime/crewcode-client'

let cached: AppBuildInfo | null = null
let pending: Promise<AppBuildInfo> | null = null

export function loadAppBuildInfo(): Promise<AppBuildInfo> {
  if (cached) return Promise.resolve(cached)
  if (!pending) {
    pending = getCrewCodeClient().appBuildInfo()
      .then(info => {
        cached = info
        return info
      })
      .finally(() => { pending = null })
  }
  return pending
}

export function useAppBuildInfo(): AppBuildInfo | null {
  const [info, setInfo] = useState<AppBuildInfo | null>(cached)

  useEffect(() => {
    let active = true
    void loadAppBuildInfo().then(value => { if (active) setInfo(value) }).catch(() => undefined)
    return () => { active = false }
  }, [])

  return info
}

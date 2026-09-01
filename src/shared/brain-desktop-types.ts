export const CREWCODE_BRAIN_DESKTOP_VERSION = 1 as const

/**
 * Owner-only rendezvous written by a background Brain for the trusted desktop
 * app on the same machine. Tokens never cross the Hub or browser relay.
 */
export interface BrainDesktopConnection {
  version: typeof CREWCODE_BRAIN_DESKTOP_VERSION
  pid: number
  url: string
  sessionToken: string
  controlToken: string
  startedAt: number
}

export interface BrainDesktopStatus {
  enabled: boolean
  enrolled: boolean
  /** Origin used for machine enrollment; never includes credential secrets. */
  hubOrigin?: string
  /** Exact passkey/browser origin observed from a reachable Hub status endpoint. */
  hubBrowserOrigin?: string
  hubReachable?: boolean
  running: boolean
  attached: boolean
  error?: string
}

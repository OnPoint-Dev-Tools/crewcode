// Shared updater contract. Main owns electron-updater; the renderer owns the
// user's channel/auto-download preference (settings live in renderer
// localStorage, there is no main-side settings store), so the preference has to
// be pushed across IPC rather than read.

export type UpdaterChannel = 'stable' | 'nightly'

export function isUpdaterChannel(value: unknown): value is UpdaterChannel {
  return value === 'stable' || value === 'nightly'
}

export interface UpdaterConfig {
  channel: UpdaterChannel
  /** Mirrors the "Download updates automatically" toggle. */
  autoDownload: boolean
  /**
   * Mirrors the "Install on quit" toggle. When false a downloaded update stays
   * staged until the user explicitly clicks "restart to install", so download
   * and install are independently controllable.
   */
  installOnQuit: boolean
}

// Renderer-facing event shape. Kept narrow so the preload bridge can pass it
// through without re-declaring every electron-updater type.
export interface UpdaterEvent {
  type:
    | 'checking'
    | 'available'
    | 'not-available'
    | 'error'
    | 'progress'
    | 'downloaded'
    | 'unconfigured'
  message?: string
  version?: string
  percent?: number
  bytesPerSecond?: number
}

export interface AppBuildInfo {
  /** app.getVersion() — the packaged version, not package.json at dev time. */
  version: string
  /** Short git SHA injected at build time, or 'dev' outside a build. */
  buildHash: string
  /** False in dev, where electron-updater has no install path to work with. */
  packaged: boolean
}

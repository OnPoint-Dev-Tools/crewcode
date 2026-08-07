import { app, ipcMain, BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { autoUpdater } from 'electron-updater'
import {
  isUpdaterChannel,
  type AppBuildInfo,
  type UpdaterChannel,
  type UpdaterConfig,
  type UpdaterEvent,
} from '../shared/updater-types'

// Injected by electron-vite `define` at build time (see electron.vite.config.ts).
declare const __BUILD_HASH__: string
const BUILD_HASH = typeof __BUILD_HASH__ === 'string' ? __BUILD_HASH__ : 'dev'

function broadcast(event: UpdaterEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updater:event', event)
  }
}

let initialized = false

/**
 * Channel selection maps to prerelease visibility rather than electron-builder
 * named channels: named channels need a separate `<channel>.yml` feed published
 * per train, while GitHub prereleases are a single feed the updater can filter.
 * So nightly = "also consider prereleases", stable = "tagged releases only".
 *
 * allowDowngrade is on for stable so a user switching back from nightly can
 * actually land on the newest stable build; without it a 0.2.0-nightly.3 install
 * would never see 0.2.0 stable, since it does not compare as newer.
 */
function applyConfig(config: UpdaterConfig): void {
  autoUpdater.autoDownload = config.autoDownload
  autoUpdater.autoInstallOnAppQuit = config.installOnQuit
  autoUpdater.allowPrerelease = config.channel === 'nightly'
  autoUpdater.allowDowngrade = config.channel === 'stable'
}

// Conservative until the renderer reports the user's actual preference: never
// pull a prerelease or start an unrequested download on the pre-config window.
const DEFAULT_CONFIG: UpdaterConfig = { channel: 'stable', autoDownload: false, installOnQuit: true }

export function registerUpdaterIpc(): void {
  if (initialized) return
  initialized = true

  applyConfig(DEFAULT_CONFIG)

  autoUpdater.on('checking-for-update',  () => broadcast({ type: 'checking' }))
  autoUpdater.on('update-available',     info => broadcast({ type: 'available', version: info?.version }))
  autoUpdater.on('update-not-available', info => broadcast({ type: 'not-available', version: info?.version }))
  autoUpdater.on('error', err => broadcast({ type: 'error', message: err?.message ?? String(err) }))
  autoUpdater.on('download-progress', p => broadcast({
    type: 'progress',
    percent: Math.round(p.percent),
    bytesPerSecond: Math.round(p.bytesPerSecond),
  }))
  autoUpdater.on('update-downloaded', info => broadcast({ type: 'downloaded', version: info?.version }))

  ipcMain.handle('app:buildInfo', (): AppBuildInfo => ({
    version: app.getVersion(),
    buildHash: BUILD_HASH,
    packaged: app.isPackaged,
  }))
  ipcMain.handle('app:homePath', (): string => homedir())

  ipcMain.handle('updater:configure', (_e, raw: unknown) => {
    // Renderer input is untrusted; a bad channel string must not silently turn
    // into prerelease opt-in.
    const input = (raw ?? {}) as Partial<UpdaterConfig>
    const channel: UpdaterChannel = isUpdaterChannel(input.channel) ? input.channel : 'stable'
    const autoDownload = input.autoDownload === true
    // Defaults true: absent/malformed input must not silently strand a
    // downloaded update as never-installing.
    const installOnQuit = input.installOnQuit !== false
    applyConfig({ channel, autoDownload, installOnQuit })
    return { ok: true, channel, autoDownload, installOnQuit }
  })

  ipcMain.handle('updater:check', async () => {
    if (!app.isPackaged) {
      broadcast({
        type: 'unconfigured',
        message: 'autoUpdater disabled in dev build · package the app to enable',
      })
      return { ok: false, error: 'dev build' }
    }
    try {
      const r = await autoUpdater.checkForUpdates()
      return { ok: true, version: r?.updateInfo?.version ?? null }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      broadcast({ type: 'error', message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('updater:download', async () => {
    if (!app.isPackaged) return { ok: false, error: 'dev build' }
    try {
      await autoUpdater.downloadUpdate()
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('updater:quitAndInstall', () => {
    if (!app.isPackaged) return { ok: false, error: 'dev build' }
    autoUpdater.quitAndInstall()
    return { ok: true }
  })

  // Auto-check 30s after launch so the badge in Settings can pick it up without
  // the user having to press anything. The delay also lets the renderer's
  // `updater:configure` land first, so the check honors the real channel.
  if (app.isPackaged) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => { /* surfaced via 'error' event */ })
    }, 30_000)
  }
}

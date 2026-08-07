/**
 * notify — native OS notifications for agent turn completion.
 *
 * Lives in the main process because Electron's Notification class is the only
 * cross-platform (macOS/Linux/Windows) path that works when the renderer window
 * is unfocused or minimized — which is exactly when these fire. The renderer
 * asks via the `notify:show` IPC; clicking the toast focuses the window and
 * echoes the originating scope back so the renderer can navigate to that chat.
 *
 * Linux caveat: Electron's Notification does synchronous DBus round-trips on
 * the main process (capability probe on isSupported(), server info + show on
 * display). With a slow or DBus-activated notification daemon each toast
 * stalled the entire browser process 0.5–1.1s — input, IPC, and compositor
 * commits included (measured via the event-loop lag monitor). On Linux we
 * therefore spawn `notify-send` so the DBus wait happens in a throwaway child
 * process. Click-to-navigate is preserved via `--action=default=Open`: the
 * child waits for the toast, and clicking its body prints `default` on stdout,
 * which we translate into the same focus + scope echo as an Electron click.
 * Electron Notification remains the path on macOS/Windows and the Linux
 * fallback when notify-send is missing.
 */

import electron from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

const { app, BrowserWindow, ipcMain, nativeImage, Notification } = electron

export interface NativeNotificationPayload {
  title:   string
  body:    string
  silent?: boolean
  // Opaque chat-scope id echoed back to the renderer on click for navigation.
  scopeId?: string
}

// Set once the window's icon path is known so the toast carries the app icon
// on platforms that render one (Windows/Linux). Avoids guessing the path here.
let notificationIconPath: string | null = null
let notificationIcon: Electron.NativeImage | null = null
export function setNotificationIcon(path: string): void {
  notificationIconPath = path
  // Decode once — createFromPath is a sync disk read + decode, too heavy to
  // repeat on every toast.
  notificationIcon = nativeImage.createFromPath(path)
}

const MAX_TITLE = 120
const MAX_BODY  = 400

// Resolved once: PATH probe for notify-send. A handful of existsSync calls at
// first notification beats a DBus round-trip per toast.
let notifySendPath: string | null | undefined
function resolveNotifySend(): string | null {
  if (notifySendPath !== undefined) return notifySendPath
  notifySendPath = null
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, 'notify-send')
    if (existsSync(candidate)) { notifySendPath = candidate; break }
  }
  return notifySendPath
}

// Whether notify-send supports `--action` (libnotify >= 0.7.10). Probed async
// at startup; toasts sent before the probe resolves just omit click handling.
// The probe also validates the binary actually runs: a libnotify version
// mismatch can leave a notify-send on PATH that dies instantly with a symbol
// lookup error (observed in the wild) — treat that as absent and fall back to
// Electron Notification rather than silently dropping every toast.
let notifySendActions = false
export function probeNotifySendCapabilities(): void {
  if (process.platform !== 'linux') return
  const bin = resolveNotifySend()
  if (!bin) return
  try {
    const child = spawn(bin, ['--help'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (d: Buffer) => { out += d.toString() })
    child.on('close', (code) => {
      if (code !== 0 || !out) notifySendPath = null
      else notifySendActions = out.includes('--action')
    })
    child.on('error', () => { notifySendPath = null })
  } catch {
    notifySendPath = null
  }
}

function showViaNotifySend(title: string, body: string, silent: boolean, onClick: () => void): boolean {
  const bin = resolveNotifySend()
  if (!bin) return false
  const args = [
    '--app-name=CrewCode',
    ...(notificationIconPath ? [`--icon=${notificationIconPath}`] : []),
    ...(silent ? ['--hint=boolean:suppress-sound:true'] : []),
    // `default` fires on a toast-body click; the child prints the action id on
    // stdout and exits. With actions the child deliberately lingers for the
    // toast's lifetime — that wait is the whole point of using a child.
    ...(notifySendActions ? ['--action=default=Open'] : []),
    '--',
    title,
    body,
  ]
  try {
    const child = spawn(bin, args, { stdio: ['ignore', notifySendActions ? 'pipe' : 'ignore', 'ignore'] })
    // If the daemon is broken the child eats the wait/failure, not our loop.
    child.on('error', () => { /* Electron fallback handles the next toast */ })
    if (notifySendActions && child.stdout) {
      let out = ''
      child.stdout.on('data', (d: Buffer) => { out += d.toString() })
      child.on('close', () => { if (out.trim() === 'default') onClick() })
    }
    return true
  } catch {
    return false
  }
}

// Electron's isSupported() also probes DBus on Linux — cache the answer.
let notificationSupported: boolean | null = null
function electronNotificationSupported(): boolean {
  if (notificationSupported === null) notificationSupported = Notification.isSupported()
  return notificationSupported
}

export function registerNotificationIpc(): void {
  probeNotifySendCapabilities()

  ipcMain.handle('notify:show', (e, payload: NativeNotificationPayload) => {
    const title = typeof payload?.title === 'string' && payload.title.trim()
      ? payload.title.slice(0, MAX_TITLE)
      : 'CrewCode'
    const body = typeof payload?.body === 'string' ? payload.body.slice(0, MAX_BODY) : ''
    const scopeId = typeof payload?.scopeId === 'string' ? payload.scopeId : undefined
    const silent = payload?.silent === true

    const sender = e.sender
    const handleClick = () => {
      const win = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getAllWindows()[0]
      if (win) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      // macOS needs an explicit app-level focus to surface a backgrounded app.
      if (process.platform === 'darwin') app.focus({ steal: true })
      if (scopeId && !sender.isDestroyed()) sender.send('notify:click', { scopeId })
    }

    if (process.platform === 'linux' && showViaNotifySend(title, body, silent, handleClick)) {
      return { ok: true }
    }

    if (!electronNotificationSupported()) return { ok: false, error: 'notifications unsupported' }

    const notification = new Notification({
      title,
      body,
      silent,
      icon: notificationIcon ?? undefined,
    })

    notification.on('click', handleClick)
    notification.show()
    return { ok: true }
  })
}

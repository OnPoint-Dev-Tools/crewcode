import type { BrowserWindow, Menu, NativeImage, Tray } from 'electron'

export type TrayIconSource = NativeImage | string

export interface SystemTrayDependencies {
  appName: string
  platform: NodeJS.Platform
  createTray: (icon: TrayIconSource) => Tray
  buildMenu: (template: Electron.MenuItemConstructorOptions[]) => Menu
  showWindow: () => void
  quitApp: () => void
}

type RevealableWindow = {
  isDestroyed: () => boolean
  isMinimized: () => boolean
  restore: () => void
  show: () => void
  focus: () => void
  moveTop?: () => void
  setSkipTaskbar?: (skip: boolean) => void
  setAlwaysOnTop?: (flag: boolean) => void
}

/**
 * Remap a hidden/minimized BrowserWindow. Wayland compositors (Hyprland) often
 * ignore a bare `show()` after `hide()` unless the window is forced above the
 * stack for one focus cycle.
 */
export function revealBrowserWindow(window: RevealableWindow, platform: NodeJS.Platform): void {
  if (window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.setSkipTaskbar?.(false)
  window.show()
  if (platform === 'linux') {
    window.setAlwaysOnTop?.(true)
    window.moveTop?.()
    window.focus()
    window.setAlwaysOnTop?.(false)
    return
  }
  window.moveTop?.()
  window.focus()
}

/** Owns the opt-in tray and the close-to-background decision in main. */
export class SystemTrayService {
  private tray: Tray | null = null
  /** Linux SNI/DBusMenu drops click handlers if the JS Menu is garbage-collected. */
  private menu: Menu | null = null
  private backgroundEnabled = false
  private quitting = false

  constructor(private readonly dependencies: SystemTrayDependencies) {}

  configure(enabled: boolean, sourceIcon: NativeImage, iconPath?: string): void {
    this.backgroundEnabled = enabled
    if (!enabled) {
      this.destroyTray()
      return
    }
    if (this.tray) return

    const size = this.dependencies.platform === 'darwin' ? 18 : 16
    const trayIcon = sourceIcon.resize({ width: size, height: size })
    if (this.dependencies.platform === 'darwin') trayIcon.setTemplateImage(true)
    // Linux StatusNotifier hosts are more reliable with a file path than a
    // resized in-memory pixmap, which can paint an icon that ignores activation.
    const traySource: TrayIconSource =
      this.dependencies.platform === 'linux' && iconPath ? iconPath : trayIcon

    const tray = this.dependencies.createTray(traySource)
    tray.setToolTip(this.dependencies.appName)
    this.menu = this.dependencies.buildMenu([
      { label: 'Open CrewCode', click: () => this.dependencies.showWindow() },
      { type: 'separator' },
      {
        label: 'Quit CrewCode',
        click: () => {
          this.prepareToQuit()
          this.dependencies.quitApp()
        },
      },
    ])
    tray.setContextMenu(this.menu)
    // Windows and Linux restore from the tray icon. Linux SNI "Activate" is
    // usually a single click, not a double-click; keep both. macOS uses the
    // explicit menu and retains its Dock icon.
    if (this.dependencies.platform !== 'darwin') {
      tray.on('click', () => this.dependencies.showWindow())
      tray.on('double-click', () => this.dependencies.showWindow())
    }
    this.tray = tray
  }

  interceptClose(event: Electron.Event, window: BrowserWindow): boolean {
    if (!this.backgroundEnabled || this.quitting) return false
    event.preventDefault()
    window.hide()
    return true
  }

  keepsProcessAlive(): boolean {
    return this.backgroundEnabled && !this.quitting
  }

  prepareToQuit(): void {
    this.quitting = true
  }

  dispose(): void {
    this.destroyTray()
  }

  private destroyTray(): void {
    this.tray?.destroy()
    this.tray = null
    this.menu = null
  }
}

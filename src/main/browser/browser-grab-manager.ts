import { webContents, WebContents } from 'electron'
import type {
  BrowserAwaitGrabSelectionArgs,
  BrowserAwaitGrabSelectionResult,
  BrowserCancelGrabArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverArgs,
  BrowserExtractHoverResult,
  BrowserGrabResult,
  BrowserSetGrabModeArgs,
} from '../../shared/browser-grab-types'
import { captureBrowserSelectionScreenshot } from './browser-grab-screenshot'
import { buildGrabGuestScript } from './grab-guest-script'

interface ActiveGrabSession {
  browserTabId: string
  guestWebContentsId: number
  opId: string | null
}

function errorResult(error: string): BrowserGrabResult {
  return { ok: false, error }
}

function resolveGuest(guestWebContentsId: number): WebContents | null {
  try {
    const guest = webContents.fromId(guestWebContentsId)
    return guest && !guest.isDestroyed() ? guest : null
  } catch {
    return null
  }
}

export class BrowserGrabManager {
  private sessions = new Map<string, ActiveGrabSession>()

  private getGuest(guestWebContentsId: number): WebContents | null {
    return resolveGuest(guestWebContentsId)
  }

  async setGrabMode(args: BrowserSetGrabModeArgs): Promise<BrowserGrabResult> {
    const guest = this.getGuest(args.guestWebContentsId)
    if (!guest) return errorResult('browser page is no longer available')

    try {
      if (args.enabled) {
        const existing = this.sessions.get(args.browserTabId)
        if (existing && existing.guestWebContentsId !== args.guestWebContentsId) {
          await this.cancelGrab(existing)
        }

        this.sessions.set(args.browserTabId, {
          browserTabId: args.browserTabId,
          guestWebContentsId: args.guestWebContentsId,
          opId: null,
        })
        await guest.executeJavaScript(buildGrabGuestScript({ action: 'arm' }), true)
      } else {
        this.sessions.delete(args.browserTabId)
        await guest.executeJavaScript(buildGrabGuestScript({ action: 'teardown' }), true)
      }
      return { ok: true }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }
  }

  async awaitGrabSelection(args: BrowserAwaitGrabSelectionArgs): Promise<BrowserAwaitGrabSelectionResult> {
    const guest = this.getGuest(args.guestWebContentsId)
    if (!guest) return { ok: false, error: 'browser page is no longer available' }

    const opId = args.opId ?? `grab-${Date.now()}`
    this.sessions.set(args.browserTabId, {
      browserTabId: args.browserTabId,
      guestWebContentsId: args.guestWebContentsId,
      opId,
    })

    try {
      await guest.executeJavaScript(buildGrabGuestScript({ action: 'arm' }), true)
      const selection = await guest.executeJavaScript(buildGrabGuestScript({ action: 'awaitClick', opId }), true)
      this.sessions.delete(args.browserTabId)
      return { ok: true, selection }
    } catch (error) {
      this.sessions.delete(args.browserTabId)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async cancelGrab(args: BrowserCancelGrabArgs | ActiveGrabSession): Promise<BrowserGrabResult> {
    this.sessions.delete(args.browserTabId)
    const guest = this.getGuest(args.guestWebContentsId)
    if (!guest) return { ok: true }

    try {
      await guest.executeJavaScript(buildGrabGuestScript({ action: 'cancel' }), true).catch(() => ({ ok: true }))
      await guest.executeJavaScript(buildGrabGuestScript({ action: 'teardown' }), true).catch(() => ({ ok: true }))
      return { ok: true }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error))
    }
  }

  async extractHover(args: BrowserExtractHoverArgs): Promise<BrowserExtractHoverResult> {
    const guest = this.getGuest(args.guestWebContentsId)
    if (!guest) return { ok: false, error: 'browser page is no longer available' }

    try {
      const selection = await guest.executeJavaScript(buildGrabGuestScript({ action: 'extractHover' }), true)
      return { ok: true, selection }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async captureSelectionScreenshot(
    args: BrowserCaptureSelectionScreenshotArgs,
  ): Promise<BrowserCaptureSelectionScreenshotResult> {
    const guest = this.getGuest(args.guestWebContentsId)
    if (!guest) return { ok: false, error: 'browser page is no longer available' }
    return captureBrowserSelectionScreenshot(guest, args)
  }
}

export const browserGrabManager = new BrowserGrabManager()

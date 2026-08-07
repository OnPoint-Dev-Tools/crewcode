import { promises as fs } from 'fs'
import os from 'os'
import { join } from 'path'
import { WebContents } from 'electron'
import type {
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
} from '../../shared/browser-grab-types'

interface ViewportMetrics {
  viewportWidth: number
  viewportHeight: number
}

async function getViewportMetrics(guest: WebContents): Promise<ViewportMetrics> {
  return guest.executeJavaScript(`({ viewportWidth: window.innerWidth, viewportHeight: window.innerHeight })`, true)
}

export async function captureBrowserSelectionScreenshot(
  guest: WebContents,
  args: BrowserCaptureSelectionScreenshotArgs,
): Promise<BrowserCaptureSelectionScreenshotResult> {
  const rect = args.rectViewport
  if (rect.width <= 0 || rect.height <= 0) {
    return { ok: false, error: 'selection rectangle must be larger than zero' }
  }

  try {
    const [metrics, image, page] = await Promise.all([
      getViewportMetrics(guest),
      guest.capturePage(),
      guest.executeJavaScript(`({
        url: window.location.href,
        title: document.title,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        capturedAt: new Date().toISOString(),
      })`, true),
    ])

    const imageSize = image.getSize()
    const scaleX = metrics.viewportWidth > 0 ? imageSize.width / metrics.viewportWidth : 1
    const scaleY = metrics.viewportHeight > 0 ? imageSize.height / metrics.viewportHeight : 1

    const cropRect = {
      x: Math.max(0, Math.round(rect.x * scaleX)),
      y: Math.max(0, Math.round(rect.y * scaleY)),
      width: Math.max(1, Math.round(rect.width * scaleX)),
      height: Math.max(1, Math.round(rect.height * scaleY)),
    }

    const cropped = image.crop(cropRect)
    const pngBuffer = cropped.toPNG()
    const filePath = join(os.tmpdir(), `crewcode-screenshot-${Date.now()}.png`)
    await fs.writeFile(filePath, pngBuffer)

    return {
      ok: true,
      screenshot: {
        page,
        rectViewport: rect,
        imageDataUrl: cropped.toDataURL(),
        filePath,
        mimeType: 'image/png',
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }
}

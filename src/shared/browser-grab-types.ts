export interface BrowserGrabRect {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserGrabPageMetadata {
  url: string
  title: string
  viewportWidth: number
  viewportHeight: number
  scrollX: number
  scrollY: number
  capturedAt: string
}

export interface BrowserGrabTarget {
  tagName: string
  selector: string
  textSnippet: string
  htmlSnippet: string
  attributes: Record<string, string>
  rectViewport: BrowserGrabRect
  rectPage: BrowserGrabRect
  computedStyles: Record<string, string>
}

export interface BrowserGrabSelectionPayload {
  page: BrowserGrabPageMetadata
  target: BrowserGrabTarget
  nearbyText: string[]
  ancestorPath: string[]
}

export interface BrowserGrabScreenshotPayload {
  page: BrowserGrabPageMetadata
  rectViewport: BrowserGrabRect
  imageDataUrl: string
  filePath: string
  mimeType: 'image/png'
}

export interface BrowserGrabGuestRef {
  browserTabId: string
  guestWebContentsId: number
}

export interface BrowserSetGrabModeArgs extends BrowserGrabGuestRef {
  enabled: boolean
}

export interface BrowserAwaitGrabSelectionArgs extends BrowserGrabGuestRef {
  opId?: string
}

export interface BrowserCancelGrabArgs extends BrowserGrabGuestRef {}

export interface BrowserCaptureSelectionScreenshotArgs extends BrowserGrabGuestRef {
  rectViewport: BrowserGrabRect
}

export interface BrowserExtractHoverArgs extends BrowserGrabGuestRef {}

export interface BrowserGrabResult {
  ok: boolean
  error?: string
}

export interface BrowserAwaitGrabSelectionResult extends BrowserGrabResult {
  selection?: BrowserGrabSelectionPayload | null
}

export interface BrowserExtractHoverResult extends BrowserGrabResult {
  selection?: BrowserGrabSelectionPayload | null
}

export interface BrowserCaptureSelectionScreenshotResult extends BrowserGrabResult {
  screenshot?: BrowserGrabScreenshotPayload
}

import React, { useRef, useEffect, useState, useCallback } from 'react'
import type { BrowserGrabRect } from '../../../../shared/browser-grab-types'
import type { RegisteredPluginBrowserAction } from '../../../../shared/plugin-types'
import type { BrowserSessionMode } from '../../types'
import { useNotifications } from '@renderer/hooks/useNotifications'
import { BrowserRegionOverlay } from './BrowserRegionOverlay'
import { copyBrowserGrabToClipboard, copyBrowserScreenshotPathToClipboard } from './browser-grab-format'
import { Icon } from '../ui/Icon'

interface BrowserTabProps {
  tabId: string
  initialUrl?: string
  sessionMode: BrowserSessionMode
  onNewTab?: (url: string) => void
  onNavigateTab?: (url: string) => void
  onSessionModeChange?: (mode: BrowserSessionMode) => void
  pluginBrowserActions?: RegisteredPluginBrowserAction[]
  onPluginBrowserAction?: (target: { pluginId: string; sidebarPanel?: string; tab?: string; command?: string }, browserUrl: string) => void
}

const DEFAULT_URL = 'https://duckduckgo.com'
const SESSION_STORAGE_KEY = (id: string) => `crewcode:browser:${id}`
const sanitizePartitionId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '-')

function getInitialBrowserUrl(tabId: string, initialUrl?: string): string {
  return sessionStorage.getItem(SESSION_STORAGE_KEY(tabId)) || initialUrl || DEFAULT_URL
}
const WEBVIEW_PARTITION = (id: string, mode: BrowserSessionMode) => (
  mode === 'shared'
    ? 'persist:crewcode-browser-shared'
    : `crewcode-browser-isolated-${sanitizePartitionId(id)}`
)

function normalizeUrl(target: string): string {
  let u = target.trim()
  if (!u) return ''
  if (/^https?:\/\//i.test(u)) return u
  // `localhost:5173` looks like a custom scheme to the generic protocol regex,
  // so recognize loopback host:port forms before treating `name:` as a scheme.
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/.*)?$/i.test(u)) return `http://${u}`
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(u)) return ''
  return u.includes('.') && !u.includes(' ')
    ? `https://${u}`
    : `https://duckduckgo.com/?q=${encodeURIComponent(u)}`
}

export function BrowserTab({ tabId, initialUrl, sessionMode, onNewTab, onNavigateTab, onSessionModeChange, pluginBrowserActions = [], onPluginBrowserAction }: BrowserTabProps) {
  const webviewHostRef = useRef<HTMLDivElement>(null)
  const wvRef = useRef<any>(null)
  const onNewTabRef = useRef(onNewTab)
  const onNavigateTabRef = useRef(onNavigateTab)
  const guestWebContentsIdRef = useRef<number | null>(null)
  const initializedTabRef = useRef<string | null>(null)
  const { show } = useNotifications()
  const showRef = useRef(show)
  const [url, setUrl] = useState(() => getInitialBrowserUrl(tabId, initialUrl))
  const [inputUrl, setInputUrl] = useState(() => getInitialBrowserUrl(tabId, initialUrl))
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [guestWebContentsId, setGuestWebContentsId] = useState<number | null>(null)
  const [grabActive, setGrabActive] = useState(false)
  const [grabBusy, setGrabBusy] = useState(false)
  const [grabIntent, setGrabIntent] = useState<'clipboard' | 'send' | null>(null)
  const [regionActive, setRegionActive] = useState(false)

  useEffect(() => { onNewTabRef.current = onNewTab }, [onNewTab])
  useEffect(() => { onNavigateTabRef.current = onNavigateTab }, [onNavigateTab])
  useEffect(() => { showRef.current = show }, [show])
  useEffect(() => { guestWebContentsIdRef.current = guestWebContentsId }, [guestWebContentsId])

  const getGrabArgs = useCallback(() => {
    const currentGuestWebContentsId = guestWebContentsIdRef.current
    if (!currentGuestWebContentsId) return null
    return { browserTabId: tabId, guestWebContentsId: currentGuestWebContentsId }
  }, [tabId])

  const cancelInteractiveModes = useCallback(async (silent = false) => {
    setRegionActive(false)

    const args = getGrabArgs()
    setGrabActive(false)
    setGrabBusy(false)
    setGrabIntent(null)

    if (args) await window.electronAPI?.browserCancelGrab(args).catch(() => undefined)
    if (!silent) showRef.current({ type: 'info', message: 'browser selection cancelled', duration: 2400 })
  }, [getGrabArgs])

  useEffect(() => {
    // Only re-init when the tab identity changes (tab switch/reuse). Reacting to
    // initialUrl alone clobbers user-typed navigation: navigate() echoes the new
    // URL to the parent → initialUrl changes → this would setUrl() back to the
    // stale sessionStorage value before the webview's did-navigate writes it.
    if (initializedTabRef.current === tabId) return
    initializedTabRef.current = tabId
    const nextUrl = getInitialBrowserUrl(tabId, initialUrl)
    setUrl(nextUrl)
    setInputUrl(nextUrl)
  }, [tabId, initialUrl])

  useEffect(() => {
    if (!webviewHostRef.current || wvRef.current) return
    const wv = document.createElement('webview') as any
    wv.style.width = '100%'
    wv.style.height = '100%'
    wv.style.border = 'none'
    // Electron only honors partition when it is set before the first src load.
    wv.setAttribute('partition', WEBVIEW_PARTITION(tabId, sessionMode))
    // Recreate the webview when session mode changes because Electron binds
    // storage isolation at webview creation time, not after navigation starts.

    const persistUrl = (nextUrl: string) => {
      setUrl(nextUrl)
      setInputUrl(nextUrl)
      sessionStorage.setItem(SESSION_STORAGE_KEY(tabId), nextUrl)
      onNavigateTabRef.current?.(nextUrl)
    }

    const syncNavState = () => {
      try {
        setCanGoBack(wv.canGoBack())
        setCanGoForward(wv.canGoForward())
      } catch {
        setCanGoBack(false)
        setCanGoForward(false)
      }
    }

    const onNavigate = (e: any) => {
      const nextUrl = e.url || e.detail?.url || wv.src
      if (typeof nextUrl === 'string' && /^https?:\/\//i.test(nextUrl)) persistUrl(nextUrl)
      syncNavState()
      void cancelInteractiveModes(true)
    }

    const onDomReady = () => {
      syncNavState()
      try { setGuestWebContentsId(wv.getWebContentsId()) } catch { setGuestWebContentsId(null) }
    }
    const onStartLoad = () => {
      setIsLoading(true)
      void cancelInteractiveModes(true)
    }
    const onStopLoad = () => {
      setIsLoading(false)
      syncNavState()
      try { setGuestWebContentsId(wv.getWebContentsId()) } catch { setGuestWebContentsId(null) }
    }

    const onWillNavigate = (e: any) => {
      const nextUrl = e.url || e.detail?.url
      if (!nextUrl) return
      if (!/^https?:\/\//i.test(nextUrl)) {
        e.preventDefault?.()
        window.electronAPI?.openExternal?.(nextUrl)
      }
    }

    const onDidFailLoad = (e: any) => {
      const code = Number(e?.errorCode ?? e?.detail?.errorCode ?? 0)
      if (code === -3) return
      setIsLoading(false)
      const failingUrl = e?.validatedURL || e?.detail?.validatedURL || e?.url || e?.detail?.url || url
      showRef.current({
        type: 'error',
        message: `browser load failed: ${failingUrl}`,
        duration: 4200,
      })
    }

    const onNewWindow = (e: any) => {
      e.preventDefault?.()
      const nextUrl = e.url || e.detail?.url
      if (!nextUrl) return
      if (/^https?:\/\//i.test(nextUrl)) onNewTabRef.current?.(nextUrl)
      else window.electronAPI?.openExternal?.(nextUrl)
    }

    wv.addEventListener('will-navigate', onWillNavigate)
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-start-loading', onStartLoad)
    wv.addEventListener('did-stop-loading', onStopLoad)
    wv.addEventListener('did-fail-load', onDidFailLoad)
    wv.addEventListener('new-window', onNewWindow)

    webviewHostRef.current.appendChild(wv)
    wvRef.current = wv

    return () => {
      void cancelInteractiveModes(true)
      wv.removeEventListener('will-navigate', onWillNavigate)
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('dom-ready', onDomReady)
      wv.removeEventListener('did-start-loading', onStartLoad)
      wv.removeEventListener('did-stop-loading', onStopLoad)
      wv.removeEventListener('did-fail-load', onDidFailLoad)
      wv.removeEventListener('new-window', onNewWindow)
      wvRef.current = null
      setGuestWebContentsId(null)
      try { webviewHostRef.current?.removeChild(wv) } catch {}
    }
  }, [cancelInteractiveModes, sessionMode, tabId])

  useEffect(() => {
    const wv = wvRef.current
    if (!wv || !url) return
    if (wv.src !== url) {
      wv.src = url
      setInputUrl(url)
    }
  }, [sessionMode, tabId, url])

  useEffect(() => {
    if (!grabActive && !regionActive) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void cancelInteractiveModes()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cancelInteractiveModes, grabActive, regionActive])

  const navigate = useCallback((target: string) => {
    const nextUrl = normalizeUrl(target)
    if (!nextUrl) return
    setUrl(nextUrl)
    onNavigateTabRef.current?.(nextUrl)
  }, [])

  const goBack = useCallback(() => {
    try { wvRef.current?.goBack() } catch { /* ignore */ }
  }, [])

  const goForward = useCallback(() => {
    try { wvRef.current?.goForward() } catch { /* ignore */ }
  }, [])

  const reload = useCallback(() => {
    try { wvRef.current?.reload() } catch { /* ignore */ }
  }, [])

  const stop = useCallback(() => {
    try { wvRef.current?.stop() } catch { /* ignore */ }
  }, [])

  const openDevTools = useCallback(() => {
    try { wvRef.current?.openDevTools() } catch { /* ignore */ }
  }, [])

  const startGrab = useCallback(async (intent: 'clipboard' | 'send') => {
    if (grabActive && grabIntent === intent) {
      await cancelInteractiveModes()
      return
    }

    if (grabActive && grabIntent !== intent) {
      await cancelInteractiveModes(true)
    }

    const args = getGrabArgs()
    if (!args) {
      show({ type: 'warning', message: 'browser page is still loading', duration: 2600 })
      return
    }

    setRegionActive(false)
    setGrabIntent(intent)
    setGrabActive(true)
    setGrabBusy(true)

    const api = window.electronAPI
    try {
      const armed = await api?.browserSetGrabMode({ ...args, enabled: true })
      if (!armed?.ok) throw new Error(armed?.error || 'failed to arm page selection')

      const result = await api?.browserAwaitGrabSelection({ ...args, opId: `${tabId}:${Date.now()}` })
      if (!result?.ok) throw new Error(result?.error || 'page selection failed')
      if (!result.selection) {
        show({ type: 'info', message: 'browser selection cancelled', duration: 2400 })
        return
      }

      const text = await copyBrowserGrabToClipboard(result.selection)
      if (intent === 'send') {
        // Keep plain grab fast; only the explicit send flow should open the modal.
        window.dispatchEvent(new CustomEvent('crewcode:browser-grab', { detail: { kind: 'selection', action: 'send', selection: result.selection, text } }))
        show({ type: 'success', message: 'page context copied · choose a chat target', duration: 3200 })
      } else {
        show({ type: 'success', message: 'page context copied to clipboard', duration: 2800 })
      }
    } catch (error) {
      show({ type: 'error', message: error instanceof Error ? error.message : 'browser selection failed', duration: 4200 })
    } finally {
      await api?.browserCancelGrab(args).catch(() => undefined)
      setGrabBusy(false)
      setGrabActive(false)
      setGrabIntent(null)
    }
  }, [cancelInteractiveModes, getGrabArgs, grabActive, grabIntent, show, tabId])

  const startRegion = useCallback(() => {
    if (regionActive) {
      void cancelInteractiveModes()
      return
    }

    if (!guestWebContentsId) {
      show({ type: 'warning', message: 'browser page is still loading', duration: 2600 })
      return
    }

    setGrabActive(false)
    setGrabBusy(false)
    setGrabIntent(null)
    setRegionActive(true)
  }, [cancelInteractiveModes, guestWebContentsId, regionActive, show])

  const captureRegion = useCallback(async (rectViewport: BrowserGrabRect) => {
    const args = getGrabArgs()
    if (!args) {
      setRegionActive(false)
      show({ type: 'warning', message: 'browser page is no longer available', duration: 2600 })
      return
    }

    setRegionActive(false)
    setGrabBusy(true)

    try {
      const result = await window.electronAPI?.browserCaptureSelectionScreenshot({ ...args, rectViewport })
      if (!result?.ok || !result.screenshot) throw new Error(result?.error || 'failed to capture screenshot')

      const filePath = await copyBrowserScreenshotPathToClipboard(result.screenshot)
      window.dispatchEvent(new CustomEvent('crewcode:browser-grab', { detail: { kind: 'screenshot', screenshot: result.screenshot, filePath } }))
      show({ type: 'success', message: `region screenshot saved: ${filePath}`, duration: 4200 })
    } catch (error) {
      show({ type: 'error', message: error instanceof Error ? error.message : 'failed to capture screenshot', duration: 4200 })
    } finally {
      setGrabBusy(false)
    }
  }, [getGrabArgs, show])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      navigate(inputUrl)
    }
  }

  return (
    <div className="browser-shell">
      <div className="browser-bar">
        <div className="browser-nav">
          <button
            className="ibtn"
            title="Back"
            disabled={!canGoBack}
            onClick={goBack}
          >
            <Icon name="chevLeft" size={12} />
          </button>
          <button
            className="ibtn"
            title="Forward"
            disabled={!canGoForward}
            onClick={goForward}
          >
            <Icon name="chevRight" size={12} />
          </button>
          <button
            className="ibtn"
            title={isLoading ? 'Stop' : 'Reload'}
            onClick={isLoading ? stop : reload}
          >
            <Icon name={isLoading ? 'x' : 'refresh'} size={12} />
          </button>
        </div>
        <input
          className="browser-url"
          type="text"
          value={inputUrl}
          onChange={e => setInputUrl(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search or enter address"
        />
        <div className="browser-tools">
          <button
            className={`ibtn browser-tool-btn ${grabActive && grabIntent === 'clipboard' ? 'on' : ''}`}
            title={grabActive && grabIntent === 'clipboard' ? 'Cancel element grab' : 'Grab element context'}
            disabled={grabBusy && !(grabActive && grabIntent === 'clipboard')}
            onClick={() => void startGrab('clipboard')}
          >
            <Icon name="target" size={12} />
            <span>Grab</span>
          </button>
          <button
            className={`ibtn browser-tool-btn ${grabActive && grabIntent === 'send' ? 'on' : ''}`}
            title={grabActive && grabIntent === 'send' ? 'Cancel grab + send' : 'Grab element, add comment, send to chat'}
            disabled={grabBusy && !(grabActive && grabIntent === 'send')}
            onClick={() => void startGrab('send')}
          >
            <Icon name="chat" size={12} />
            <span>Grab+Comment</span>
          </button>
          <button
            className={`ibtn browser-tool-btn ${regionActive ? 'on' : ''}`}
            title={regionActive ? 'Cancel region capture' : 'Capture region screenshot'}
            disabled={grabBusy && !regionActive}
            onClick={startRegion}
          >
            <Icon name="square" size={12} />
            <span>Screenshot</span>
          </button>
          <button
            className={`ibtn browser-tool-btn ${sessionMode === 'shared' ? 'on' : ''}`}
            title={sessionMode === 'shared' ? 'Using shared browser profile' : 'Using isolated temporary session'}
            disabled={grabBusy}
            onClick={() => onSessionModeChange?.(sessionMode === 'shared' ? 'isolated' : 'shared')}
          >
            <Icon name="globe" size={12} />
            <span>{sessionMode === 'shared' ? 'shared' : 'isolated'}</span>
          </button>
          {pluginBrowserActions.map(action => (
            <button
              key={action.registrationId}
              className="ibtn browser-tool-btn"
              title={`${action.title} · ${action.pluginId}`}
              disabled={grabBusy}
              onClick={() => onPluginBrowserAction?.(action, url)}
            >
              <Icon name={(action.icon as any) ?? 'target'} size={12} />
              <span>{action.title}</span>
            </button>
          ))}
          {(grabActive || regionActive) && (
            <button
              className="ibtn browser-tool-btn"
              title="Cancel browser tool"
              onClick={() => void cancelInteractiveModes()}
            >
              <Icon name="x" size={12} />
              <span>cancel</span>
            </button>
          )}
          <button
            className="ibtn"
            title="Open DevTools"
            onClick={openDevTools}
          >
            <Icon name="code" size={12} />
          </button>
        </div>
      </div>
      <div className="browser-body">
        <div ref={webviewHostRef} className="browser-webview-host" />
        <BrowserRegionOverlay
          active={regionActive}
          onCancel={() => setRegionActive(false)}
          onComplete={(rect) => void captureRegion(rect)}
        />
      </div>
    </div>
  )
}

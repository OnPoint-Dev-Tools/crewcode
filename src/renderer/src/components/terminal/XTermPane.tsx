import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import type { ITerminalAddon } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

import { monoFontStack, resolveTerminalFont, type Gpu } from '../../hooks/useSettings'

// Browsers hard-cap live WebGL contexts (~16 in Chromium); past that the oldest
// context is force-lost, which cascades into contextLost→dispose churn across
// every terminal. With many agent terminals open that thrash is a primary source
// of Workbench jank. Budget WebGL to a safe count and let overflow terminals use
// xterm's built-in renderer, which needs no extra WebGL context.
const MAX_WEBGL_CONTEXTS = 8
let activeWebglContexts = 0
// addon → decrement callback, so disposal from any site (unmount, GPU-toggle,
// async context loss) frees exactly one budget slot and never double-frees.
const webglReleaseByAddon = new Map<ITerminalAddon, () => void>()

function releaseRenderer(addon: ITerminalAddon | null): void {
  if (!addon) return
  webglReleaseByAddon.get(addon)?.()
  try { addon.dispose() } catch { /* already gone */ }
}

// Pick a renderer per the user's GPU setting. Returns null on 'off', when the
// WebGL budget is exhausted, or when initialization fails; xterm then keeps its
// built-in renderer. The old CanvasAddon fallback only supports xterm 5.
function loadRenderer(term: Terminal, gpu: Gpu): ITerminalAddon | null {
  if (gpu === 'off') return null

  const tryWebgl = (): WebglAddon | null => {
    // Over budget — skip WebGL so this terminal keeps the built-in renderer.
    if (activeWebglContexts >= MAX_WEBGL_CONTEXTS) return null
    try {
      const addon = new WebglAddon()
      // Some drivers report success then immediately fire contextLost; treat
      // that as a failed init and fall through.
      let lost = false
      let counted = false
      const release = (): void => {
        if (!counted) return
        counted = false
        activeWebglContexts = Math.max(0, activeWebglContexts - 1)
        webglReleaseByAddon.delete(addon)
      }
      addon.onContextLoss(() => { lost = true; release(); try { addon.dispose() } catch { /* already gone */ } })
      term.loadAddon(addon)
      if (lost) return null   // never counted; context died during load
      activeWebglContexts++
      counted = true
      webglReleaseByAddon.set(addon, release)
      return addon
    } catch {
      return null
    }
  }

  return tryWebgl()
}
import { Icon } from '../ui/Icon'
import type { PtyPane } from '../../types'
import { useSettings } from '../../hooks/useSettings'
import { providerImageClass } from '../composer/provider-meta'

import claudeIcon   from '../../assets/claude-color.svg'
import openaiIcon   from '../../assets/openai.svg'
import piIcon       from '../../assets/pi.svg'
import opencodeIcon from '../../assets/opencode.svg'
import hermesIcon   from '../../assets/hermes.png'
import crewCoderIcon from '../../assets/icon-logo-light.png'

const AGENT_ICONS: Record<string, string> = {
  claude:   claudeIcon,
  codex:    openaiIcon,
  pi:       piIcon,
  opencode: opencodeIcon,
  hermes:   hermesIcon,
  crewcoder: crewCoderIcon,
}

const SHIFT_ENTER_SEQUENCE = '\x1b\r'
const TERMINAL_SCROLLBACK_ROWS = 20_000
const MIN_VISIBLE_TERMINAL_PX = 20

function hostHasUsableSize(host: HTMLElement): boolean {
  const rect = host.getBoundingClientRect()
  return rect.width >= MIN_VISIBLE_TERMINAL_PX && rect.height >= MIN_VISIBLE_TERMINAL_PX
}

function projectNameFromPath(cwd: string, fallback: string): string {
  const cleaned = cwd.trim().replace(/[\\/]+$/, '')
  if (!cleaned) return fallback
  const parts = cleaned.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? fallback
}

export interface TerminalClipboardActions {
  hasSelection: () => boolean
  copySelection: () => Promise<void>
  pasteClipboard: () => Promise<void>
}

interface XTermPaneProps {
  pane:    PtyPane
  shell?:  string
  argv?:   string[]
  env?:    Record<string, string>
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  onExit?: (exitCode: number) => void
  onClose: () => void
  onOpenUrl?: (url: string) => void
  onHeaderDragStart?: (event: React.DragEvent<HTMLDivElement>, paneId: string) => void
  onHeaderDragEnd?: () => void
  onClipboardActionsChange?: (paneId: string, actions: TerminalClipboardActions | null) => void
}


export function XTermPane({ pane, shell, argv, env, collapsed = false, onCollapsedChange, onExit, onClose, onOpenUrl, onHeaderDragStart, onHeaderDragEnd, onClipboardActionsChange }: XTermPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef  = useRef<FitAddon | null>(null)
  const rendererRef = useRef<ITerminalAddon | null>(null)
  const [live, setLive] = useState(pane.live)

  const { state: settings } = useSettings()
  const onExitRef = useRef(onExit)
  const onOpenUrlRef = useRef(onOpenUrl)
  // Ref'd so the terminal-creation effect below doesn't list it as a dep — its
  // caller (TermColumn) passes a fresh inline closure each render, which would
  // otherwise dispose+recreate the whole xterm on every parent re-render (flash).
  const onClipboardActionsChangeRef = useRef(onClipboardActionsChange)

  useEffect(() => { onExitRef.current = onExit }, [onExit])
  useEffect(() => { onOpenUrlRef.current = onOpenUrl }, [onOpenUrl])
  useEffect(() => { onClipboardActionsChangeRef.current = onClipboardActionsChange }, [onClipboardActionsChange])

  // Take focus when the app asks the active terminal to (tab switch). Only
  // visible panes respond — hidden keepalive panes report 0×0, so a background
  // tab's terminals never steal focus from the foreground one.
  useEffect(() => {
    const fn = (): void => {
      const host = hostRef.current
      const term = termRef.current
      if (!host || !term || !hostHasUsableSize(host)) return
      term.focus()
    }
    window.addEventListener('crewcode:focus-terminal', fn)
    return () => window.removeEventListener('crewcode:focus-terminal', fn)
  }, [])

  useEffect(() => {
    if (!hostRef.current || collapsed) return

    const tf = resolveTerminalFont(settings)
    const term = new Terminal({
      fontFamily: monoFontStack(tf.family),
      fontSize: tf.size,
      fontWeight: settings.fontWeight,
      lineHeight: tf.lineHeight,
      cursorBlink: settings.cursor !== 'off',
      allowProposedApi: true,
      scrollback: TERMINAL_SCROLLBACK_ROWS,
      scrollOnEraseInDisplay: true,
      theme: {
        background:        '#0f120f',
        foreground:        '#d6dadd',
        cursor:            '#74b797',
        cursorAccent:      '#0f120f',
        selectionBackground: '#285a4855',
        black:   '#0f120f', red:     '#e06464',
        green:   '#74b797', yellow:  '#d8c87a',
        blue:    '#6fa3c8', magenta: '#b78bd1',
        cyan:    '#7fcdc5', white:   '#d6dadd',
        brightBlack:   '#5a6a64', brightRed:     '#ff8484',
        brightGreen:   '#94d7a7', brightYellow:  '#f8e89a',
        brightBlue:    '#8fc3e8', brightMagenta: '#d7abf1',
        brightCyan:    '#9fede5', brightWhite:   '#ffffff',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    termRef.current = term
    fitRef.current  = fit

    // GPU renderer must be loaded *after* term.open so the WebGL addon has a
    // screen element to attach to.
    rendererRef.current = loadRenderer(term, settings.gpu)

    const fitIfVisible = (): boolean => {
      const host = hostRef.current
      if (!host || !hostHasUsableSize(host)) return false
      try { fit.fit(); return true } catch { return false }
    }

    fitIfVisible()

    const api = window.electronAPI
    if (!api) {
      term.writeln('\x1b[31melectronAPI unavailable\x1b[0m')
      return
    }

    let disposed = false
    // Routed subscription: this pane only receives its own output, so a busy
    // sibling terminal no longer runs a callback here per chunk.
    const offData = api.onPtyDataForPane(pane.paneId, (data) => term.write(data))
    const offExit = api.onPtyExit(({ paneId, exitCode }) => {
      if (paneId !== pane.paneId) return
      setLive(false)
      term.write(`\r\n\x1b[2;37m[process exited: ${exitCode}]\x1b[0m\r\n`)
      onExitRef.current?.(exitCode)
    })

    api.ptyCreate({
      paneId: pane.paneId,
      cwd:    pane.cwd,
      cols:   term.cols,
      rows:   term.rows,
      shell,
      argv,
      env,
    }).then(result => {
      if (disposed) return
      if (result.error) {
        term.writeln(`\x1b[31m${result.error}\x1b[0m`)
        setLive(false)
        return
      }
      if (result.buffer) term.write(result.buffer)
      setLive(true)
    })

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (event.key !== 'Enter' || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return true

      // Claude Code's /terminal-setup binds Shift+Enter to Esc+Enter in
      // embedded terminals; send that sequence so multiline input survives xterm.
      event.preventDefault()
      api.ptyWrite(pane.paneId, SHIFT_ENTER_SEQUENCE)
      return false
    })

    const linkProvider = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true) ?? ''
        const matches = [...line.matchAll(/https?:\/\/[^\s)\]}>"']+/g)]
        callback(matches.map(match => ({
          range: {
            start: { x: match.index! + 1, y: bufferLineNumber },
            end: { x: match.index! + match[0].length, y: bufferLineNumber },
          },
          text: match[0],
          activate: () => onOpenUrlRef.current?.(match[0]),
        })))
      },
    })

    const onInput = term.onData(d => api.ptyWrite(pane.paneId, d))
    const onResize = term.onResize(({ cols, rows }) => api.ptyResize(pane.paneId, cols, rows))

    onClipboardActionsChangeRef.current?.(pane.paneId, {
      hasSelection: () => term.hasSelection(),
      copySelection: async () => {
        const selection = term.getSelection()
        if (!selection) return
        await window.electronAPI?.clipboardWriteText(selection)
      },
      pasteClipboard: async () => {
        const text = await navigator.clipboard.readText().catch(() => '')
        if (!text) return
        term.focus()
        api.ptyWrite(pane.paneId, text)
      },
    })

    const ro = new ResizeObserver(() => {
      // Hidden keepalive panes can report 0×0; resizing the PTY to that size
      // causes full-screen agent UIs to redraw into a tiny, truncated viewport.
      fitIfVisible()
    })
    ro.observe(hostRef.current)

    return () => {
      disposed = true
      offData()
      offExit()
      onInput.dispose()
      onResize.dispose()
      linkProvider.dispose()
      ro.disconnect()
      // Unmounts happen on tab switches and layout changes; keep the PTY alive
      // so open tabs retain shell/agent state until the user explicitly closes.
      onClipboardActionsChangeRef.current?.(pane.paneId, null)
      releaseRenderer(rendererRef.current)
      rendererRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current  = null
    }
  }, [pane.paneId, collapsed, shell, argv, env])

  // Apply Typography settings to a live terminal without recreating it.
  // Refits afterwards so cols/rows stay accurate.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const tf = resolveTerminalFont(settings)
    term.options.fontFamily   = monoFontStack(tf.family)
    term.options.fontSize     = tf.size
    term.options.fontWeight   = settings.fontWeight
    term.options.lineHeight   = tf.lineHeight
    term.options.cursorBlink  = settings.cursor !== 'off'
    const refit = () => {
      if (hostRef.current && hostHasUsableSize(hostRef.current)) {
        try { fitRef.current?.fit() } catch { /* host detached */ }
      }
    }
    refit()
    // xterm measures glyphs on a canvas the instant fontFamily is set. A bundled
    // (self-hosted) font may still be loading then, so it gets measured as the
    // fallback and never corrects on its own. Wait for the real font, reassign to
    // force a glyph remeasure, and re-fit.
    if (typeof document !== 'undefined' && document.fonts?.load) {
      const probe = `${settings.fontWeight} ${tf.size}px ${monoFontStack(tf.family)}`
      void document.fonts.load(probe).then(() => {
        const live = termRef.current
        if (!live) return
        live.options.fontFamily = monoFontStack(tf.family)
        refit()
      }).catch(() => { /* font load rejected — fallback stack still renders */ })
    }
  }, [
    settings.fontFamily, settings.fontSize, settings.fontWeight, settings.lineHeight, settings.cursor,
    settings.terminalFontFamily, settings.terminalFontSize, settings.terminalLineHeight,
  ])

  // Swap the GPU renderer on already-open panes when the user toggles the
  // setting. Gated by gpuLive so users with shaky drivers can defer the
  // re-attach to the next pane open.
  useEffect(() => {
    if (!settings.gpuLive) return
    const term = termRef.current
    if (!term) return
    releaseRenderer(rendererRef.current)
    rendererRef.current = loadRenderer(term, settings.gpu)
    if (hostRef.current && hostHasUsableSize(hostRef.current)) {
      try { fitRef.current?.fit() } catch { /* host detached */ }
    }
  }, [settings.gpu, settings.gpuLive])

  const agentIcon = pane.agentId ? AGENT_ICONS[pane.agentId] : undefined
  const projectName = projectNameFromPath(pane.cwd, pane.title)

  return (
    <div className={`termpane ${collapsed ? 'collapsed' : ''}`}>
      <div
        className="term-h"
        draggable={!!onHeaderDragStart}
        onDragStart={(event) => onHeaderDragStart?.(event, pane.paneId)}
        onDragEnd={onHeaderDragEnd}
        title="drag to swap terminals"
      >
        <div className={`sprite ${agentIcon ? 'agent' : 'shell'}`}>
          {agentIcon
            ? <img src={agentIcon} alt={pane.agentId ?? 'agent'} width={14} height={14} className={providerImageClass(pane.agentId ?? '')} style={{ objectFit: 'contain', display: 'block' }} />
            : <span className="sprite-shell">$</span>
          }
        </div>
        <div className="titles">
          <div className="t1">
            {projectName} {live && <span className="live-dot" />}
          </div>
          <div className="t2 mono">{pane.sub}</div>
        </div>
        <div className="pane-actions">
          <button className="ibtn" title={collapsed ? 'expand' : 'collapse'} draggable={false} onClick={() => onCollapsedChange?.(!collapsed)}>
            <Icon name={collapsed ? 'chevDown' : 'min'} size={12} />
          </button>
          <button className="ibtn" title="close" draggable={false} onClick={onClose}><Icon name="close" /></button>
        </div>
      </div>
      {!collapsed && <div className="xterm-host" ref={hostRef} />}
    </div>
  )
}

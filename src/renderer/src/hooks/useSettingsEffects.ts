import { useEffect } from 'react'
import { monoFontStack, useSettings, type ColorTheme, type AppTheme } from './useSettings'
// Color-theme token overrides. Carbon mostly uses the defaults from
// colors_and_type.css; non-carbon themes also remap the crew semantic tokens so
// orchestration surfaces don't stay evergreen inside blue/gray/purple themes.
const THEME_VARS: Record<ColorTheme, Record<string, string>> = {
  carbon: {
    '--primary':            '#285a48',
    '--ring':               '#1e3a30',
    '--crew-term':       '#080a08',
    '--accent':                '#1e3a30',
  },
  midnight: {
    '--background':         '#0a0e1a',
    '--card':               '#11152a',
    '--popover':            '#0d1020',
    '--muted':              '#1b1f35',
    '--accent':             '#1b1f35',
    '--border':             '#1f2540',
    '--foreground':         '#e6e8ed',
    '--muted-foreground':   '#9aa1c4',
    '--primary':            '#2e47ab',
    '--ring':               '#3b5bdb',
    '--bubble-user-bg':     '#1e2750',
    '--bubble-user-border': '#3b5bdb',
    '--bubble-user-fg':     '#c7d2fe',
    '--sidebar':            '#0d1020',
    '--crew-term':          '#080b14',
    '--crew-green':         '#2e47ab',
    '--crew-green-bright':  '#5c7cfa',
    '--crew-green-soft':    '#1e2750',
    '--crew-mint':          '#c7d2fe',
    '--crew-header':        '#0d1020',
  },
  graphite: {
    '--background':         '#171717',
    '--card':               '#222222',
    '--popover':            '#1c1c1c',
    '--muted':              '#2a2a2a',
    '--accent':             '#2a2a2a',
    '--border':             '#333333',
    '--foreground':         '#e5e5e5',
    '--muted-foreground':   '#a3a3a3',
    '--primary':            '#737373',
    '--ring':               '#737373',
    '--bubble-user-bg':     '#2e2e2e',
    '--bubble-user-border': '#525252',
    '--bubble-user-fg':     '#f5f5f5',
    '--sidebar':            '#1c1c1c',
    '--crew-term':          '#141414',
    '--crew-green':         '#737373',
    '--crew-green-bright':  '#a3a3a3',
    '--crew-green-soft':    '#2e2e2e',
    '--crew-mint':          '#e5e5e5',
    '--crew-header':        '#1c1c1c',
  },
  'solar-dark': {
    '--background':         '#002b36',
    '--card':               '#073642',
    '--popover':            '#022a35',
    '--muted':              '#0a3a47',
    '--accent':             '#0a3a47',
    '--border':             '#0e4452',
    '--foreground':         '#e5e5e5',
    '--muted-foreground':   '#586e80',
    '--primary':            '#1683a1',
    '--ring':               '#268bd2',
    '--bubble-user-bg':     '#073642',
    '--bubble-user-border': '#268bd2',
    '--bubble-user-fg':     '#eee8d5',
    '--sidebar':            '#073642',
    '--crew-term':          '#002730',
    '--crew-green':         '#1683a1',
    '--crew-green-bright':  '#2aa7c9',
    '--crew-green-soft':    '#073642',
    '--crew-mint':          '#93d6e8',
    '--crew-header':        '#022a35',
  },
  paper: {
    '--background':         '#fafaf7',
    '--card':               '#ffffff',
    '--popover':            '#ffffff',
    '--muted':              '#f0efe9',
    '--accent':             '#e8e7e1',
    '--border':             '#d8d6cd',
    '--foreground':         '#2a2a2a',
    '--muted-foreground':   '#6b6b6b',
    '--primary':            '#285a48',
    '--ring':               '#285a48',
    '--bubble-user-bg':     '#e8f3ed',
    '--bubble-user-border': '#285a48',
    '--bubble-user-fg':     '#1e3a30',
    '--sidebar':            '#ffffff',
    '--crew-term':          '#e8e8e8',
    '--crew-green':         '#285a48',
    '--crew-green-bright':  '#2f9d72',
    '--crew-green-soft':    '#e8f3ed',
    '--crew-mint':          '#285a48',
    '--crew-header':        '#ffffff',
  },
  tomorrow: {
    '--background':         '#1d1f21',
    '--card':               '#282a2e',
    '--popover':            '#1f2123',
    '--muted':              '#2d2f33',
    '--accent':             '#2d2f33',
    '--border':             '#373b41',
    '--foreground':         '#e5e5e5',
    '--muted-foreground':   '#969896',
    '--primary':            '#9e83a6',
    '--ring':               '#b294bb',
    '--bubble-user-bg':     '#373b41',
    '--bubble-user-border': '#b294bb',
    '--bubble-user-fg':     '#c5c8c6',
    '--sidebar':            '#1f2123',
    '--crew-term':          '#141617',
    '--crew-green':         '#9e83a6',
    '--crew-green-bright':  '#b294bb',
    '--crew-green-soft':    '#373b41',
    '--crew-mint':          '#e7d8ea',
    '--crew-header':        '#1f2123',
  },
}

const ALL_VAR_NAMES = Array.from(
  new Set(Object.values(THEME_VARS).flatMap(m => Object.keys(m))),
)

function applyAppTheme(appTheme: AppTheme) {
  const resolved =
    appTheme === 'system'
      ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : appTheme
  document.body.classList.toggle('dark',  resolved === 'dark')
  document.body.classList.toggle('light', resolved === 'light')
}

/**
 * Subscribes to settings and applies the side-effects each one drives:
 * UI zoom, app theme (dark/light/system), color-theme token swap,
 * and monospace typography variables consumed by terminals + editors.
 */
export function useSettingsEffects() {
  const { state } = useSettings()

  // Native Electron/Chromium zoom, matching VS Code. CSS `zoom` scales the DOM
  // box itself and can make the app look like one oversized, clipped page.
  useEffect(() => {
    document.documentElement.style.removeProperty('zoom')
    window.electronAPI?.setUiZoom(state.zoom)
  }, [state.zoom])

  // App theme (dark / light / system). System needs a media-query listener so
  // we re-resolve when the OS preference changes.
  useEffect(() => {
    applyAppTheme(state.appTheme)
    if (state.appTheme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyAppTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [state.appTheme])

  // Color theme — clear any previously-applied theme vars, then set the new
  // ones. Carbon resets to defaults (vars cleared, CSS defaults take over).
  // Applied to body (not :root) so inline styles override the body.dark /
  // body.light class rules in colors_and_type.css.
  useEffect(() => {
    const target = document.body
    for (const name of ALL_VAR_NAMES) target.style.removeProperty(name)
    const vars = THEME_VARS[state.theme] ?? {}
    for (const [name, value] of Object.entries(vars)) target.style.setProperty(name, value)
  }, [state.theme, state.appTheme])

  // Typography vars consumed by editors, code chips, and terminals.
  // --font-family-mono drives every mono surface in the app (chat chips, git
  // sidebar, status bars). --editor-* are read by the code editor only; the
  // terminal reads its settings directly via XTermPane.
  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--font-family-mono', monoFontStack(state.fontFamily))
    root.style.setProperty('--mono-size',        `${state.fontSize}px`)
    root.style.setProperty('--mono-weight',      String(state.fontWeight))
    root.style.setProperty('--mono-line-height', String(state.lineHeight))
    root.style.setProperty(
      '--mono-ligatures',
      state.ligatures ? '"liga", "calt"' : '"liga" 0, "calt" 0',
    )

    const editorFamily = state.editorFontFamily.trim() || state.fontFamily
    const editorSize   = state.editorFontSize   > 0 ? state.editorFontSize   : state.fontSize
    const editorLH     = state.editorLineHeight > 0 ? state.editorLineHeight : state.lineHeight
    root.style.setProperty('--editor-family', monoFontStack(editorFamily))
    root.style.setProperty('--editor-size',        `${editorSize}px`)
    root.style.setProperty('--editor-weight',      String(state.fontWeight))
    root.style.setProperty('--editor-line-height', String(editorLH))
  }, [
    state.fontFamily, state.fontSize, state.fontWeight, state.lineHeight, state.ligatures,
    state.editorFontFamily, state.editorFontSize, state.editorLineHeight,
  ])
}

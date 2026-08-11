// Security-critical configuration, extracted into a pure (Electron-free) module
// so it can be unit-tested and guarded against silent weakening. index.ts imports
// these constants instead of inlining them; security-config.test.ts pins the
// invariants. If a change here trips the tests, that is the point — a human should
// consciously approve any loosening of the renderer's authority boundary.

/** CSP directives applied to the trusted renderer in production (see index.ts). */
export const APP_CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' 'sha256-Dxhj1PJcnns94efqN0+8KN/rWrA9nBd+Xqz9tu6zLB4='",
  // colors_and_type.css @imports Inter/JetBrains Mono from Google Fonts.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self' crewcode-plugin:",
  "object-src 'none'",
  "base-uri 'none'",
]

export const APP_CSP = APP_CSP_DIRECTIVES.join('; ')

/**
 * The only webPreferences flags that gate renderer authority. Spread into the
 * BrowserWindow config so the isolation posture lives in one guarded place.
 */
export const SECURE_WINDOW_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
} as const

/** Schemes `shell.openExternal` and the window-open handler will launch. */
export const EXTERNAL_URL_ALLOWED_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:']

export function isAllowedExternalScheme(scheme: string): boolean {
  return EXTERNAL_URL_ALLOWED_SCHEMES.includes(scheme)
}

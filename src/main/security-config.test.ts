// Regression guards for the renderer authority boundary. These pin the CSP,
// isolation flags, and external-URL allowlist so none can be silently weakened
// (residual risk #1). A deliberate loosening must edit these expectations too —
// which is the human checkpoint we want.
import { describe, expect, it } from 'vitest'
import {
  APP_CSP,
  APP_CSP_DIRECTIVES,
  EXTERNAL_URL_ALLOWED_SCHEMES,
  SECURE_WINDOW_WEB_PREFERENCES,
  isAllowedExternalScheme,
} from './security-config'

describe('renderer CSP cannot silently weaken', () => {
  const directive = (name: string) => APP_CSP_DIRECTIVES.find(d => d.startsWith(name)) ?? ''

  it('locks default-src, object-src, and base-uri down', () => {
    expect(directive('default-src')).toBe("default-src 'self'")
    expect(directive('object-src')).toBe("object-src 'none'")
    expect(directive('base-uri')).toBe("base-uri 'none'")
  })

  it('never allows unsafe-eval or a wildcard script source', () => {
    const script = directive('script-src')
    expect(script).not.toContain("'unsafe-eval'")
    expect(script).not.toContain('*')
    // wasm-unsafe-eval (shiki) is far narrower than full unsafe-eval and is allowed.
  })

  it('keeps connect-src off the open internet (no wildcard, no http:)', () => {
    const connect = directive('connect-src')
    expect(connect).toContain("'self'")
    expect(connect).not.toContain('*')
    expect(connect).not.toMatch(/https?:(?!\/)/) // no bare http:/https: host wildcard
  })

  it('only frames self + the plugin protocol', () => {
    expect(directive('frame-src')).toBe("frame-src 'self' crewcode-plugin:")
  })

  it('APP_CSP string is the directives joined', () => {
    expect(APP_CSP).toBe(APP_CSP_DIRECTIVES.join('; '))
  })
})

describe('window isolation flags cannot silently weaken', () => {
  it('keeps contextIsolation on and nodeIntegration off', () => {
    expect(SECURE_WINDOW_WEB_PREFERENCES.contextIsolation).toBe(true)
    expect(SECURE_WINDOW_WEB_PREFERENCES.nodeIntegration).toBe(false)
  })
})

describe('external-URL launch allowlist', () => {
  it('permits only http/https/mailto', () => {
    expect([...EXTERNAL_URL_ALLOWED_SCHEMES].sort()).toEqual(['http:', 'https:', 'mailto:'])
  })

  it('refuses dangerous schemes a renderer/link might supply', () => {
    for (const scheme of ['file:', 'javascript:', 'data:', 'vscode:', 'app:', 'chrome:', 'smb:']) {
      expect(isAllowedExternalScheme(scheme)).toBe(false)
    }
  })

  it('accepts the allowlisted schemes', () => {
    for (const scheme of ['http:', 'https:', 'mailto:']) {
      expect(isAllowedExternalScheme(scheme)).toBe(true)
    }
  })
})

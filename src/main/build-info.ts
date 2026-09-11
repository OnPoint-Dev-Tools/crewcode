import type { AppBuildInfo } from '../shared/updater-types'

// Injected into every main-process entry by electron-vite. Headless/browser
// runtimes cannot ask Electron's app object, so they use the same package
// version captured at build time.
declare const __APP_VERSION__: string
declare const __BUILD_HASH__: string

export const BUILD_VERSION = typeof __APP_VERSION__ === 'string'
  ? __APP_VERSION__
  : process.env.npm_package_version ?? 'dev'

export const BUILD_HASH = typeof __BUILD_HASH__ === 'string' ? __BUILD_HASH__ : 'dev'

export function createAppBuildInfo(version = BUILD_VERSION, packaged = false): AppBuildInfo {
  return { version, buildHash: BUILD_HASH, packaged }
}

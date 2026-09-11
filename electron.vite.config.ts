import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'

// Version surfaces show the build hash so a bug report identifies an exact
// commit. Resolve it at build time because the packaged app has no .git.
function buildHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'dev'
  } catch {
    return 'dev'
  }
}

const appVersion = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version as string

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __BUILD_HASH__: JSON.stringify(buildHash()),
    },
    build: {
      rollupOptions: {
        external: ['fsevents'],
        input: {
          index: resolve('src/main/index.ts'),
          headless: resolve('src/main/headless.ts'),
          hub: resolve('src/main/hub.ts'),
          brain: resolve('src/main/hub-machine-enrollment.ts'),
        },
      },
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { external: ['fsevents'] } }
  },
  renderer: {
    // The in-app browser tab needs to reach local dev servers too; binding the
    // renderer to all interfaces avoids localhost/127.0.0.1/::1 mismatches.
    server: {
      host: '0.0.0.0',
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})

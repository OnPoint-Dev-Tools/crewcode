import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Vitest runs the pure-logic and real-git tests outside Electron — the modules
// under test are deliberately free of `electron` imports so they load here. The
// @renderer alias mirrors electron.vite.config.ts / tsconfig.web.json.
export default defineConfig({
  resolve: {
    alias: { '@renderer': resolve(__dirname, 'src/renderer/src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,integration.test}.ts'],
    // Real-git integration tests shell out to git in temp repos — give them room.
    testTimeout: 20_000,
  },
})

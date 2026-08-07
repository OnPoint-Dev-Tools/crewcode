#!/usr/bin/env node
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'out', 'main', 'headless.js')
if (!existsSync(entry)) {
  console.error('CrewCode server build is missing. Run `npm run build` before starting from this checkout.')
  process.exit(1)
}

// The Electron package sets ELECTRON_RUN_AS_NODE in some development shells.
// A headless server must always execute in ordinary Node.js.
delete process.env.ELECTRON_RUN_AS_NODE
const require = createRequire(import.meta.url)
const module = require(entry)
module.runHeadless(process.argv.slice(2)).catch(error => {
  console.error(error?.message || String(error))
  process.exitCode = 1
})

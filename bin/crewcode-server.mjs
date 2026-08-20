#!/usr/bin/env node
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const requested = args[0]
const command = requested === 'hub' || requested === 'enroll' || requested === 'brain' ? requested : 'serve'
const entry = join(root, 'out', 'main', command === 'hub' ? 'hub.js' : command === 'serve' ? 'headless.js' : 'brain.js')
if (!existsSync(entry)) {
  console.error(`CrewCode ${command} build is missing. Run \`npm run build\` before starting from this checkout.`)
  process.exit(1)
}

// The Electron package sets ELECTRON_RUN_AS_NODE in some development shells.
// Headless services must always execute in ordinary Node.js.
delete process.env.ELECTRON_RUN_AS_NODE
const require = createRequire(import.meta.url)
const module = require(entry)
const run = command === 'hub' ? module.runHub : command === 'serve' ? module.runHeadless : (argv => module.runBrainCommand(command, argv))
run(command !== 'serve' || requested === 'serve' ? args.slice(1) : args).catch(error => {
  console.error(error?.message || String(error))
  process.exitCode = 1
})

#!/usr/bin/env node
import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const source = join(process.cwd(), 'packages', 'crewcode-plugin-api', 'browser', 'crewcode-plugin-api.js')
const examplesRoot = join(process.cwd(), 'examples', 'plugins')

if (!existsSync(source)) throw new Error(`missing canonical helper: ${source}`)

let count = 0
for (const dirName of readdirSync(examplesRoot)) {
  const target = join(examplesRoot, dirName, 'crewcode-plugin-api.js')
  if (!existsSync(target)) continue
  copyFileSync(source, target)
  count++
}

console.log(`synced crewcode-plugin-api.js to ${count} plugin example(s)`)

// @ts-nocheck
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { createPlugin, devPlugin, packagePlugin } from '../../packages/crewcode-plugin-cli/bin/crewcode.mjs'

function tempRoot(name) {
  return mkdtempSync(join(tmpdir(), `crewcode-plugin-cli-${name}-`))
}

describe('crewcode plugin CLI', () => {
  it('creates a plugin from the static panel template', () => {
    const out = tempRoot('create')
    const result = createPlugin(['my-panel', '--template', 'static-panel', '--out', out, '--name', 'My Panel'])
    const manifestPath = join(result.path, 'crewcode.plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

    expect(result.id).toBe('my-panel')
    expect(manifest.id).toBe('my-panel')
    expect(manifest.name).toBe('My Panel')
    expect(manifest.$schema).toBe('https://crewcode.cortex-ai.icu/schemas/crewcode.plugin.schema.json')
    expect(existsSync(join(result.path, 'panel.html'))).toBe(true)
  })

  it('installs a plugin for dev with copy mode', () => {
    const out = tempRoot('dev-src')
    const home = tempRoot('dev-home')
    process.env.CREWCODE_PLUGINS_DIR = home
    const created = createPlugin(['dev-panel', '--template', 'static-panel', '--out', out])

    const result = devPlugin([created.path, '--copy'])

    expect(result.pluginId).toBe('dev-panel')
    expect(result.mode).toBe('copy')
    expect(existsSync(join(home, 'dev-panel', 'crewcode.plugin.json'))).toBe(true)
    delete process.env.CREWCODE_PLUGINS_DIR
  })

  it('packages a plugin into a tgz plus manifest summary', async () => {
    const out = tempRoot('package-src')
    const dist = tempRoot('package-dist')
    const created = createPlugin(['pack-panel', '--template', 'static-panel', '--out', out])

    const result = await packagePlugin([created.path, '--out', dist, '--no-build'])

    expect(result.path).toBe(join(dist, 'pack-panel-0.1.0.crewcode-plugin.tgz'))
    expect(result.sha256).toHaveLength(64)
    expect(existsSync(result.path)).toBe(true)
    expect(existsSync(`${result.path}.json`)).toBe(true)
  })
})

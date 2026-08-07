import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { validatePluginManifest } from './plugin-contract'

describe('example plugin dogfood manifests', () => {
  const examplesRoot = join(process.cwd(), 'examples', 'plugins')
  const manifestDirs = readdirSync(examplesRoot)
    .map(name => join(examplesRoot, name))
    .filter(dir => existsSync(join(dir, 'crewcode.plugin.json')))

  it('keeps every example manifest valid against the runtime contract', () => {
    expect(manifestDirs.length).toBeGreaterThan(0)
    for (const dir of manifestDirs) {
      const raw = JSON.parse(readFileSync(join(dir, 'crewcode.plugin.json'), 'utf8'))
      const manifest = validatePluginManifest(raw, dir)
      expect(manifest.crewcode?.apiVersion).toBe('0.1')
    }
  })

  it('points every example panel contribution at an existing static asset', () => {
    for (const dir of manifestDirs) {
      const raw = JSON.parse(readFileSync(join(dir, 'crewcode.plugin.json'), 'utf8'))
      const manifest = validatePluginManifest(raw, dir)
      const panels = [
        ...(manifest.contributes?.tabs ?? []),
        ...(manifest.contributes?.sidebarPanels ?? []),
      ]
      for (const panel of panels) {
        expect(existsSync(join(dir, panel.entry)), `${manifest.id}:${panel.id} entry exists`).toBe(true)
      }
    }
  })

  it('covers the intended v0 dogfood contribution surface', () => {
    const contributionKeys = new Set<string>()
    for (const dir of manifestDirs) {
      const raw = JSON.parse(readFileSync(join(dir, 'crewcode.plugin.json'), 'utf8'))
      const manifest = validatePluginManifest(raw, dir)
      for (const [key, value] of Object.entries(manifest.contributes ?? {})) {
        if (Array.isArray(value) && value.length > 0) contributionKeys.add(key)
      }
    }

    expect(contributionKeys).toEqual(new Set([
      'agentProviders',
      'browserActions',
      'chatActions',
      'chatHeaderItems',
      'commands',
      'editorActions',
      'gitLenses',
      'mcpServers',
      'missionWidgets',
      'sidebarPanels',
      'statusItems',
      'tabs',
      'terminalWatchers',
    ]))
  })
})

import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { inspectPluginCheckout, normalizePluginGitUrl, readPluginGitSources } from './plugin-git-install'

function checkout(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `crewcode-plugin-git-${name}-`))
  writeFileSync(join(root, 'crewcode.plugin.json'), JSON.stringify({
    id: 'community-plugin',
    name: 'Community Plugin',
    version: '1.0.0',
    crewcode: { apiVersion: '0.1' },
    permissions: ['workspace:read'],
    contributes: { tabs: [{ id: 'main', title: 'Community Plugin', entry: 'panel.html' }] },
  }))
  writeFileSync(join(root, 'panel.html'), '<!doctype html><title>Community Plugin</title>')
  return root
}

describe('plugin Git repository URL rules', () => {
  it('accepts public HTTPS repository URLs and normalizes trailing slashes', () => {
    expect(normalizePluginGitUrl(' https://github.com/example/community-plugin/ ')).toBe(
      'https://github.com/example/community-plugin',
    )
  })

  it.each([
    'git@github.com:example/community-plugin.git',
    'ssh://git@github.com/example/community-plugin.git',
    'file:///tmp/community-plugin',
    'https://token@github.com/example/community-plugin',
    'https://github.com/example/community-plugin?ref=main',
  ])('rejects unsafe or non-public URL %s', url => {
    expect(() => normalizePluginGitUrl(url)).toThrow()
  })
})

describe('plugin Git checkout rules', () => {
  it('validates a prebuilt root plugin without running repository code', () => {
    const root = checkout('valid')
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      scripts: { postinstall: 'exit 1', build: 'exit 1' },
    }))

    const result = inspectPluginCheckout(root)

    expect(result.manifest.id).toBe('community-plugin')
    expect(result.fileCount).toBe(3)
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('postinstall')
  })

  it('requires the manifest at repository root', () => {
    const root = mkdtempSync(join(tmpdir(), 'crewcode-plugin-git-nested-'))
    mkdirSync(join(root, 'plugin'))
    writeFileSync(join(root, 'plugin', 'crewcode.plugin.json'), '{}')

    expect(() => inspectPluginCheckout(root)).toThrow('must be at the repository root')
  })

  it('rejects node_modules', () => {
    const modulesRoot = checkout('modules')
    mkdirSync(join(modulesRoot, 'node_modules'))
    expect(() => inspectPluginCheckout(modulesRoot)).toThrow('cannot include node_modules')
  })

  it.skipIf(process.platform === 'win32')('rejects symbolic links', () => {
    const symlinkRoot = checkout('symlink')
    symlinkSync(join(symlinkRoot, 'panel.html'), join(symlinkRoot, 'linked-panel.html'))
    expect(() => inspectPluginCheckout(symlinkRoot)).toThrow('cannot contain symbolic links')
  })

  it('ignores malformed stored source metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'crewcode-plugin-sources-'))
    writeFileSync(join(root, 'plugin-sources.json'), JSON.stringify({
      good: {
        repositoryUrl: 'https://github.com/example/good',
        revision: 'abc123',
        installedAt: 1,
        updatedAt: 2,
      },
      bad: { repositoryUrl: 42 },
    }))

    expect(readPluginGitSources(root)).toEqual({
      good: {
        repositoryUrl: 'https://github.com/example/good',
        revision: 'abc123',
        installedAt: 1,
        updatedAt: 2,
      },
    })
  })
})

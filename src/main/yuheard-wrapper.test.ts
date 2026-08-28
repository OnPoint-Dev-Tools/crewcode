/**
 * Tests for the YuHeard auto-wrap shell shim generator.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync, utimesSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  installYuHeardWrapper,
  installYuHeardHook,
  uninstallYuHeardWrapper,
  pruneYuHeardWrappers,
  prependWrapperToPath,
  tomlNotifyOverride,
  codexNotifyArgv,
  fishKeepWrapArgv,
  fishKeepWrapCommand,
  bashKeepWrapPrompt,
  quoteSh,
} from './yuheard-wrapper'

let baseDir: string

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'yuheard-test-'))
})

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true })
})

describe('installYuHeardWrapper', () => {
  it('creates one shim per agent id and marks them executable', () => {
    const dir = installYuHeardWrapper('pn-1', ['claude', 'codex'], { baseDir, socketPath: '/tmp/test.sock' })
    expect(dir).toBe(join(baseDir, 'pn-1'))
    expect(existsSync(join(dir, 'claude'))).toBe(true)
    expect(existsSync(join(dir, 'codex'))).toBe(true)
    const st = statSync(join(dir, 'claude'))
    expect((st.mode & 0o100) !== 0).toBe(true)
  })

  it('embeds the socket path in the hook and does not call yuheard on PATH', () => {
    const dir = installYuHeardWrapper('pn-abc', ['claude'], { baseDir, socketPath: '/tmp/yuheard.sock' })
    const body = readFileSync(join(dir, 'claude'), 'utf8')
    expect(body).toContain('self_dir=')
    expect(body).toMatch(/command -v claude/)
    expect(body).toMatch(/exec "\$real" "\$@"/)
    expect(body).not.toMatch(/yuheard running/)
    expect(body).toContain('yuheard-hook.')
    const files = readdirSync(dir)
    const hook = files.find(name => name.startsWith('yuheard-hook.'))
    expect(hook).toBeTruthy()
    const hookBody = readFileSync(join(dir, hook!), 'utf8')
    expect(hookBody).toContain('pn-abc')
    expect(hookBody).toContain('/tmp/yuheard.sock')
  })

  it('injects Codex notify -c flags into the codex shim', () => {
    const dir = installYuHeardWrapper('pn-cx', ['codex'], { baseDir, socketPath: '/tmp/yuheard.sock' })
    const shim = readFileSync(join(dir, 'codex'), 'utf8')
    expect(shim).toContain('-c')
    expect(shim).toContain('notify=[')
    expect(shim).toContain('tui.notifications=true')
    expect(shim).toContain('tui.notification_condition="always"')
    expect(shim).toContain('tui.notification_method="bel"')
    expect(shim).not.toContain('#!/usr/bin/env node\n// CrewCode YuHeard — Codex notify')
  })

  it('does not inject Codex flags into a claude shim', () => {
    const dir = installYuHeardWrapper('pn-1', ['claude'], { baseDir, socketPath: '/tmp/yuheard.sock' })
    const body = readFileSync(join(dir, 'claude'), 'utf8')
    expect(body).not.toContain('tui.notifications')
  })

  it('overwrites stale shims from a previous install of the same pane', () => {
    installYuHeardWrapper('pn-1', ['claude'], { baseDir, socketPath: '/tmp/old.sock' })
    installYuHeardWrapper('pn-1', ['claude', 'codex'], { baseDir, socketPath: '/tmp/new.sock' })
    const dir = join(baseDir, 'pn-1')
    expect(existsSync(join(dir, 'claude'))).toBe(true)
    expect(existsSync(join(dir, 'codex'))).toBe(true)
    const body = readFileSync(join(dir, 'claude'), 'utf8')
    expect(body).toContain('yuheard-hook.')
    const hook = readdirSync(dir).find(name => name.startsWith('yuheard-hook.'))!
    expect(readFileSync(join(dir, hook), 'utf8')).toContain('/tmp/new.sock')
    expect(readFileSync(join(dir, hook), 'utf8')).not.toContain('/tmp/old.sock')
  })

  it('does nothing for an empty agent list', () => {
    const dir = installYuHeardWrapper('pn-1', [], { baseDir })
    expect(existsSync(join(dir, 'claude'))).toBe(false)
  })
})

describe('installYuHeardHook', () => {
  it('writes a hook that bakes pane id and socket', () => {
    const { hookPath } = installYuHeardHook('pn-x', { baseDir, socketPath: '/tmp/sock' })
    const body = readFileSync(hookPath, 'utf8')
    expect(body).toContain('pn-x')
    expect(body).toContain('/tmp/sock')
  })

  it('accepts only genuine Codex approval and completed-turn events', () => {
    const { hookPath } = installYuHeardHook('pn-x', { baseDir, socketPath: '/tmp/sock' })
    const body = readFileSync(hookPath, 'utf8')
    expect(body).toContain('agent-turn-complete')
    expect(body).toContain('approval-requested')
    expect(body).toMatch(/not in \(\"agent-turn-complete\", \"approval-requested\"\)/)
  })
})

describe('codexNotifyArgv', () => {
  it('builds -c overrides Codex will parse as TOML', () => {
    expect(tomlNotifyOverride('/usr/bin/python3', '/tmp/hook.py')).toBe(
      'notify=["/usr/bin/python3", "/tmp/hook.py"]',
    )
    expect(codexNotifyArgv('/usr/bin/python3', '/tmp/hook.py')).toEqual([
      '-c', 'notify=["/usr/bin/python3", "/tmp/hook.py"]',
      '-c', 'tui.notifications=true',
      '-c', 'tui.notification_method="bel"',
      '-c', 'tui.notification_condition="always"',
    ])
  })
})

describe('shell PATH keepers', () => {
  it('prepends a fish -C that puts the wrapper dir first after rc', () => {
    expect(fishKeepWrapArgv('/wrap/pn-1', [])).toEqual([
      '-C', `set -gx PATH ${quoteSh('/wrap/pn-1')} $PATH`,
    ])
  })

  it('redefines agent functions after fish rc so PATH shims win', () => {
    const cmd = fishKeepWrapCommand('/wrap/pn-1', ['codex', 'claude'])
    expect(cmd).toContain('set -gx PATH')
    expect(cmd).toContain('function codex;')
    expect(cmd).toContain('function claude;')
    expect(cmd).toContain(`${quoteSh('/wrap/pn-1')}/codex $argv`)
  })

  it('builds a bash PROMPT_COMMAND that re-prepends the wrapper', () => {
    expect(bashKeepWrapPrompt('/wrap/pn-1')).toContain("/wrap/pn-1")
  })

  it('drops bash aliases and functions that would shadow shims', () => {
    const prompt = bashKeepWrapPrompt('/wrap/pn-1', undefined, ['codex', 'claude'])
    expect(prompt).toContain('unset -f codex claude')
    expect(prompt).toContain('unalias codex claude')
  })
})

describe('uninstallYuHeardWrapper', () => {
  it('removes the pane directory', () => {
    installYuHeardWrapper('pn-1', ['claude'], { baseDir })
    expect(existsSync(join(baseDir, 'pn-1'))).toBe(true)
    uninstallYuHeardWrapper('pn-1', { baseDir })
    expect(existsSync(join(baseDir, 'pn-1'))).toBe(false)
  })

  it('is idempotent for a pane that was never installed', () => {
    expect(() => uninstallYuHeardWrapper('pn-nope', { baseDir })).not.toThrow()
  })
})

describe('pruneYuHeardWrappers', () => {
  it('removes directories older than maxAgeMs', () => {
    installYuHeardWrapper('pn-stale', ['claude'], { baseDir })
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(join(baseDir, 'pn-stale'), twoDaysAgo, twoDaysAgo)
    installYuHeardWrapper('pn-fresh', ['claude'], { baseDir })
    const pruned = pruneYuHeardWrappers(24 * 60 * 60 * 1000, { baseDir })
    expect(pruned).toBe(1)
    expect(existsSync(join(baseDir, 'pn-stale'))).toBe(false)
    expect(existsSync(join(baseDir, 'pn-fresh'))).toBe(true)
  })

  it('keeps directories newer than maxAgeMs', () => {
    installYuHeardWrapper('pn-1', ['claude'], { baseDir })
    const pruned = pruneYuHeardWrappers(60_000, { baseDir })
    expect(pruned).toBe(0)
    expect(existsSync(join(baseDir, 'pn-1'))).toBe(true)
  })

  it('returns 0 if the base dir does not exist', () => {
    expect(pruneYuHeardWrappers(60_000, { baseDir: '/tmp/does-not-exist-yuheard' })).toBe(0)
  })
})

describe('prependWrapperToPath', () => {
  it('prepends the wrapper dir to an existing PATH', () => {
    expect(prependWrapperToPath('/wrappers/pn-1', '/usr/bin:/bin')).toBe('/wrappers/pn-1:/usr/bin:/bin')
  })

  it('handles an empty PATH gracefully', () => {
    expect(prependWrapperToPath('/wrappers/pn-1', '')).toBe('/wrappers/pn-1')
    expect(prependWrapperToPath('/wrappers/pn-1', undefined)).toBe('/wrappers/pn-1')
  })
})

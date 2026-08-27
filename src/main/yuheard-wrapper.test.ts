/**
 * Tests for the YuHeard auto-wrap shell shim generator.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  installYuHeardWrapper,
  uninstallYuHeardWrapper,
  pruneYuHeardWrappers,
  prependWrapperToPath,
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
    // owner-exec bit must be set; we don't assert 0o700 because umask varies
    expect((st.mode & 0o100) !== 0).toBe(true)
  })

  it('embeds the pane id and socket path in the shim body', () => {
    const dir = installYuHeardWrapper('pn-abc', ['claude'], { baseDir, socketPath: '/tmp/yuheard.sock' })
    const body = readFileSync(join(dir, 'claude'), 'utf8')
    expect(body).toContain('YUHEARD_PANE_ID')
    expect(body).toContain('/tmp/yuheard.sock')
    // The shim should exec the real binary from PATH, not hardcode it.
    expect(body).toMatch(/command -v claude/)
    expect(body).toMatch(/exec "\$real" "\$@"/)
  })

  it('overwrites stale shims from a previous install of the same pane', () => {
    installYuHeardWrapper('pn-1', ['claude'], { baseDir, socketPath: '/tmp/old.sock' })
    installYuHeardWrapper('pn-1', ['claude', 'codex'], { baseDir, socketPath: '/tmp/new.sock' })
    const dir = join(baseDir, 'pn-1')
    expect(existsSync(join(dir, 'claude'))).toBe(true)
    expect(existsSync(join(dir, 'codex'))).toBe(true)
    const body = readFileSync(join(dir, 'claude'), 'utf8')
    expect(body).toContain('/tmp/new.sock')
    expect(body).not.toContain('/tmp/old.sock')
  })

  it('does nothing for an empty agent list', () => {
    const dir = installYuHeardWrapper('pn-1', [], { baseDir })
    expect(existsSync(join(dir, 'claude'))).toBe(false)
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
    // Backdate mtime by 2 days
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

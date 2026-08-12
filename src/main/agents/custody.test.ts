import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// The journal singleton is lazy and never opened by these tests; the stub only
// has to satisfy the module-level `const { app } = electron` destructure.
vi.mock('electron', () => ({
  default: { app: { getPath: () => '/tmp' } },
  app: { getPath: () => '/tmp' },
}))

import { authorityOf, scopeKeyFor, scopeViolation } from './custody'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('scopeViolation', () => {
  it('passes when the granted workspace root is still there', () => {
    const root = mkdtempSync(join(tmpdir(), 'custody-scope-'))
    roots.push(root)
    expect(scopeViolation({ cwd: root, provider: 'claude', bridgeId: 'br-1' }, 'tab1:claude')).toBeNull()
  })

  it('trips when the root a grant was scoped to has vanished', () => {
    const root = mkdtempSync(join(tmpdir(), 'custody-scope-'))
    rmSync(root, { recursive: true, force: true })
    const trip = scopeViolation({ cwd: root, provider: 'claude', bridgeId: 'br-1' }, 'tab1:claude', 'turn-9', 500)
    expect(trip).toMatchObject({ invariant: 'scope-unknown', halts: true, at: 500 })
    expect(trip!.detail).toContain(root)
    expect(trip!.scope).toMatchObject({ bridgeId: 'br-1', turnId: 'turn-9', sessionKey: 'tab1:claude' })
  })

  it('does not assert remote roots, whose boundary is the pinned host key not a local stat', () => {
    expect(scopeViolation({ cwd: 'ssh://host/nowhere/at/all', provider: 'codex', bridgeId: 'br-2' }, null)).toBeNull()
  })
})

describe('authorityOf', () => {
  it('snapshots exactly the fields a grant is scoped to', () => {
    expect(authorityOf({
      bridgeId: 'br-1', provider: 'claude', cwd: '/repo', mode: 'full',
      toolPolicy: 'read-only', externalDirectories: ['/b', '/a'],
      mcpServers: [{ id: 'fs-1', name: 'fs', command: 'x' }],
    })).toEqual({
      provider: 'claude', cwd: '/repo', mode: 'full', toolPolicy: 'read-only',
      externalDirectories: ['/a', '/b'], mcpServers: ['fs'],
    })
  })
})

describe('scopeKeyFor', () => {
  it('prefers the stable thread key so a halt outlives the timestamped bridgeId', () => {
    expect(scopeKeyFor('tab1:claude', 'br-tab1-claude-abc')).toBe('tab1:claude')
    expect(scopeKeyFor('tab1:claude', 'br-tab1-claude-zzz')).toBe('tab1:claude')
  })

  it('falls back to the bridge when a thread key is unavailable', () => {
    expect(scopeKeyFor(null, 'br-1')).toBe('bridge:br-1')
  })
})

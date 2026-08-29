import { mkdirSync, mkdtempSync, realpathSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { BrainAuthorizationPolicy, brainAuthorizationPolicyPath } from './brain-authorization-policy'

describe('Brain authorization policy', () => {
  it('persists canonical roots, scopes, and local audit across restart', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'brain-policy-')); const root = join(dataDir, 'workspace'); mkdirSync(root)
    const canonicalRoot = realpathSync(root)
    let now = 100; const path = brainAuthorizationPolicyPath(dataDir)
    const policy = new BrainAuthorizationPolicy(path, [root], ['workspace:read'], () => now)
    now = 200
    const updated = policy.update({ roots: [root], scopes: ['agent', 'workspace:read'], userId: 'owner' })
    expect(updated).toMatchObject({ scopes: ['agent', 'workspace:read'], roots: [canonicalRoot], audit: [{ userId: 'owner', at: 200 }] })
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(new BrainAuthorizationPolicy(path, [], [], () => 300).current()).toEqual(updated)
  })
  it('rejects invalid policy', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'brain-policy-invalid-'))
    const policy = new BrainAuthorizationPolicy(brainAuthorizationPolicyPath(dataDir), [], [])
    expect(() => policy.update({ roots: [], scopes: ['agent'], userId: 'owner' })).toThrow('at least one workspace root')
    expect(() => policy.update({ roots: ['/definitely/missing'], scopes: [], userId: 'owner' })).toThrow('does not exist')
  })
})

import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { DESKTOP_CATALOGUE_AUTHORITY_KEY } from '../shared/continuity-state-types'
import { ContinuityStateService, continuityStatePath } from './continuity-state-service'

describe('ContinuityStateService', () => {
  it('allows only owner-loopback seeding to establish desktop catalogue authority', () => {
    const path = continuityStatePath(mkdtempSync(join(tmpdir(), 'crewcode-continuity-')))
    const service = new ContinuityStateService(path)
    expect(() => service.update({ [DESKTOP_CATALOGUE_AUTHORITY_KEY]: JSON.stringify({ version: 1, source: 'desktop' }) }))
      .toThrow('continuity key is not allowed')

    const seeded = service.seedDesktopCatalogue({
      'crewcode:sessionsByTab': JSON.stringify({ chat: [{ id: 'chat' }] }),
    })
    expect(seeded.values[DESKTOP_CATALOGUE_AUTHORITY_KEY]).toBe(JSON.stringify({ version: 1, source: 'desktop' }))
    expect(new ContinuityStateService(path).snapshot().values).toEqual(seeded.values)
  })
  it('merges allowlisted catalogue patches and persists owner-only state', () => {
    const root = mkdtempSync(join(tmpdir(), 'crewcode-continuity-'))
    const path = continuityStatePath(root)
    const service = new ContinuityStateService(path, () => 1234)

    expect(service.update({ 'crewcode:activeWorkspaceId': 'workspace-one' })).toMatchObject({
      revision: 1,
      updatedAt: 1234,
      values: { 'crewcode:activeWorkspaceId': 'workspace-one' },
    })
    expect(service.update({ 'crewcode:workspaceTabs:v1': '[{"id":"tab-one"}]' })).toMatchObject({
      revision: 2,
      values: {
        'crewcode:activeWorkspaceId': 'workspace-one',
        'crewcode:workspaceTabs:v1': '[{"id":"tab-one"}]',
      },
    })
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ version: 1, revision: 2 })
    expect(new ContinuityStateService(path).snapshot().values).toEqual(service.snapshot().values)
  })

  it('rejects unrecognized, malformed, and oversized catalogue values', () => {
    const service = new ContinuityStateService(continuityStatePath(mkdtempSync(join(tmpdir(), 'crewcode-continuity-'))))

    expect(() => service.update({ arbitrary: '{}' })).toThrow('continuity key is not allowed')
    expect(() => service.update({ 'crewcode:sessionsByTab': 'not json' })).toThrow()
    expect(() => service.update({ 'crewcode:sessionsByTab': `"${'x'.repeat(2 * 1024 * 1024)}"` })).toThrow('continuity value exceeds')
    expect(service.snapshot()).toMatchObject({ revision: 0, values: {} })
  })

  it('does not advance the revision for an empty patch', () => {
    const service = new ContinuityStateService(continuityStatePath(mkdtempSync(join(tmpdir(), 'crewcode-continuity-'))))
    expect(service.update({})).toMatchObject({ revision: 0, values: {} })
  })
})

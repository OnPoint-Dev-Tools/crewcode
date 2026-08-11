import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveSuggestedCrewCheck, suggestedCrewChecks } from './crew-verification'

const roots: string[] = []
function fixture(pkg: object, lock?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'crew-checks-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg))
  if (lock) writeFileSync(join(root, lock), '')
  return root
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('suggestedCrewChecks', () => {
  it('returns only allowlisted scripts and exposes their body for review', () => {
    const root = fixture({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run', deploy: 'dangerous-deploy' } })
    expect(suggestedCrewChecks(root)).toEqual([
      { id: 'typecheck', label: 'Typecheck', command: 'npm', args: ['run', 'typecheck'], script: 'tsc --noEmit' },
      { id: 'test', label: 'Tests', command: 'npm', args: ['run', 'test'], script: 'vitest run' },
    ])
    expect(resolveSuggestedCrewCheck(root, 'deploy')).toBeNull()
  })

  it('uses the checked-in package-manager lockfile', () => {
    const root = fixture({ scripts: { test: 'vitest run' } }, 'pnpm-lock.yaml')
    expect(suggestedCrewChecks(root)[0]).toMatchObject({ command: 'pnpm', args: ['run', 'test'] })
  })

  it('returns no suggestions for a non-package workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-checks-'))
    roots.push(root)
    expect(suggestedCrewChecks(root)).toEqual([])
  })
})

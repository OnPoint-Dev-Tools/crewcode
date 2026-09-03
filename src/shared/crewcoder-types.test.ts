import { describe, expect, it } from 'vitest'
import { crewCoderApprovalForProfile, crewCoderProfileLocksExecutionMode, normalizeCrewCoderApprovalMode } from './crewcoder-types'

describe('CrewCoder execution-mode ownership', () => {
  it('locks CrewCode execution mode only for a concrete active CrewCoder profile', () => {
    expect(crewCoderProfileLocksExecutionMode('crewcoder', 'plugin')).toBe(true)
    expect(crewCoderProfileLocksExecutionMode('crewcoder', undefined)).toBe(false)
    expect(crewCoderProfileLocksExecutionMode('codex', 'plugin')).toBe(false)
  })
})

describe('CrewCoder approval normalization', () => {
  it('accepts explicit full access and otherwise fails closed to review', () => {
    for (const mode of ['review', 'always', 'never', 'full-access', 'sandboxed'] as const) {
      expect(normalizeCrewCoderApprovalMode(mode)).toBe(mode)
    }
    expect(normalizeCrewCoderApprovalMode('unknown')).toBe('review')
    expect(normalizeCrewCoderApprovalMode(undefined)).toBe('review')
  })

  it('keeps full access effective only while the visible CrewCoder profile is active', () => {
    expect(crewCoderApprovalForProfile('crewcoder', 'full-access')).toBe('full-access')
    expect(crewCoderApprovalForProfile('plugin', 'full-access')).toBe('review')
    expect(crewCoderApprovalForProfile(undefined, 'full-access')).toBe('review')
  })
})

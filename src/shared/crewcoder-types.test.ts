import { describe, expect, it } from 'vitest'
import { crewCoderProfileLocksExecutionMode } from './crewcoder-types'

describe('CrewCoder execution-mode ownership', () => {
  it('locks CrewCode execution mode only for a concrete active CrewCoder profile', () => {
    expect(crewCoderProfileLocksExecutionMode('crewcoder', 'plugin')).toBe(true)
    expect(crewCoderProfileLocksExecutionMode('crewcoder', undefined)).toBe(false)
    expect(crewCoderProfileLocksExecutionMode('codex', 'plugin')).toBe(false)
  })
})

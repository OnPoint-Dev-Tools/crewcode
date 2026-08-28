import { describe, expect, it } from 'vitest'
import type { AgentInfo } from '../../types'
import { crewCoderModesAvailable } from './ModelRow'

const crewcoder = (available: boolean): AgentInfo => ({
  id: 'crewcoder', name: 'CrewCoder', path: available ? '/usr/bin/crewcoder' : null,
  available, transport: 'bridge',
})

describe('CrewCoder model-row control', () => {
  it('loads only for an available, active CrewCoder provider', () => {
    expect(crewCoderModesAvailable([crewcoder(true)], 'crewcoder')).toBe(true)
    expect(crewCoderModesAvailable([crewcoder(false)], 'crewcoder')).toBe(false)
    expect(crewCoderModesAvailable([crewcoder(true)], 'codex')).toBe(false)
  })
})

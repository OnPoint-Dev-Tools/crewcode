import { describe, expect, it } from 'vitest'
import { crewCoderModeItems } from './CrewCoderModePicker'

describe('CrewCoder mode picker', () => {
  it('shows every CrewCoder ACP mode in stable order', () => {
    expect(crewCoderModeItems().map(item => item.id)).toEqual([
      '', 'general', 'crewcoder', 'plugin', 'extension',
    ])
  })
})

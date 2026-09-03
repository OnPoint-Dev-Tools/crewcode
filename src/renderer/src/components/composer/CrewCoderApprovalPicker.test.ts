import { describe, expect, it } from 'vitest'
import { crewCoderApprovalItems } from './CrewCoderApprovalPicker'

describe('CrewCoder approval picker', () => {
  it('exposes every CrewCoder approval policy in stable order', () => {
    expect(crewCoderApprovalItems().map(item => item.id)).toEqual([
      'review', 'always', 'never', 'full-access', 'sandboxed',
    ])
  })
})

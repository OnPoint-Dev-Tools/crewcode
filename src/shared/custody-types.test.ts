import { describe, expect, it } from 'vitest'
import { isCrewLaneSessionKey } from './custody-types'

describe('crew lane custody scope', () => {
  it.each([
    'crew/lane-1:claude',
    'crew/019abc:plugin:custom-agent',
  ])('recognizes a synthetic crew lane thread: %s', sessionKey => {
    expect(isCrewLaneSessionKey(sessionKey)).toBe(true)
  })

  it.each([
    'tab-1:claude',
    'chat/ordinary:codex',
    'crew/session-1/supervisor:claude',
    'crew/:claude',
    null,
    undefined,
  ])('does not apply crew custody gating to %s', sessionKey => {
    expect(isCrewLaneSessionKey(sessionKey)).toBe(false)
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_CRASH_COOLDOWN_MS,
  claudeInteractiveProbeIsCoolingDown,
  noteClaudeProbeCrash,
  resetClaudeProbeCrashCooldownForTest,
} from './claude-fetch'

describe('Claude usage probe crash cooldown', () => {
  afterEach(() => resetClaudeProbeCrashCooldownForTest())

  it('blocks the interactive fallback for ten minutes after a process crash', () => {
    noteClaudeProbeCrash(1_000)

    expect(claudeInteractiveProbeIsCoolingDown(1_000)).toBe(true)
    expect(claudeInteractiveProbeIsCoolingDown(1_000 + CLAUDE_CRASH_COOLDOWN_MS - 1)).toBe(true)
    expect(claudeInteractiveProbeIsCoolingDown(1_000 + CLAUDE_CRASH_COOLDOWN_MS)).toBe(false)
  })

  it('never shortens an existing cooldown', () => {
    noteClaudeProbeCrash(10_000)
    noteClaudeProbeCrash(5_000)

    expect(claudeInteractiveProbeIsCoolingDown(10_000 + CLAUDE_CRASH_COOLDOWN_MS - 1)).toBe(true)
  })
})

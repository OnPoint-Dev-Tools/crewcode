import { describe, it, expect } from 'vitest'

import { nextToolsInFlight, shouldAbandonRound } from './crew-idle-watchdog'
import type { RoundLiveness } from './crew-idle-watchdog'

const IDLE = 3 * 60_000 // 3 min, matching the hook's IDLE_TIMEOUT_MS

function liveness(over: Partial<RoundLiveness> = {}): RoundLiveness {
  return { waitingCount: 1, toolsInFlight: 0, lastActivityAt: 0, idleTimeoutMs: IDLE, ...over }
}

describe('nextToolsInFlight', () => {
  it('opens a tool on tool_start', () => {
    expect(nextToolsInFlight(0, 'tool_start')).toBe(1)
    expect(nextToolsInFlight(2, 'tool_start')).toBe(3)
  })

  it('closes a tool on tool_end', () => {
    expect(nextToolsInFlight(2, 'tool_end')).toBe(1)
    expect(nextToolsInFlight(1, 'tool_end')).toBe(0)
  })

  it('floors at zero so a stray/duplicate tool_end cannot go negative', () => {
    expect(nextToolsInFlight(0, 'tool_end')).toBe(0)
  })

  it('leaves the count unchanged for non-tool events', () => {
    for (const type of ['turn_start', 'text_delta', 'thinking_delta', 'tool_update', 'turn_end'] as const) {
      expect(nextToolsInFlight(2, type)).toBe(2)
    }
  })

  it('round-trips a paired start/end back to the original count', () => {
    const opened = nextToolsInFlight(0, 'tool_start')
    expect(nextToolsInFlight(opened, 'tool_end')).toBe(0)
  })

  it('tracks overlapping tools across workers', () => {
    let n = 0
    n = nextToolsInFlight(n, 'tool_start') // worker A
    n = nextToolsInFlight(n, 'tool_start') // worker B
    expect(n).toBe(2)
    n = nextToolsInFlight(n, 'tool_end')   // A done, B still running
    expect(n).toBe(1)
  })
})

describe('shouldAbandonRound', () => {
  it('abandons a truly dark round: awaited, no tools, idle window elapsed', () => {
    expect(shouldAbandonRound(liveness({ lastActivityAt: 0 }), IDLE)).toBe(true)
    expect(shouldAbandonRound(liveness({ lastActivityAt: 0 }), IDLE + 1)).toBe(true)
  })

  it('never abandons once nothing is awaited', () => {
    expect(shouldAbandonRound(liveness({ waitingCount: 0, lastActivityAt: 0 }), IDLE * 10)).toBe(false)
  })

  it('never abandons while a tool is in flight — the false-positive guard', () => {
    // A 10-min silent build: way past the idle window, but a tool is open.
    expect(shouldAbandonRound(liveness({ toolsInFlight: 1, lastActivityAt: 0 }), 10 * 60_000)).toBe(false)
  })

  it('resumes the clock after the last tool closes', () => {
    const afterTool = liveness({ toolsInFlight: 0, lastActivityAt: 9 * 60_000 })
    // tool_end was the last event, so the clock effectively restarts from it.
    expect(shouldAbandonRound(afterTool, 9 * 60_000 + IDLE - 1)).toBe(false)
    expect(shouldAbandonRound(afterTool, 9 * 60_000 + IDLE)).toBe(true)
  })

  it('does not abandon before the idle window elapses (recent activity)', () => {
    expect(shouldAbandonRound(liveness({ lastActivityAt: 1000 }), 1000 + IDLE - 1)).toBe(false)
  })

  it('fires exactly at the boundary (>= idle window)', () => {
    expect(shouldAbandonRound(liveness({ lastActivityAt: 0 }), IDLE - 1)).toBe(false)
    expect(shouldAbandonRound(liveness({ lastActivityAt: 0 }), IDLE)).toBe(true)
  })

  it('keeps a round alive when both a tool is open and time has elapsed', () => {
    // tool gate wins regardless of how stale lastActivityAt looks.
    expect(shouldAbandonRound(liveness({ toolsInFlight: 2, lastActivityAt: 0 }), 60 * 60_000)).toBe(false)
  })
})

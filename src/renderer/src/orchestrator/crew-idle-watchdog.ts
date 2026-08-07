/**
 * Pure decision logic for the crew Supervisor's idle watchdog. Extracted from
 * useCrewSupervisor so the "is this worker hung or just busy?" call can be
 * unit-tested without refs, timers, or a live bridge.
 *
 * The watchdog only abandons a delegation round that has gone *truly* dark:
 * workers still awaited, no tool in flight, and no bridge event for longer than
 * the idle window. A worker streaming text/thinking keeps resetting the clock;
 * a worker inside a long tool call is covered by the in-flight gate even though
 * the bridge emits nothing between tool_start and tool_end.
 */

import type { BridgeEvent } from '../types'

/**
 * Maintain the count of open tool calls across a round's awaited workers.
 * tool_start opens one, tool_end closes one (floored at 0 so a stray tool_end —
 * e.g. from a re-delivered event — can't drive the count negative).
 */
export function nextToolsInFlight(count: number, type: BridgeEvent['type']): number {
  if (type === 'tool_start') return count + 1
  if (type === 'tool_end') return Math.max(0, count - 1)
  return count
}

export interface RoundLiveness {
  /** Workers still awaited this round; 0 means nothing left to wait on. */
  waitingCount:  number
  /** Open tool calls; > 0 means a worker is provably mid-tool, not hung. */
  toolsInFlight:  number
  /** ms timestamp of the last bridge event from an awaited worker. */
  lastActivityAt: number
  /** How long a round may stay silent (no events, no tools) before abandon. */
  idleTimeoutMs:  number
}

/**
 * True only when the round should be abandoned: still awaiting workers, no tool
 * running, and the idle window fully elapsed since the last event. Any one of
 * those being false keeps the round alive.
 */
export function shouldAbandonRound(s: RoundLiveness, now: number): boolean {
  if (s.waitingCount === 0) return false
  if (s.toolsInFlight > 0) return false
  return now - s.lastActivityAt >= s.idleTimeoutMs
}

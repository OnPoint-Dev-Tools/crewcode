// Pure decision logic for delivering delegated-worker reports to a parent chat:
// when to coalesce, when a wake costs budget, and when a silent thread should be
// given up on. Extracted from `useDelegationReports` for the same reason crew
// extracted `crew-idle-watchdog` — these are the calls worth testing without
// refs, timers, or a live bridge.

/**
 * How long to hold a finished worker's report before waking the parent, so a
 * fan-out that finishes together produces ONE turn instead of one per thread.
 *
 * Short enough to feel immediate, long enough to catch a batch: workers that
 * finish within the same second are almost always the same request.
 */
export const REPORT_COALESCE_MS = 1_500

/**
 * How long to keep re-reading a finished thread's transcript before giving up on
 * a settled reply, and how often. Mirrors crew's `reportLaneReply` retry (8 × 75ms).
 *
 * `turn_end` arrives before the renderer's stream buffers flush, so a synchronous
 * read captures the agent's opening line and none of its result. That produced
 * reports whose content was "I'll run the suite" — and, because the next event
 * for the same turn then read DIFFERENT (complete) text, defeated reply-text
 * deduplication and delivered the thread twice.
 */
export const REPORT_SETTLE_ATTEMPTS = 8
export const REPORT_SETTLE_INTERVAL_MS = 75

/** Silence after which a running delegated thread is presumed hung and reported
 *  as abandoned. Matches crew's watchdog window — same bridges, same failure. */
export const THREAD_IDLE_TIMEOUT_MS = 3 * 60_000
/** How often the watchdog samples. Matches crew's `IDLE_CHECK_MS`. */
export const THREAD_IDLE_CHECK_MS = 15_000

export interface ThreadLiveness {
  /** Whether the thread's bridge is mid-turn. A finished thread is not hung. */
  running: boolean
  /** Open tool calls; > 0 means it is provably mid-tool, not hung. A single long
   *  tool call emits nothing between start and end, so elapsed time alone would
   *  abandon a thread that is working perfectly. */
  toolsInFlight: number
  /** ms timestamp of the last bridge event from this thread. */
  lastActivityAt: number
  idleTimeoutMs: number
}

/**
 * True only when a delegated thread has gone genuinely dark: still running, no
 * tool open, and the whole idle window elapsed since its last bridge event.
 */
export function shouldAbandonThread(s: ThreadLiveness, now: number): boolean {
  if (!s.running) return false
  if (s.toolsInFlight > 0) return false
  // A thread that never emitted anything has no baseline to measure from;
  // treat the absence as "not yet observed" rather than instantly hung.
  if (s.lastActivityAt <= 0) return false
  return now - s.lastActivityAt >= s.idleTimeoutMs
}

export interface WakeCostInput {
  /** True when EVERY report in this batch came from a thread the parent spawned
   *  during a turn the user actually drove. */
  allFromUserDrivenWork: boolean
  /** Autonomous generations already spent since the user's last message. */
  autonomousDepth: number
  maxAutonomousWakes: number
}

export type WakeDecision =
  | { kind: 'free' }
  | { kind: 'spend' }
  | { kind: 'exhausted' }

/**
 * Decide what a wake costs.
 *
 * Budget bounds RECURSION, not volume. Spawning five workers from a turn you
 * asked for and having all five report is one wake and costs nothing — that is
 * the feature working, and flat counting would penalize exactly the fan-out
 * people delegate for. What must be bounded is a parent that answers an
 * autonomous wake by spawning more threads, which then wake it again: each such
 * generation costs one, and running out pauses until the user speaks.
 */
export function wakeCost(input: WakeCostInput): WakeDecision {
  if (input.allFromUserDrivenWork) return { kind: 'free' }
  if (input.autonomousDepth >= input.maxAutonomousWakes) return { kind: 'exhausted' }
  return { kind: 'spend' }
}

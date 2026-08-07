// Routes delegated workers' finished replies back to the chat that spawned them.
//
// The delegation API used to be pull-only: the preamble told the agent to poll
// `GET /v1/threads`, and agents forget to poll. This is the push half. It is
// modelled on the crew Supervisor's reporting loop, and borrows three things
// from it that are not optional:
//
//   1. COALESCING. Crew's `feedSupervisor` drains all buffered worker replies
//      into ONE supervisor turn. Waking a parent costs a full turn at that
//      chat's whole context, so a five-way fan-out must produce one wake, not
//      five. The report payload is trivial; the turn it triggers is not.
//   2. AN IN-FLIGHT GUARD claimed synchronously before any await. Crew's `busy`
//      flag exists because parallel workers finishing microseconds apart each
//      check-then-act on the same coordinator; without it they all see "idle"
//      and fire concurrent prompts at one bridge.
//   3. AN IDLE WATCHDOG. A bridge can die without emitting `turn_end`. Crew
//      abandons a silent worker and tells the supervisor rather than waiting
//      forever, because an unreported hang looks exactly like work in progress.
//
// The wake budget bounds RECURSION, not volume — see `delegation-wake-policy`.

import { useEffect, useRef } from 'react'
import {
  buildAbandonedReport,
  buildDelegationReport,
  buildReportsBlock,
  hasStreamingOutput,
  reportNoticeText,
  type DelegationReport,
  type ReportDelivery,
} from './delegation-report'
import {
  REPORT_COALESCE_MS,
  REPORT_SETTLE_ATTEMPTS,
  REPORT_SETTLE_INTERVAL_MS,
  THREAD_IDLE_CHECK_MS,
  THREAD_IDLE_TIMEOUT_MS,
  shouldAbandonThread,
  wakeCost,
} from './delegation-wake-policy'
import { MAX_AUTONOMOUS_WAKES } from './delegation-report'
import { nextToolsInFlight } from '../orchestrator/crew-idle-watchdog'
import { delegationInbox } from '../stores/delegation-inbox-store'
import type { BridgeEvent, ChatPromptOptions, Message, Session } from '../types'

export interface DelegationReportsDeps {
  /** Turn-end fan-out from the bridge registry. The `scopeId` it reports IS the
   *  chat session id — bridges are keyed `${sessionId}:${agentId}`. */
  subscribeTurnEnd: (cb: (bridgeId: string, scopeId: string, turnId?: string) => void) => () => void
  /** Liveness heartbeat, the same one crew's watchdog uses. */
  subscribeActivity: (cb: (bridgeId: string, scopeId: string, type: BridgeEvent['type']) => void) => () => void
  sessionById: (sessionId: string) => Session | undefined
  /** Every live session, for the watchdog sweep and cohort accounting. */
  allSessions: () => Session[]
  messagesForSession: (sessionId: string) => Message[]
  /** Synchronous liveness read. Must not be a React-render snapshot: the whole
   *  decision is "is the parent mid-turn *right now*". */
  isRunning: (sessionId: string, agentId: string) => boolean
  getBridgeId: (sessionId: string, agentId: string) => string | null
  promptBridge: (bridgeId: string, text: string, options?: ChatPromptOptions) => Promise<{ ok: boolean; error?: string }>
  /** Append a visible row to a chat's transcript, so a report is never invisible. */
  appendSystemMessage: (sessionId: string, text: string) => void
  /** Settings → "Wake chat on delegated report". Read at delivery time, not
   *  mount time, so toggling it takes effect on the next report. */
  wakeEnabled: () => boolean
  /** Start (or revive) the parent's bridge so an idle chat can be woken. The
   *  10-minute idle sweep reclaims bridges, and a worker often outlives it —
   *  without this, exactly the long jobs worth waking for could not wake. */
  ensureBridgeForSession: (session: Session) => Promise<string | null>
}

interface ParentBatch {
  reports: DelegationReport[]
  timer: ReturnType<typeof setTimeout> | null
  /** Claimed synchronously before any await — crew's `busy`. */
  delivering: boolean
}

export function useDelegationReports(deps: DelegationReportsDeps): void {
  const depsRef = useRef(deps)
  depsRef.current = deps

  // Coalescing buffers, keyed by parent session. Refs, not state: these change
  // on every worker event and must never re-render the App shell.
  const batchesRef = useRef<Record<string, ParentBatch>>({})
  // Children whose current turn has already been reported. `useAgentBridge`
  // routes `turn_end`, `error` AND `closed` through the same callback, so one
  // logical turn can fire it several times. Crew consumes a lane from its
  // `waiting` set on the first reply and ignores the rest; this is that guard.
  //
  // Comparing reply TEXT instead (the first attempt) does not work: the settle
  // retry means an early event and a late one legitimately see different text,
  // so every duplicate looked like a new report.
  const reportedRef = useRef<Set<string>>(new Set())
  // Settle retries in flight, so a second event cannot start a second retry loop
  // for the same child.
  const settlingRef = useRef<Set<string>>(new Set())
  const settleTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  // Watchdog liveness, per delegated child.
  const livenessRef = useRef<Record<string, { lastActivityAt: number; toolsInFlight: number }>>({})
  // Threads already reported as abandoned — never report the same hang twice.
  const abandonedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const d = depsRef.current

    const batchFor = (parentId: string): ParentBatch => {
      const existing = batchesRef.current[parentId]
      if (existing) return existing
      const created: ParentBatch = { reports: [], timer: null, delivering: false }
      batchesRef.current[parentId] = created
      return created
    }

    /** Queue a report and schedule (or extend) this parent's coalescing window. */
    const enqueue = (parent: Session, report: DelegationReport): void => {
      const batch = batchFor(parent.id)
      batch.reports.push(report)

      // A parent mid-turn takes the report immediately: it is already burning a
      // turn the user is watching, so there is nothing to coalesce for.
      if (depsRef.current.isRunning(parent.id, parent.agentId)) {
        if (batch.timer) { clearTimeout(batch.timer); batch.timer = null }
        void deliver(parent.id)
        return
      }

      if (batch.timer) return
      batch.timer = setTimeout(() => {
        batch.timer = null
        void deliver(parent.id)
      }, REPORT_COALESCE_MS)
    }

    async function deliver(parentId: string): Promise<void> {
      const d = depsRef.current
      const batch = batchesRef.current[parentId]
      if (!batch || batch.reports.length === 0) return
      // Claim the slot SYNCHRONOUSLY, before the first await. Two workers
      // finishing microseconds apart both reach here; without this they both
      // see an idle parent and fire concurrent prompts at one bridge.
      if (batch.delivering) return
      batch.delivering = true

      const reports = batch.reports
      batch.reports = []

      const parent = d.sessionById(parentId)
      if (!parent) { batch.delivering = false; return }

      const settle = (delivery: ReportDelivery): void =>
        d.appendSystemMessage(parentId, reportNoticeText(reports, delivery))
      const buffer = (delivery: ReportDelivery = 'buffered'): void => {
        for (const report of reports) delegationInbox.push(report)
        settle(delivery)
      }

      try {
        const cohort = cohortProgress(reports, d.allSessions(), s => d.isRunning(s.id, s.agentId))

        // Mid-turn: fold into the running turn through the normal follow-up
        // path, the way a crew worker reports to its supervisor.
        const runningBridgeId = d.isRunning(parent.id, parent.agentId)
          ? d.getBridgeId(parent.id, parent.agentId)
          : null
        if (runningBridgeId) {
          const result = await d.promptBridge(
            runningBridgeId,
            buildReportsBlock(reports, 'live', cohort),
            { streamingBehavior: 'followUp' },
          )
          result.ok ? settle('live') : buffer()
          return
        }

        if (!d.wakeEnabled()) return buffer()

        const wake = delegationInbox.wakeState(parent.id)
        const cost = wakeCost({
          // A wide fan-out from a turn the user drove is free, however many
          // threads it contains. Only work spawned BY an autonomous turn counts.
          allFromUserDrivenWork: reports.every(r => !r.autoSpawned),
          autonomousDepth: wake.autonomousDepth,
          maxAutonomousWakes: MAX_AUTONOMOUS_WAKES,
        })
        if (cost.kind === 'exhausted') return buffer('wake-budget-spent')
        if (cost.kind === 'spend') delegationInbox.spendAutonomousRound(parent.id)

        const bridgeId = d.getBridgeId(parent.id, parent.agentId)
          ?? await d.ensureBridgeForSession(parent)
        if (!bridgeId) return buffer()

        // Mark the turn autonomous BEFORE prompting: threads it spawns must be
        // stamped auto-spawned, and the spawn can land while this is in flight.
        delegationInbox.setAutonomousTurn(parent.id, true)
        // A fresh turn, NOT a follow-up: there is no running turn to fold into,
        // and followUp on an idle bridge means different things per provider.
        const result = await d.promptBridge(bridgeId, buildReportsBlock(reports, 'woke', cohort))
        if (result.ok) settle('woke')
        else {
          delegationInbox.setAutonomousTurn(parent.id, false)
          buffer()
        }
      } catch {
        delegationInbox.setAutonomousTurn(parent.id, false)
        buffer()
      } finally {
        batch.delivering = false
        // Reports that arrived during the await were queued behind us.
        if (batch.reports.length > 0 && !batch.timer) void deliver(parentId)
      }
    }

    const offTurnEnd = d.subscribeTurnEnd((_bridgeId, scopeId) => {
      const d = depsRef.current
      const settled = d.sessionById(scopeId)
      if (!settled) return

      // A parent's own turn ending closes its autonomous window, so threads
      // spawned after it are attributed to whatever starts next.
      if (delegationInbox.wakeState(scopeId).inAutonomousTurn) {
        delegationInbox.setAutonomousTurn(scopeId, false)
      }

      if (settled.origin !== 'delegated' || !settled.delegatedBy) return
      // A thread that reported normally is no longer a watchdog candidate.
      delete livenessRef.current[settled.id]

      // Already reported this turn, or already waiting for it to settle. The
      // trailing `closed`/`error` event for the same turn lands here.
      if (reportedRef.current.has(settled.id) || settlingRef.current.has(settled.id)) return

      const parent = d.sessionById(settled.delegatedBy)
      // Delegation off means the parent's agent no longer holds the API context
      // that explains what a delegated thread is — reporting would be noise.
      if (!parent || !parent.delegationEnabled) return

      settlingRef.current.add(settled.id)
      reportWhenSettled(settled.id, parent.id, 0)
    })

    /**
     * Re-read the thread's transcript until it stops moving, then report once.
     *
     * Reading synchronously on `turn_end` captures the text that existed before
     * the renderer flushed its stream buffers — which in practice is the agent's
     * opening line and none of its result.
     */
    function reportWhenSettled(childId: string, parentId: string, attempt: number): void {
      const d = depsRef.current
      const child = d.sessionById(childId)
      const parent = d.sessionById(parentId)
      if (!child || !parent) { settlingRef.current.delete(childId); return }

      const messages = d.messagesForSession(childId)
      const report = buildDelegationReport({
        threadId: child.id,
        parentSessionId: parent.id,
        title: child.label,
        ...(child.delegatedBranch ? { branch: child.delegatedBranch } : {}),
        messages,
        at: Date.now(),
        ...(child.delegationRunId ? { runId: child.delegationRunId } : {}),
        ...(child.delegatedDuringWake ? { autoSpawned: true } : {}),
      })

      const unsettled = hasStreamingOutput(messages) || !report
      if (unsettled && attempt < REPORT_SETTLE_ATTEMPTS) {
        const timer = setTimeout(
          () => reportWhenSettled(childId, parentId, attempt + 1),
          REPORT_SETTLE_INTERVAL_MS,
        )
        settleTimersRef.current.add(timer)
        return
      }

      settlingRef.current.delete(childId)
      // Claim the turn before enqueueing, so a trailing event during delivery is
      // dropped rather than becoming a second report.
      reportedRef.current.add(childId)
      if (!report) return
      enqueue(parent, report)
    }

    // Liveness heartbeat for the watchdog. Any bridge event from a delegated
    // thread resets its clock; tool_start/tool_end gate the in-flight count so a
    // single long tool call is not mistaken for a hang.
    const offActivity = d.subscribeActivity((_bridgeId, scopeId, type) => {
      const session = depsRef.current.sessionById(scopeId)
      if (!session || session.origin !== 'delegated') return

      // A new turn means genuinely new work — a follow-up the parent sent, or a
      // rerun. Release the consume-once guard so its result reports too; without
      // this, a thread could only ever report once in its lifetime.
      if (type === 'turn_start') {
        reportedRef.current.delete(scopeId)
        abandonedRef.current.delete(scopeId)
      }

      const prev = livenessRef.current[scopeId] ?? { lastActivityAt: 0, toolsInFlight: 0 }
      livenessRef.current[scopeId] = {
        lastActivityAt: Date.now(),
        toolsInFlight: nextToolsInFlight(prev.toolsInFlight, type),
      }
    })

    const sweep = setInterval(() => {
      const d = depsRef.current
      const now = Date.now()
      for (const child of d.allSessions()) {
        if (child.origin !== 'delegated' || !child.delegatedBy) continue
        if (child.archived || abandonedRef.current.has(child.id)) continue
        const liveness = livenessRef.current[child.id]
        if (!liveness) continue
        if (!shouldAbandonThread({
          running: d.isRunning(child.id, child.agentId),
          toolsInFlight: liveness.toolsInFlight,
          lastActivityAt: liveness.lastActivityAt,
          idleTimeoutMs: THREAD_IDLE_TIMEOUT_MS,
        }, now)) continue

        const parent = d.sessionById(child.delegatedBy)
        abandonedRef.current.add(child.id)
        delete livenessRef.current[child.id]
        if (!parent || !parent.delegationEnabled) continue

        // The thread is NOT closed — it may still come back, and the user may
        // want to see where it stopped. Silence is reported, not acted on.
        enqueue(parent, buildAbandonedReport({
          threadId: child.id,
          parentSessionId: parent.id,
          title: child.label,
          ...(child.delegatedBranch ? { branch: child.delegatedBranch } : {}),
          at: now,
          silentForMs: now - liveness.lastActivityAt,
          ...(child.delegationRunId ? { runId: child.delegationRunId } : {}),
          ...(child.delegatedDuringWake ? { autoSpawned: true } : {}),
        }))
      }
    }, THREAD_IDLE_CHECK_MS)

    return () => {
      offTurnEnd()
      offActivity()
      clearInterval(sweep)
      for (const batch of Object.values(batchesRef.current)) {
        if (batch.timer) clearTimeout(batch.timer)
      }
      for (const timer of settleTimersRef.current) clearTimeout(timer)
      settleTimersRef.current.clear()
      settlingRef.current.clear()
    }
  }, [])
}

/**
 * How much of this batch's cohort has now reported. Only meaningful when every
 * report shares one run — a mixed batch has no single "batch" to be N of.
 */
export function cohortProgress(
  reports: DelegationReport[],
  sessions: Session[],
  isRunning: (session: Session) => boolean,
): { finished: number; total: number } | undefined {
  // Every report must belong to the SAME run, or there is no single batch for
  // this to be N of. A report with no run id (spawned before cohorts existed)
  // disqualifies the batch rather than being silently grouped.
  if (reports.some(r => !r.runId)) return undefined
  const runIds = new Set(reports.map(r => r.runId))
  if (runIds.size !== 1) return undefined

  const [runId] = [...runIds]
  const cohort = sessions.filter(s => s.delegationRunId === runId)
  if (cohort.length === 0) return undefined
  // Outstanding = still mid-turn and not part of this batch. A sibling that
  // finished in an earlier batch is done, not pending.
  const outstanding = cohort.filter(s =>
    !reports.some(r => r.threadId === s.id) && !s.archived && isRunning(s),
  ).length
  return { finished: cohort.length - outstanding, total: cohort.length }
}

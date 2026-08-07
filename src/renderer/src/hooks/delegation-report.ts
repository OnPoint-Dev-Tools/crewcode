// Turns a delegated thread's finished turn into the short report its parent chat
// receives, and assembles buffered reports into the block that rides on the
// parent's next prompt.
//
// Pure, like `delegated-thread-projection`, and for the same reason: a report is
// injected into the parent's context, so its size is a token bill. The bounds are
// the whole point of this file and must stay testable without React or IPC.

import type { Message } from '../types'

/** Tail of the worker's final reply carried in a report. Larger than the polling
 *  summary's 400 (this is the thing the parent acts on) but far below a
 *  transcript — the parent can always `GET /v1/threads/<id>` for the rest. */
export const REPORT_REPLY_CHARS = 1_600
/** Buffered reports per parent. Past this the oldest are dropped: an agent that
 *  spawns in a loop must not be able to grow one prompt without bound. */
export const MAX_BUFFERED_REPORTS = 12

/**
 * Autonomous wake-ups an idle parent may take before it must hear from the user
 * again. Mirrors crew's `MAX_SUPERVISOR_ROUNDS` and exists for the same reason:
 * a parent that reacts to a report by spawning another thread would otherwise
 * chain indefinitely with nobody watching. Resets on every user message to that
 * chat — the budget is scoped to the last thing you actually asked for.
 */
export const MAX_AUTONOMOUS_WAKES = 4

export interface DelegationReport {
  threadId: string
  parentSessionId: string
  title: string
  /** Present only for worktree-isolated threads. */
  branch?: string
  /** Bounded tail of the thread's reply for this turn. */
  reply: string
  /** The turn ended in an error rather than a normal reply. */
  failed: boolean
  at: number
  /** Cohort this thread belongs to — every thread spawned since the parent's
   *  last user message shares one. Lets a fan-out report as a group instead of
   *  as N unrelated pings. */
  runId?: string
  /** The thread was spawned during an AUTONOMOUS turn (one a report started),
   *  not one the user drove. A report from such a thread is the recursive case
   *  the wake budget exists to bound. */
  autoSpawned?: boolean
}

function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated — GET /v1/threads/<id> for more]`
}

function agentText(message: Message): string {
  if (message.kind !== 'agent') return ''
  // Prefer assembled blocks; fall back to the raw streaming buffer.
  const fromBlocks = message.blocks?.filter(b => b[0] === 't').map(b => b[1]).join('')
  return (fromBlocks || message.text || '').trim()
}

/**
 * True while a thread's transcript is still moving.
 *
 * `turn_end` fires before the renderer's stream buffers have flushed, so reading
 * the transcript synchronously in that callback captures whatever text existed
 * BEFORE the final flush — typically the agent's opening "I'll run the suite"
 * and none of the actual result. Crew hit this and solved it by retrying while
 * output is still streaming (`hasStreamingLaneOutput`); this is the same check.
 */
export function hasStreamingOutput(messages: Message[]): boolean {
  return messages.some(message =>
    (message.kind === 'agent' && message.streaming) ||
    (message.kind === 'thinking' && message.streaming) ||
    (message.kind === 'toolcall' && (message.status === 'pending' || message.status === 'running')),
  )
}

/**
 * What the thread said on its way out. Prefers the last agent reply; falls back
 * to the last error row so a thread that died at bridge start still reports
 * something actionable instead of reporting nothing at all.
 */
export function finalReplyOf(messages: Message[]): { reply: string; failed: boolean } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = agentText(messages[i])
    if (text) return { reply: text, failed: false }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.kind === 'system' && message.tone === 'error' && message.text.trim()) {
      return { reply: message.text.trim(), failed: true }
    }
  }
  return { reply: '', failed: false }
}

export interface ReportSource {
  threadId: string
  parentSessionId: string
  title: string
  branch?: string
  messages: Message[]
  at: number
  runId?: string
  autoSpawned?: boolean
}

/** Build one report, or null when the thread produced nothing worth relaying. */
export function buildDelegationReport(source: ReportSource): DelegationReport | null {
  const { reply, failed } = finalReplyOf(source.messages)
  if (!reply) return null
  return {
    threadId: source.threadId,
    parentSessionId: source.parentSessionId,
    title: source.title,
    ...(source.branch ? { branch: source.branch } : {}),
    reply: clamp(reply, REPORT_REPLY_CHARS),
    failed,
    at: source.at,
    ...(source.runId ? { runId: source.runId } : {}),
    ...(source.autoSpawned ? { autoSpawned: true } : {}),
  }
}

/**
 * A thread that went dark: still marked running, no tool open, no bridge event
 * for the whole idle window. Reported as a failure so the parent stops waiting
 * on it — silence is information, and an unreported hang looks identical to work
 * still in progress.
 */
export function buildAbandonedReport(
  source: Omit<ReportSource, 'messages'> & { silentForMs: number },
): DelegationReport {
  const minutes = Math.max(1, Math.round(source.silentForMs / 60_000))
  return {
    threadId: source.threadId,
    parentSessionId: source.parentSessionId,
    title: source.title,
    ...(source.branch ? { branch: source.branch } : {}),
    reply: `This thread produced no output for ${minutes}m and is presumed stuck. It was NOT `
      + `closed — open it to see where it stopped, send it a message to nudge it, or carry on `
      + `without it.`,
    failed: true,
    at: source.at,
    ...(source.runId ? { runId: source.runId } : {}),
    ...(source.autoSpawned ? { autoSpawned: true } : {}),
  }
}

function reportBlock(report: DelegationReport): string {
  const attrs = [
    `thread="${report.threadId}"`,
    `title="${report.title.replace(/"/g, "'")}"`,
    ...(report.branch ? [`branch="${report.branch}"`] : []),
    `outcome="${report.failed ? 'failed' : 'finished'}"`,
  ].join(' ')
  return `<report ${attrs}>\n${report.reply}\n</report>`
}

/**
 * Assemble reports into the block the parent's agent receives. Framed as a
 * system block, not user text, so the agent does not answer the worker's words
 * as if the user had typed them.
 *
 * `delivery` changes only the framing sentence, and it has to: a report handed
 * to a running turn is arriving live, while a buffered one is catching the agent
 * up on something that happened while it was idle. Telling a mid-turn agent it
 * was idle invites it to narrate a gap that never happened.
 */
export function buildReportsBlock(
  reports: DelegationReport[],
  delivery: 'live' | 'buffered' | 'woke' = 'buffered',
  /** Cohort progress, when every report in the batch belongs to one run. Tells
   *  the agent whether this is the whole group or a first instalment, which is
   *  the difference between "report the result" and "keep waiting". */
  cohort?: { finished: number; total: number },
): string {
  if (reports.length === 0) return ''
  const noun = reports.length === 1 ? 'thread' : 'threads'
  const lede = delivery === 'live'
    ? `${reports.length} delegated ${noun} you spawned just finished. Their replies are below`
    : delivery === 'woke'
      ? `${reports.length} delegated ${noun} you spawned just finished, and this turn was started\nautomatically to handle the result. The user is NOT here and did not ask anything —\nrespond to the report itself, keep it brief, and do not ask them questions. Their\nreplies are below`
      : `${reports.length} delegated ${noun} you spawned finished while this chat was idle. Their\nreplies are below`

  const outstanding = cohort ? cohort.total - cohort.finished : 0
  const cohortNote = cohort && cohort.total > 1
    ? outstanding > 0
      ? `\n\n${cohort.finished} of ${cohort.total} threads from this batch have reported; ${outstanding} still running.\nDo not summarize the batch as done yet — the rest will report on their own.`
      : `\n\nAll ${cohort.total} threads from this batch have now reported.`
    : ''

  return `<system>
${lede} — you do not need to poll for them. Take them into account when
answering, and say what changed. A thread stays open and continuable after
reporting; nothing was archived.${cohortNote}

${reports.map(reportBlock).join('\n\n')}
</system>

`
}

export type ReportDelivery = 'live' | 'buffered' | 'woke' | 'wake-budget-spent'

/** One line for the parent's visible transcript, so the user sees reports land
 *  even when the agent is idle and nothing else happens. Takes the whole batch:
 *  a coalesced fan-out is one event and should read as one row. */
export function reportNoticeText(reports: DelegationReport[], delivery: ReportDelivery): string {
  const tail = delivery === 'live' ? 'delivered into the running turn'
    : delivery === 'woke' ? 'woke this chat to handle it'
    // Same wording as crew's round-budget pause, because it is the same brake.
    : delivery === 'wake-budget-spent'
      ? `auto-wake paused after ${MAX_AUTONOMOUS_WAKES} autonomous rounds — send a message to continue`
      : 'held for your next message'

  if (reports.length === 1) {
    const [report] = reports
    return `delegated thread "${report.title}" ${report.failed ? 'failed' : 'finished'} · ${tail}`
  }
  const failed = reports.filter(r => r.failed).length
  const outcome = failed === 0 ? 'finished'
    : failed === reports.length ? 'failed'
    : `finished (${failed} failed)`
  return `${reports.length} delegated threads ${outcome} · ${tail}`
}

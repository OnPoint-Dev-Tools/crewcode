// Projects CrewCode's session + message state into the bounded summaries the
// delegation API hands back to a delegating agent.
//
// Pure and separate from `useDelegatedThreads` so the bounding rules — which are
// the difference between a poll costing 200 tokens and one costing 20,000 — are
// testable without React or IPC.

import type { DelegatedThreadDetail, DelegatedThreadSummary } from '../../../shared/delegation-types'
import type { Message, Session } from '../types'

/** Tail of an agent reply carried on every `GET /v1/threads` row. Long enough to
 *  tell whether the worker succeeded, short enough that polling four threads
 *  stays cheap. */
export const SUMMARY_REPLY_CHARS = 400
/** Messages returned by `GET /v1/threads/:id`. The full transcript is always
 *  available in the UI; the agent gets a window. */
export const DETAIL_MESSAGE_LIMIT = 20
export const DETAIL_MESSAGE_CHARS = 2_000

/** Only the delegating session's own children, and only real delegated ones. */
export function childrenOf(parentSessionId: string, sessions: Session[]): Session[] {
  return sessions.filter(s => s.origin === 'delegated' && s.delegatedBy === parentSessionId)
}

function textOf(message: Message): string {
  if (message.kind === 'agent') {
    // Prefer assembled blocks; fall back to the raw streaming buffer.
    const fromBlocks = message.blocks?.filter(b => b[0] === 't').map(b => b[1]).join('')
    return (fromBlocks || message.text || '').trim()
  }
  if (message.kind === 'user' || message.kind === 'system') return message.text.trim()
  return ''
}

/** Roles the agent sees. Thinking, tool calls, work logs, and meters are dropped:
 *  a delegating agent needs the conversation, not the other agent's telemetry. */
function roleOf(message: Message): 'user' | 'agent' | 'system' | null {
  if (message.kind === 'user')   return 'user'
  if (message.kind === 'agent')  return 'agent'
  if (message.kind === 'system') return 'system'
  return null
}

function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`
}

export function summarizeThread(
  session: Session,
  messages: Message[],
  running: boolean,
  completedAt?: number,
): DelegatedThreadSummary {
  const visible = messages.filter(m => roleOf(m) !== null)
  const lastAgentReply = [...visible].reverse().find(m => m.kind === 'agent')
  const replyText = lastAgentReply ? textOf(lastAgentReply) : ''

  return {
    id: session.id,
    title: session.label,
    running,
    mode: session.mode,
    isolation: session.delegatedWorktreePath ? 'worktree' : 'shared',
    ...(session.delegatedWorktreePath ? { worktreePath: session.delegatedWorktreePath } : {}),
    ...(session.delegatedBranch ? { branch: session.delegatedBranch } : {}),
    ...(replyText ? { lastReply: clamp(replyText, SUMMARY_REPLY_CHARS) } : {}),
    ...(completedAt != null ? { completedAt } : {}),
    // "Closed" to the delegating agent means done — it frees a concurrency slot.
    // The chat itself stays open in the UI until the *user* archives it, so a
    // user-archived thread reads as closed too.
    closed: !!session.archived || session.delegationClosedAt != null,
  }
}

export function detailThread(
  session: Session,
  messages: Message[],
  running: boolean,
  completedAt?: number,
): DelegatedThreadDetail {
  const projected = messages
    .map(m => {
      const role = roleOf(m)
      if (!role) return null
      const text = textOf(m)
      if (!text) return null
      return { role, text: clamp(text, DETAIL_MESSAGE_CHARS) }
    })
    .filter((m): m is { role: 'user' | 'agent' | 'system'; text: string } => m !== null)

  return {
    ...summarizeThread(session, messages, running, completedAt),
    // Oldest-first within the window, but it is the *most recent* window — a
    // long-running thread's early messages are the least useful to the caller.
    messages: projected.slice(-DETAIL_MESSAGE_LIMIT),
  }
}

/**
 * Supervisor protocol — the pure text contract between the Supervisor agent and
 * the crew it moderates. No React, no IPC.
 *
 * The Supervisor is a real bridge agent that cannot edit files; it coordinates a
 * group chat. External CLI agents can't take injected tool schemas, so the
 * "delegate tool" is a structured-output convention: the Supervisor emits fenced
 *   ```crew-delegate
 *   { "to": "<laneId|agentId|role|all>", "message": "..." }
 *   ```
 * blocks. We parse completed Supervisor turns for these, route each message to
 * the addressed worker(s), then feed worker replies + a live status snapshot
 * back so the Supervisor can moderate, follow up, or report to the user.
 *
 * This module owns three pure pieces: the system preamble, the directive parser,
 * and the feedback/status formatters.
 */

import type { CrewSession, CrewAgentLane } from './crew-session'
import type { AgentInfo } from '../types'

/** The fenced block tag the Supervisor uses to address a worker. */
export const DELEGATE_FENCE = 'crew-delegate'

/** A single parsed instruction from a Supervisor turn. `to` is unresolved. */
export interface CrewDirective {
  /** Raw target token — a laneId, agentId, role, or "all". Resolved downstream. */
  to:      string
  message: string
}

export interface DirectivePolicyViolation {
  index: number
  directive: CrewDirective
  reason: string
}

/** Whether a lane's transport lets its reply flow back into the chat. */
export function laneCanReply(lane: CrewAgentLane, agents: AgentInfo[]): boolean {
  return agents.find(a => a.id === lane.agentId)?.transport === 'bridge'
}

function laneRosterLine(lane: CrewAgentLane, agents: AgentInfo[]): string {
  const transport = laneCanReply(lane, agents)
    ? 'bridge: can reply to you'
    : 'terminal: receives your messages but cannot reply here'
  const note = lane.instructions.trim() ? ` — ${lane.instructions.trim().replace(/\s+/g, ' ').slice(0, 200)}` : ''
  const label = lane.roleName.trim() || 'no role'
  return `- ${lane.laneId} — agent "${lane.agentId}", role ${label} [${transport}]${note}`
}

/**
 * The live task-distribution rule. Sent every turn (in the run-selection
 * snapshot) so toggling the header switch mid-run takes effect immediately.
 */
export function distributionDirective(session: CrewSession): string {
  const mode = session.distribution ?? 'split'
  if (mode === 'broadcast') {
    return [
      `[task distribution: BROADCAST]`,
      `When the user's request applies to the whole crew you MAY give every worker the same task — use "to": "all", or one block per worker carrying the same message.`,
    ].join('\n')
  }
  return [
    `[task distribution: SPLIT]`,
    `For coding work, you MUST assign every enabled worker exactly one DISTINCT slice in the SAME supervisor turn before waiting for replies. Never send the same or near-duplicate instructions to more than one worker, and do NOT use "to": "all" to hand everyone one shared task. Break the request into different per-worker pieces; if it seems hard to divide, create investigation/review/test/documentation slices so every enabled worker still receives work.`,
  ].join('\n')
}

/** Lightweight roster sent on every Supervisor prompt so live toggles are obeyed. */
export function buildRunSelectionSnapshot(session: CrewSession, agents: AgentInfo[]): string {
  const enabled = session.lanes.filter(l => !l.muted).map(l => laneRosterLine(l, agents)).join('\n')
  return [
    `[run selection]`,
    `Only the workers listed below may receive tasks in this run. If a worker is not listed, it is unavailable; do not mention or delegate to unlisted workers.`,
    `available workers:`,
    enabled || '- (none)',
    ``,
    distributionDirective(session),
  ].join('\n')
}

/**
 * The priming preamble sent to a worker when its bridge first spawns — injects
 * the lane's custom role (name / role descriptor / standing instructions)
 * verbatim so the agent operates accordingly. Returns '' when the lane has no
 * role adopted (all three fields empty), so we don't waste a turn priming a
 * generic worker.
 */
export function buildWorkerPreamble(lane: CrewAgentLane, basePath: string): string {
  const name = lane.roleName.trim()
  const role = lane.role.trim()
  const instr = lane.instructions.trim()
  if (!name && !role && !instr) return ''
  const lines = [
    `You are a crew worker collaborating with other agents under a supervisor, working in ${basePath}.`,
    '',
    'Your role:',
  ]
  if (name)  lines.push(`name: ${name}`)
  if (role)  lines.push(`role: ${role}`)
  if (instr) lines.push(`instructions: ${instr}`)
  lines.push('', 'Apply the above to every task the supervisor sends you in this session.')
  return lines.join('\n')
}

/**
 * The orchestrator instructions, sent once as the Supervisor bridge's first
 * prompt. Describes the crew it can address and the delegate-block convention.
 */
export function buildSupervisorPreamble(session: CrewSession, agents: AgentInfo[]): string {
  const enabledLanes = session.lanes.filter(l => !l.muted)
  const roster = enabledLanes.map(l => laneRosterLine(l, agents)).join('\n')
  return [
    `You are the Supervisor (Orchestator) of a crew of AI coding agents working in ${session.basePath} on branch ${session.baseBranch}.`,
    `You cannot edit files yourself. Your job is to break the user's request into tasks, assign each to the right available worker, relay information between workers and the user, and report status whenever the user asks.`,
    ``,
    `Run selection: the roster below is the complete worker set for this run that u control. If a worker is not listed, it is unavailable; do not mention it, delegate to it, or take over its task yourself.`,
    ``,
    ``,
    `Always delegate task to workers that are avaialable to you, dont say you have 'delegated a task to a worker' and didnt actually do it, always use 'DELEGATE_FENCE' to message them no matter what`,
    ``,
    `Available workers you have at your disposal:`,
    roster || '- (no workers available for this run)',
    ``,
    `To message an available worker you MUST emit a fenced block — one per worker. Naming a`,
    `worker in prose does NOTHING; only a fenced block actually reaches them:`,
    '```' + DELEGATE_FENCE,
    `{ "to": "<laneId | agentId | role | all>", "message": "what you want them to do or answer" }`,
    '```',
    `Worked example — to ask an available worker (by laneId, agentId, or role name) to check`,
    `the auth module, you would emit:`,
    '```' + DELEGATE_FENCE,
    `{ "to": "${enabledLanes[0]?.laneId ?? 'lane-1'}", "message": "Review src/auth for security issues and report what you find." }`,
    '```',
    `For implementation/debugging/review work in split mode, you MUST emit one fenced block for every enabled worker in this same turn before waiting for any worker reply. Use "to": "all" only when the user explicitly asks every available worker to participate or broadcast mode allows it; otherwise give each enabled worker a distinct slice. If the task seems indivisible, create complementary slices such as implementation, investigation, tests, review, docs, or risk analysis so nobody is skipped. You may emit several blocks in one turn.`,
    `After workers reply, you'll receive their responses and a [crew status] snapshot, then you can follow up or summarize for the user.`,
    `If the user only wants a status update, answer from the snapshot — don't reassign work unnecessarily.`,
    `Always speak to the user in plain prose outside the fenced blocks.`,
  ].join('\n')
}

/**
 * Parse every `crew-delegate` fenced block out of a completed Supervisor turn.
 * Malformed JSON or blocks missing `to`/`message` are skipped silently — a bad
 * block must never crash the moderation loop.
 */
export function parseDirectives(text: string): CrewDirective[] {
  if (!text) return []
  // Accept normal markdown fence variants that LLMs commonly emit:
  // ```crew-delegate, ``` crew-delegate, indented fences, CRLF, and 3+ backticks.
  const fence = new RegExp(
    '^\\s*`{3,}\\s*' + DELEGATE_FENCE + '\\b[^\\r\\n]*\\r?\\n([\\s\\S]*?)^\\s*`{3,}\\s*$',
    'gmi',
  )
  const out: CrewDirective[] = []
  let m: RegExpExecArray | null
  while ((m = fence.exec(text)) !== null) {
    const body = m[1].trim()
    try {
      const parsed = JSON.parse(body) as unknown
      if (!parsed || typeof parsed !== 'object') continue
      const rec = parsed as Record<string, unknown>
      const to = typeof rec.to === 'string' ? rec.to.trim()
        : rec.broadcast === true ? 'all' : ''
      const message = typeof rec.message === 'string' ? rec.message
        : typeof rec.task === 'string' ? rec.task : ''
      if (!to || !message.trim()) continue
      out.push({ to, message })
    } catch {
      // Skip unparseable blocks — the Supervisor will see no reply and can retry.
    }
  }
  return out
}

/**
 * Unambiguous hand-off verbs — these mean "give work to a worker" no matter the
 * surrounding words, so they fire on their own (even against a generic "worker"
 * mention). Deliberately narrow: dual-use verbs like "have"/"ask"/"get" live in
 * the softer commitment tier below, because on their own they dominate ordinary
 * chat ("do we have other agents?").
 */
const STRONG_DELEGATION =
  /\b(?:delegat(?:e|es|ing|ed)|reassign\w*|assign(?:s|ing|ed)?|dispatch(?:es|ing|ed)?|hand(?:s|ing)?[-\s]?off|handoff|loop(?:s|ing)?[-\s]?in|farm(?:s|ing)?[-\s]?out|kick(?:s|ing)?[-\s]?off)\b/

/**
 * Soft commitment markers — "I'll / let me / going to …". On their own they mean
 * nothing (the supervisor recaps with them constantly), so they only count when
 * a SPECIFIC worker is named AND the turn isn't a recap (see RECAP). This is the
 * tier that recovers natural phrasings like "I'll get pi on it" or "let me have
 * pi implement it" that carry no explicit hand-off verb.
 */
const COMMIT_MARKER =
  /\b(?:i'?ll|i will|i'?m going to|i am going to|going to|gonna|let me|let'?s)\b/

/** Generic crew words — count only alongside a STRONG_DELEGATION verb. */
const GENERIC_CREW = /\b(?:workers?|agents?|teammates?|the crew)\b/

/**
 * Recap / description phrasing. When the supervisor is summarizing what a worker
 * already did — not assigning new work — these appear. We use them to veto the
 * soft (commitment) tier so normal status recaps never trigger a nudge. A real
 * STRONG_DELEGATION verb overrides this veto.
 */
const RECAP =
  /\b(?:summar(?:y|ise|ize|ising|izing|ised|ized)|recap|walk(?:ing)?\s+(?:you\s+)?through|here'?s\s+(?:what|how)|explain(?:ing|ed)?|describe|report(?:ing|ed)?\s+back|already|so\s+far|what\s+(?:\w+\s+)?(?:did|built|found|made|wrote|said|implemented|reported|shipped|fixed))\b/

/**
 * Build a word-boundary matcher for the *specifically named* enabled workers —
 * laneId, agentId, or role. Generic words ("worker"/"agent") are intentionally
 * NOT included: talking about the crew in the abstract is normal conversation.
 * Role names of 1–2 chars are skipped because they collide with common words;
 * word boundaries also stop short ids like "pi" from matching inside "api".
 * Returns null when no enabled worker can be named.
 */
function buildWorkerRefPattern(lanes: CrewAgentLane[]): RegExp | null {
  const tokens = new Set<string>()
  for (const l of lanes) {
    if (l.muted) continue
    tokens.add(l.laneId.toLowerCase())
    tokens.add(l.agentId.toLowerCase())
    const role = l.roleName.trim().toLowerCase()
    if (role.length > 2) tokens.add(role)
  }
  const parts = [...tokens]
    .filter(Boolean)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (parts.length === 0) return null
  return new RegExp('\\b(?:' + parts.join('|') + ')\\b')
}

/**
 * Heuristic: did the Supervisor mean to hand work to a worker without emitting a
 * block? Two tiers:
 *   • STRONG_DELEGATION verb → fires against a named worker OR a generic "worker"
 *     mention (e.g. "I'll assign this to a worker" — real intent, just unnamed).
 *   • COMMIT_MARKER + a specifically named worker, unless the turn reads like a
 *     recap → recovers soft phrasings ("I'll get pi on it") while staying quiet
 *     on status summaries ("let me summarize what pi built").
 *
 * The caller consults this only when zero directives parsed and re-prompts the
 * supervisor SILENTLY (the correction turn is stripped from view), so a rare
 * false positive costs one hidden turn, not a user-visible lecture. It's gated
 * to fire at most once per user turn upstream.
 */
export function detectMissedDelegation(text: string, lanes: CrewAgentLane[]): boolean {
  if (!text) return false
  const lc = text.toLowerCase()

  const strong = STRONG_DELEGATION.test(lc)
  const commit = COMMIT_MARKER.test(lc)
  if (!strong && !commit) return false

  const refs = buildWorkerRefPattern(lanes)
  const named = refs ? refs.test(lc) : false

  // Must actually target a worker: a specific one, or a generic mention backed
  // by a strong hand-off verb. A bare commitment with no named worker is chat.
  if (!named && !(strong && GENERIC_CREW.test(lc))) return false

  // Recap phrasing vetoes the soft tier; a strong verb still wins.
  if (!strong && RECAP.test(lc)) return false

  return true
}

/**
 * Resolve a directive's `to` token to concrete enabled lanes. Matches, in order:
 * "all"/"*" → every enabled lane; exact laneId; exact agentId; role. Returns []
 * when nothing enabled matches so the caller can tell the Supervisor the target
 * was unavailable for this run.
 */
export function resolveTargets(to: string, lanes: CrewAgentLane[]): CrewAgentLane[] {
  const token = to.trim().toLowerCase()
  const enabled = lanes.filter(l => !l.muted)
  if (token === 'all' || token === '*' || token === 'everyone') return enabled
  const byLane = enabled.filter(l => l.laneId.toLowerCase() === token)
  if (byLane.length) return byLane
  const byAgent = enabled.filter(l => l.agentId.toLowerCase() === token)
  if (byAgent.length) return byAgent
  const byRole = enabled.filter(l => l.roleName.trim().toLowerCase() === token)
  return byRole
}

function normalizedTaskText(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/g, ' ')
}

function isAllTarget(to: string): boolean {
  const token = to.trim().toLowerCase()
  return token === 'all' || token === '*' || token === 'everyone'
}

/**
 * Runtime policy checks for directives. Prompt rules are advisory; these are the
 * hard gates that stop unsafe or wasteful fan-out before any worker is messaged.
 */
export function validateDirectivePolicy(session: CrewSession, directives: CrewDirective[]): DirectivePolicyViolation[] {
  const violations: DirectivePolicyViolation[] = []
  const split = (session.distribution ?? 'split') === 'split'
  const seenMessages = new Map<string, number[]>()
  const coveredLaneIds = new Set<string>()

  directives.forEach((directive, index) => {
    const targets = resolveTargets(directive.to, session.lanes)
    if (targets.length === 0) {
      violations.push({ index, directive, reason: `no enabled worker matches "${directive.to}" — check the model run toggles in Crew Surface.` })
      return
    }
    if (split && isAllTarget(directive.to)) {
      violations.push({ index, directive, reason: `split distribution forbids "to":"${directive.to}" — assign one distinct slice to one worker.` })
      return
    }
    if (split && targets.length > 1) {
      violations.push({ index, directive, reason: `split distribution target "${directive.to}" resolves to ${targets.length} workers — choose exactly one worker for this task.` })
      return
    }
    if (split) {
      for (const target of targets) coveredLaneIds.add(target.laneId)
      const normalized = normalizedTaskText(directive.message)
      if (normalized) seenMessages.set(normalized, [...(seenMessages.get(normalized) ?? []), index])
    }
  })

  if (split) {
    const missing = session.lanes.filter(lane => !lane.muted && !coveredLaneIds.has(lane.laneId))
    if (missing.length > 0) {
      violations.push({
        index: -1,
        directive: { to: '', message: '' },
        reason: `split distribution requires one distinct task for every enabled worker; missing ${missing.map(l => `${l.laneId} (${l.agentId})`).join(', ')}.`,
      })
    }

    const duplicateIndexes = new Set<number>()
    for (const indexes of seenMessages.values()) {
      if (indexes.length < 2) continue
      for (const index of indexes) duplicateIndexes.add(index)
    }
    for (const index of duplicateIndexes) {
      const directive = directives[index]
      violations.push({ index, directive, reason: `split distribution forbids duplicate worker instructions — give each worker a distinct slice.` })
    }
  }

  return violations
}

/** A live, one-line-per-lane status snapshot the Supervisor reads to report up. */
export function buildStatusSnapshot(session: CrewSession, lastByLane: Record<string, string>): string {
  const lines = session.lanes.map(l => {
    const tail = lastByLane[l.laneId]?.trim()
    const preview = tail ? tail.replace(/\s+/g, ' ').slice(0, 500) : ''
    const tailStr = preview ? ` — latest reply preview: "${preview}${tail && tail.length > preview.length ? '…' : ''}"` : ''
    const nextAction = l.nextAction?.trim().replace(/\s+/g, ' ').slice(0, 500)
    const checkpoint = nextAction ? ` — next action: ${JSON.stringify(nextAction)}` : ''
    const status = l.muted ? 'paused' : l.status
    return `- ${l.laneId} (${l.agentId}, ${l.roleName.trim() || 'no role'}): ${status}${checkpoint}${tailStr}`
  })
  return `[crew status]\n${lines.join('\n')}`
}

/**
 * The prompt sent back to the Supervisor once the workers it addressed have all
 * replied — their answers plus the fresh status snapshot, so it can synthesize.
 */
export function buildReplyFeedback(
  replies: Array<{ laneId: string; agentId: string; text: string }>,
  snapshot: string,
): string {
  const body = replies
    .map(r => `${r.laneId} (${r.agentId}):\n${r.text.trim() || '(no textual reply)'}`)
    .join('\n\n')
  return [
    `[replies from workers]`,
    body,
    ``,
    snapshot,
    ``,
    `Respond to the user, or issue follow-up ${DELEGATE_FENCE} blocks if more work is needed.`,
  ].join('\n')
}

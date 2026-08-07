/**
 * useCrewSupervisor — drives the optional Supervisor layer: a bridge agent that
 * moderates the crew as a group chat.
 *
 * Flow per user message:
 *   1. user → Supervisor (posted into the supervisor thread, prompt sent).
 *   2. Supervisor turn ends → parse `crew-delegate` blocks → message the
 *      addressed worker lanes via `sendToLane`.
 *   3. Each bridge worker's turn ends → its reply is relayed into the supervisor
 *      thread as a labeled incoming bubble and accumulated.
 *   4. Once every awaited worker has replied → feed the replies + a live status
 *      snapshot back to the Supervisor so it can synthesize, follow up, or report
 *      to the user. Capped at MAX_SUPERVISOR_ROUNDS to prevent runaway loops.
 *
 * Worker replies can only be captured from bridge-transport lanes; terminal
 * (pty) workers receive the message but their output stays in their pane, which
 * we tell the Supervisor.
 *
 * The protocol (preamble, parsing, formatting) is pure — see
 * orchestrator/crew-supervisor-protocol.ts.
 */

import { useCallback, useEffect, useRef } from 'react'

import {
  buildSupervisorPreamble,
  buildRunSelectionSnapshot,
  parseDirectives,
  resolveTargets,
  buildStatusSnapshot,
  buildReplyFeedback,
  detectMissedDelegation,
  laneCanReply,
  validateDirectivePolicy,
} from '../orchestrator/crew-supervisor-protocol'
import { nextToolsInFlight, shouldAbandonRound } from '../orchestrator/crew-idle-watchdog'
import { useMessagesStore } from '../stores/chat-messages-store'
import type { CrewSession } from '../orchestrator/crew-session'
import type { AgentInfo, AgentProviderId, BridgeEvent, Message } from '../types'
import type { EffortLevel } from '../components/composer/EffortPicker'

/** How many delegate→reply→synthesize cycles auto-run before pausing for input. */
export const MAX_SUPERVISOR_ROUNDS = 4

interface BridgesLike {
  ensureBridge: (
    tabId: string, agentId: string, kind: AgentProviderId,
    cwd: string, model: string | undefined, effort: EffortLevel,
    mode?: 'ask' | 'plan' | 'build' | 'full',
    toolPolicy?: 'default' | 'read-only',
  ) => Promise<{ bridgeId: string } | { error: string }>
  prompt: (bridgeId: string, text: string, options?: { streamingBehavior?: 'followUp' }) => Promise<{ ok: boolean; error?: string }>
  abort: (bridgeId: string) => void
  dropBridge: (tabId: string, agentId: string) => void
  subscribeTurnEnd: (cb: (bridgeId: string, tabId: string) => void) => () => void
  subscribeActivity: (cb: (bridgeId: string, tabId: string, type: BridgeEvent['type']) => void) => () => void
}

interface CrewLike {
  bindSupervisor: (
    tabId: string,
    binding: { tabId?: string | null; bridgeId?: string | null; status?: CrewSession['supervisor']['status'] },
  ) => void
}

export interface UseCrewSupervisorOpts {
  activeTabId:  string
  crewSession:  CrewSession | null
  agents:       AgentInfo[]
  effort:       EffortLevel
  bridges:      BridgesLike
  crew:         CrewLike
  /** Resolves true only if a live runtime actually started for the lane. */
  sendToLane:   (laneId: string, text: string) => Promise<boolean>
  /** Starts all target runtimes before submitting prompts, so workers launch together. */
  sendToLanes?: (tasks: Array<{ laneId: string; text: string }>) => Promise<Array<{ laneId: string; started: boolean }>>
  setMessagesForTab: (tabId: string, updater: (prev: Message[]) => Message[]) => void
}

/**
 * Idle watchdog for a delegation round. A worker is only abandoned after this
 * long with NO bridge activity at all (no text/thinking/tool events) — not after
 * a fixed total time. A worker grinding on a big task keeps emitting events,
 * which resets the clock, so it's never mistaken for a hang. The one silent gap
 * within a turn is a long-running tool call (tool_start with no tool_end yet),
 * so the watchdog is fully suppressed while any tool is in flight — a worker
 * inside a 10-minute build is provably not wedged. Known start failures are
 * already excluded from `waiting` via sendToLane's boolean; combined with the
 * tool gate, this only fires on a turn that goes truly dark mid-flight.
 */
const IDLE_TIMEOUT_MS = 3 * 60_000
/** How often the watchdog checks elapsed silence. Coarse — this isn't precise. */
const IDLE_CHECK_MS = 15_000

function nowTime(): string {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * Full text of the LAST agent turn in a tab — concatenates every agent bubble
 * sharing that turn's id. Bridge streaming splits a single turn into multiple
 * agent bubbles (one per text segment between tool/thinking blocks), so the
 * "last agent text" of a turn like `text → tool → text` was previously just the
 * trailing segment, and every consumer of this function was reading a truncated
 * reply: supervisor→worker directive parsing missed the prose before the tool,
 * and worker→supervisor reports dropped the segment before any tool the worker
 * called. Reading all agent bubbles of the same turnId returns the complete
 * textual reply.
 */
function lastAgentText(msgs: Message[] | undefined): string {
  if (!msgs || msgs.length === 0) return ''
  let lastTurnId: string | undefined
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.kind === 'agent' && m.turnId) { lastTurnId = m.turnId; break }
  }
  if (!lastTurnId) {
    // History bubbles with no turnId (rare) — fall back to the last agent text.
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.kind === 'agent') return m.text ?? ''
    }
    return ''
  }
  let out = ''
  for (const m of msgs) {
    if (m.kind === 'agent' && m.turnId === lastTurnId) out += m.text ?? ''
  }
  return out
}

/**
 * Worker reports should be the final answer to the latest delegated task, not
 * internal reasoning/tool telemetry. Thinking/tool rows stay in the worker lane;
 * leaking them into the supervisor thread confuses the supervisor into treating
 * tool progress as a completed answer.
 */
function laneReportText(msgs: Message[] | undefined): string {
  if (!msgs || msgs.length === 0) return ''
  let start = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].kind === 'user') { start = i; break }
  }
  const slice = msgs.slice(Math.max(0, start + 1))
  const parts: string[] = []
  for (const msg of slice) {
    if (msg.kind === 'agent' && msg.text?.trim()) parts.push(msg.text.trim())
    else if (msg.kind === 'system' && msg.tone === 'error' && msg.text?.trim()) parts.push(`[worker error] ${msg.text.trim()}`)
  }
  return parts.join('\n\n').trim()
}

function hasStreamingLaneOutput(msgs: Message[] | undefined): boolean {
  if (!msgs) return false
  return msgs.some(msg =>
    (msg.kind === 'agent' && msg.streaming) ||
    (msg.kind === 'thinking' && msg.streaming) ||
    (msg.kind === 'toolcall' && (msg.status === 'pending' || msg.status === 'running')),
  )
}

interface Coord {
  sessionId: string
  bridgeId:  string | null
  primed:    boolean
  waiting:   Set<string>   // laneTabIds awaited this round
  replies:   Array<{ laneId: string; agentId: string; text: string }>
  round:     number
  timer:     ReturnType<typeof setInterval> | null  // idle watchdog interval
  lastActivityAt: number   // ms of the last bridge event from a waited worker
  toolsInFlight: number    // open tool calls across waited workers this round
  nudged:    boolean       // one missed-delegation nudge per user turn
  correcting: boolean      // next supervisor turn is a silent correction — hide it
  busy:      boolean       // a supervisor turn is in flight — buffer replies until it ends
  stopped:   boolean       // user aborted — ignore in-flight turn_ends until next send
}

function freshCoord(sessionId: string): Coord {
  return { sessionId, bridgeId: null, primed: false, waiting: new Set(), replies: [], round: 0, timer: null, lastActivityAt: 0, toolsInFlight: 0, nudged: false, correcting: false, busy: false, stopped: false }
}

/**
 * Sent silently when the supervisor named a worker but forgot the block. Phrased
 * to bias the response toward either block-only output (real delegation) or
 * nothing (false positive), since the whole correction turn is stripped from
 * view either way.
 */
const SILENT_CORRECTION_PROMPT =
  'SYSTEM: Your previous message referred to a worker but included no ```crew-delegate``` block, ' +
  'so nothing was actually sent. If you intended to delegate, respond with ONLY the crew-delegate ' +
  'block(s) — no prose, do not address the user. If you were only talking to the user and did not ' +
  'intend to delegate, respond with nothing at all.'

const directivePolicyCorrectionPrompt = (reasons: string[]): string =>
  'SYSTEM: Your previous crew-delegate block(s) violated CrewCode split-mode policy, so NO workers were tasked. ' +
  'Respond with ONLY corrected ```crew-delegate``` block(s), no prose. You must include exactly one distinct task for every enabled worker. ' +
  `Policy errors:\n- ${reasons.join('\n- ')}`

export function useCrewSupervisor(opts: UseCrewSupervisorOpts) {
  const {
    activeTabId, crewSession, agents, effort,
    bridges, crew, sendToLane, sendToLanes, setMessagesForTab,
  } = opts

  // Everything the turn-end handlers need is read through refs so the
  // subscription can be installed once and never churns on each render.
  const sessionRef = useRef(crewSession);          sessionRef.current = crewSession
  const agentsRef = useRef(agents);                agentsRef.current = agents
  const effortRef = useRef(effort);                effortRef.current = effort
  const activeTabRef = useRef(activeTabId);        activeTabRef.current = activeTabId
  const sendToLaneRef = useRef(sendToLane);        sendToLaneRef.current = sendToLane
  const fallbackSendToLanes = useCallback(async (tasks: Array<{ laneId: string; text: string }>) => {
    const results = await Promise.all(tasks.map(async task => ({
      laneId:  task.laneId,
      started: await sendToLaneRef.current(task.laneId, task.text),
    })))
    return results
  }, [])
  const sendToLanesRef = useRef(sendToLanes ?? fallbackSendToLanes)
  sendToLanesRef.current = sendToLanes ?? fallbackSendToLanes
  // Message snapshots are read on demand via useMessagesStore.getState() inside
  // the turn-end handlers — no subscription here, so streamed tokens don't
  // re-render App through this hook.

  const coordRef = useRef<Coord>(freshCoord(crewSession?.id ?? ''))
  const laneStableRef = useRef<Record<string, { text: string; since: number }>>({})

  const supervisorTabId = useCallback((s: CrewSession): string =>
    s.supervisor.tabId ?? `crew/${s.id}/supervisor`, [])

  const postToSupervisor = useCallback((s: CrewSession, msg: Message) => {
    setMessagesForTab(supervisorTabId(s), m => [...m, msg])
  }, [setMessagesForTab, supervisorTabId])

  // Send a prompt to the supervisor bridge, spinning it up on first use and
  // prepending the orchestrator preamble once.
  const promptSupervisor = useCallback(async (promptText: string) => {
    const s = sessionRef.current
    if (!s || !s.supervisor.enabled) return
    const supe = s.supervisor
    const agent = agentsRef.current.find(a => a.id === supe.agentId)
    const supTab = supervisorTabId(s)

    if (!agent || !agent.available || agent.transport !== 'bridge') {
      postToSupervisor(s, { kind: 'system', tone: 'error', time: nowTime(),
        text: `supervisor agent "${supe.agentId}" is unavailable or not a bridge agent` })
      crew.bindSupervisor(activeTabRef.current, { status: 'error' })
      return
    }

    // Claim the busy slot SYNCHRONOUSLY, before any await. With parallel worker
    // dispatch, two lane turn_ends can fire back-to-back (microtask apart):
    // each calls feedSupervisor, which checks `coord.busy` and — if it's still
    // false — issues a second promptSupervisor. If `busy` only gets set after
    // `await bridges.ensureBridge` resolves, the second call sneaks through and
    // two `bridges.prompt(supBridge, …)` land on the same supervisor bridge at
    // once. The bridge implementations can't handle concurrent prompts on one
    // subprocess — stdin gets interleaved, the provider corrupts, and the
    // renderer silently crashes when the IPC rejects with no `.catch`. Setting
    // `busy` before the first yield closes the race: the second feedSupervisor
    // sees busy=true, buffers its reply, and drains when this turn ends.
    coordRef.current.busy = true

    const r = await bridges.ensureBridge(
      supTab, agent.id, agent.id as AgentProviderId,
      s.basePath, supe.model || undefined, supe.effort ?? effortRef.current,
      'ask', 'read-only',
    )
    if ('error' in r) {
      coordRef.current.busy = false
      postToSupervisor(s, { kind: 'system', tone: 'error', time: nowTime(), text: r.error })
      crew.bindSupervisor(activeTabRef.current, { status: 'error' })
      return
    }

    coordRef.current.bridgeId = r.bridgeId
    crew.bindSupervisor(activeTabRef.current, { tabId: supTab, bridgeId: r.bridgeId, status: 'thinking' })

    const selection = buildRunSelectionSnapshot(s, agentsRef.current)
    let text = `${selection}\n\n${promptText}`
    if (!coordRef.current.primed) {
      text = buildSupervisorPreamble(s, agentsRef.current) + '\n\n' + text
      coordRef.current.primed = true
    }
    const res = await bridges.prompt(r.bridgeId, text)
    if (!res.ok) {
      coordRef.current.busy = false
      postToSupervisor(s, { kind: 'system', tone: 'error', time: nowTime(), text: res.error ?? 'supervisor prompt failed' })
      crew.bindSupervisor(activeTabRef.current, { status: 'error' })
    }
  }, [bridges, crew, postToSupervisor, supervisorTabId])

  const clearRoundTimer = useCallback(() => {
    if (coordRef.current.timer) {
      clearInterval(coordRef.current.timer)
      coordRef.current.timer = null
    }
  }, [])

  // Public: the user spoke to the supervisor. Resets the round counter and the
  // one-shot nudge — a new user turn starts a fresh delegate→reply budget.
  const sendToSupervisor = useCallback((userText: string) => {
    const s = sessionRef.current
    if (!s || !userText.trim()) return
    clearRoundTimer()
    coordRef.current.round = 0
    coordRef.current.nudged = false
    coordRef.current.correcting = false
    coordRef.current.busy = false
    coordRef.current.stopped = false
    postToSupervisor(s, { kind: 'user', text: userText, time: nowTime() })
    void promptSupervisor(userText)
  }, [postToSupervisor, promptSupervisor, clearRoundTimer])

  // Public: hard-stop the supervisor loop. Aborts its in-flight turn, drops the
  // watchdog and any awaited replies, and flags `stopped` so the abort's own
  // turn_end can't kick off a new round. The next sendToSupervisor clears it.
  const abortSupervisor = useCallback(() => {
    const coord = coordRef.current
    clearRoundTimer()
    coord.stopped = true
    coord.correcting = false
    coord.busy = false
    coord.waiting.clear()
    coord.replies = []
    coord.round = 0
    coord.toolsInFlight = 0
    laneStableRef.current = {}
    const s = sessionRef.current
    if (s) {
      const supTab = supervisorTabId(s)
      if (coord.bridgeId) bridges.dropBridge(supTab, s.supervisor.agentId)
      coord.bridgeId = null
      coord.primed = false
      setMessagesForTab(supTab, messages => messages.map(msg => {
        if (msg.kind === 'agent' && msg.streaming) return { ...msg, streaming: false }
        if (msg.kind === 'thinking' && msg.streaming) return { ...msg, streaming: false }
        if (msg.kind === 'toolcall' && (msg.status === 'pending' || msg.status === 'running')) {
          return { ...msg, status: 'error' as const, isError: true, result: 'stopped by user' }
        }
        return msg
      }))
      postToSupervisor(s, { kind: 'system', tone: 'info', time: nowTime(), text: 'orchestration stopped — send a message to resume.' })
      crew.bindSupervisor(activeTabRef.current, { bridgeId: null, status: 'idle' })
    } else if (coord.bridgeId) {
      bridges.abort(coord.bridgeId)
    }
  }, [bridges, crew, postToSupervisor, clearRoundTimer, setMessagesForTab, supervisorTabId])

  // Report collected worker replies back to the supervisor *as soon as it is
  // free*, rather than waiting for every dispatched worker — a fast worker's
  // result must not sit idle behind the slowest one (the whole point of split
  // mode). If the supervisor is mid-turn the replies stay buffered and drain
  // when its turn_end fires. `force` sends even with no replies — used by the
  // idle watchdog so the supervisor still hears that a worker was abandoned.
  const feedSupervisor = useCallback((force: boolean) => {
    const s = sessionRef.current
    if (!s) return
    const coord = coordRef.current
    if (coord.busy) return                       // will drain on the supervisor's turn_end
    if (!force && coord.replies.length === 0) return
    // Only stop watching once no workers remain outstanding.
    if (coord.waiting.size === 0) clearRoundTimer()
    const snapshot = buildStatusSnapshot(s, lastByLane(s, useMessagesStore.getState().messagesByTab))
    const feedback = buildReplyFeedback(coord.replies, snapshot)
    coord.replies = []
    void promptSupervisor(feedback)
  }, [promptSupervisor, clearRoundTimer])

  // Start the idle watchdog for the current round. It abandons a worker only
  // after IDLE_TIMEOUT_MS with zero bridge activity — `handleActivity` keeps
  // resetting the clock (and gates on in-flight tools) while a worker is
  // genuinely busy, so long tasks and slow tool runs survive.
  const armRoundTimer = useCallback(() => {
    clearRoundTimer()
    coordRef.current.lastActivityAt = Date.now()
    coordRef.current.timer = setInterval(() => {
      const s = sessionRef.current
      const coord = coordRef.current
      if (!s) return
      if (!shouldAbandonRound({
        waitingCount:   coord.waiting.size,
        toolsInFlight:  coord.toolsInFlight,
        lastActivityAt: coord.lastActivityAt,
        idleTimeoutMs:  IDLE_TIMEOUT_MS,
      }, Date.now())) return
      const stuck = [...coord.waiting]
      coord.waiting.clear()
      for (const tabId of stuck) {
        const lane = s.lanes.find(l => l.tabId === tabId)
        postToSupervisor(s, { kind: 'system', tone: 'info', time: nowTime(),
          text: `${lane?.laneId ?? 'a worker'} went silent for ${Math.round(IDLE_TIMEOUT_MS / 60000)}m — continuing without it.` })
      }
      // Force a report even with no buffered replies so the supervisor learns the
      // worker was abandoned instead of the round hanging forever.
      feedSupervisor(true)
    }, IDLE_CHECK_MS)
  }, [clearRoundTimer, feedSupervisor, postToSupervisor])

  // Heartbeat: any bridge event from a worker we're awaiting resets the idle
  // clock, and tool_start/tool_end maintain the in-flight tool count that fully
  // suppresses the watchdog while a tool runs. O(1) — even on rapid deltas.
  const handleActivity = useCallback((laneTabId: string, type: BridgeEvent['type']) => {
    const coord = coordRef.current
    if (!coord.waiting.has(laneTabId)) return
    coord.lastActivityAt = Date.now()
    coord.toolsInFlight = nextToolsInFlight(coord.toolsInFlight, type)
  }, [])

  // Remove a supervisor turn's visible output — used to hide the silent
  // correction turn (the response to a background missed-delegation nudge).
  // Matches the trailing agent message by text so earlier history is untouched.
  const stripSupervisorTurn = useCallback((supTab: string, text: string) => {
    setMessagesForTab(supTab, msgs => {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.kind === 'agent' && (m.text ?? '') === text) {
          return [...msgs.slice(0, i), ...msgs.slice(i + 1)]
        }
      }
      return msgs
    })
  }, [setMessagesForTab])

  // Supervisor finished a turn → route any delegate blocks to workers.
  const handleSupervisorTurnEnd = useCallback(async () => {
    const s = sessionRef.current
    if (!s) return
    // User hit stop: swallow the aborted turn's end (and any error/closed that
    // follows) so we don't parse partial output and fire off a fresh round.
    if (coordRef.current.stopped) return
    // The supervisor turn ended — it's free again. Any replies buffered while it
    // was busy can now be reported (a re-prompt below re-sets this).
    coordRef.current.busy = false
    const supTab = supervisorTabId(s)
    const turnText = lastAgentText(useMessagesStore.getState().messagesByTab[supTab])
    const directives = parseDirectives(turnText)

    // This turn is the supervisor answering our hidden missed-delegation nudge —
    // never user-facing. Strip it whether it produced a block (the dispatch is
    // still surfaced via the "→ tasked" line below) or nothing (false positive,
    // silent no-op).
    const wasCorrecting = coordRef.current.correcting
    if (wasCorrecting) {
      coordRef.current.correcting = false
      stripSupervisorTurn(supTab, turnText)
    }

    if (directives.length === 0) {
      // If workers are already in flight, status/check-in prose like "I'll ask
      // the workers" must NOT trigger the missed-delegation nudge. That nudge is
      // only for turns where no worker task was actually sent; while `waiting`
      // is non-empty, workers have been tasked and their replies should drive
      // the next supervisor prompt.
      if (coordRef.current.waiting.size > 0) {
        crew.bindSupervisor(activeTabRef.current, { status: 'delegating' })
        return
      }
      // It talked about delegating but emitted no block. Re-prompt SILENTLY,
      // once per user turn — and only off a user-driven turn, never chaining a
      // correction off another correction. The correction turn is hidden above.
      if (!wasCorrecting && !coordRef.current.nudged && detectMissedDelegation(turnText, s.lanes)) {
        coordRef.current.nudged = true
        coordRef.current.correcting = true
        crew.bindSupervisor(activeTabRef.current, { status: 'delegating' })
        void promptSupervisor(SILENT_CORRECTION_PROMPT)
        return
      }
      // A plain report/answer. If a worker finished while the supervisor was
      // mid-turn, its reply is buffered — drain it now so it isn't left waiting.
      if (coordRef.current.replies.length > 0) { feedSupervisor(false); return }
      crew.bindSupervisor(activeTabRef.current, { status: 'idle' })
      return
    }

    crew.bindSupervisor(activeTabRef.current, { status: 'delegating' })

    // A fresh delegation consumes one unit of the auto-advance budget; reporting
    // worker replies does not. Pause instead of looping forever.
    coordRef.current.round += 1
    if (coordRef.current.round > MAX_SUPERVISOR_ROUNDS) {
      postToSupervisor(s, { kind: 'system', tone: 'info', time: nowTime(),
        text: `auto-advance paused after ${MAX_SUPERVISOR_ROUNDS} rounds — send a message to continue.` })
      crew.bindSupervisor(activeTabRef.current, { status: 'idle' })
      return
    }
    // Only reset the tool-gate when starting fresh; a re-delegation issued while
    // other workers are still running must keep tracking them (add, don't reset).
    if (coordRef.current.waiting.size === 0) coordRef.current.toolsInFlight = 0

    const violations = validateDirectivePolicy(s, directives)
    if (violations.length > 0) {
      const reasons = [...new Set(violations.map(v => v.reason))]
      for (const reason of reasons) {
        postToSupervisor(s, { kind: 'system', tone: 'error', time: nowTime(), text: reason })
      }
      coordRef.current.correcting = true
      void promptSupervisor(directivePolicyCorrectionPrompt(reasons))
      return
    }

    const dispatched: string[] = []  // #3: worker labels tasked this round
    const tasks: Array<{ laneId: string; text: string; tabId?: string | null }> = []
    // Fire-and-track dispatch, NEVER awaited. `sendToLane` calls `bridges.prompt`,
    // whose IPC promise only resolves after the worker's full turn settles (see
    // useAgentBridge.prompt — the prompt IPC awaits the provider's turn promise).
    // Awaiting inside this loop would serialize workers — worker N+1's prompt
    // wouldn't dispatch until worker N's turn_end already fired, defeating the
    // whole point of running a crew in parallel. Track completion through the
    // existing `subscribeTurnEnd` subscription (`handleLaneReply`) instead; here
    // we kick off each lane's prompt in parallel and add the lane to `waiting`
    // optimistically, so the watchdog / reply relay treat every dispatched lane
    // as live from the moment of dispatch.
    for (const d of directives) {
      const targets = resolveTargets(d.to, s.lanes)
      for (const lane of targets) {
        const replyCapable = laneCanReply(lane, agentsRef.current) && !!lane.tabId
        if (lane.tabId && coordRef.current.waiting.has(lane.tabId)) {
          postToSupervisor(s, { kind: 'system', tone: 'info', time: nowTime(),
            text: `${lane.laneId} is already running a delegated task — duplicate dispatch ignored.` })
          continue
        }
        if (replyCapable && lane.tabId) {
          // Tracked as live from now; the `.then` below removes the lane if its
          // runtime never actually started (no turn_end would ever fire for it).
          coordRef.current.waiting.add(lane.tabId)
        } else {
          postToSupervisor(s, { kind: 'system', tone: 'info', time: nowTime(),
            text: `${lane.laneId} is a terminal worker — its reply won't appear here.` })
        }
        dispatched.push(`${lane.laneId} (${lane.agentId})`)
        tasks.push({ laneId: lane.laneId, text: d.message, tabId: lane.tabId })
      }
    }

    if (tasks.length > 0) {
      void sendToLanesRef.current(tasks).then(results => {
        for (const result of results) {
          if (result.started) continue
          const task = tasks.find(candidate => candidate.laneId === result.laneId)
          if (task?.tabId) coordRef.current.waiting.delete(task.tabId)
        }
      }).catch(() => {
        for (const task of tasks) if (task.tabId) coordRef.current.waiting.delete(task.tabId)
      })
    }

    // #3: make the multi-agent fan-out (and its cost) visible.
    if (dispatched.length > 0) {
      postToSupervisor(s, { kind: 'system', tone: 'info', time: nowTime(),
        text: `→ tasked ${dispatched.join(', ')} · round ${coordRef.current.round}/${MAX_SUPERVISOR_ROUNDS}` })
    }

    if (coordRef.current.waiting.size === 0) {
      // Nothing to await (all terminal/unmatched/failed) → back to idle.
      crew.bindSupervisor(activeTabRef.current, { status: 'idle' })
    } else {
      armRoundTimer()  // #1 failsafe
    }
  }, [crew, postToSupervisor, promptSupervisor, supervisorTabId, armRoundTimer, stripSupervisorTurn, feedSupervisor])

  const reportLaneReply = useCallback((laneTabId: string, attempt = 0) => {
    const s = sessionRef.current
    if (!s) return
    const lane = s.lanes.find(l => l.tabId === laneTabId)
    if (!lane) return

    const msgs = useMessagesStore.getState().messagesByTab[laneTabId]
    const text = laneReportText(msgs)
    const stillStreaming = hasStreamingLaneOutput(msgs)
    if ((stillStreaming || !text) && attempt < 8) {
      setTimeout(() => reportLaneReply(laneTabId, attempt + 1), 75)
      return
    }

    const finalText = text || '(worker finished but CrewCode captured no textual output; inspect the lane transcript for tool-only output)'
    coordRef.current.replies.push({ laneId: lane.laneId, agentId: lane.agentId, text: finalText })
    postToSupervisor(s, { kind: 'user', speaker: `${lane.laneId} · ${lane.agentId}`, text: finalText, time: nowTime() })

    feedSupervisor(false)
  }, [postToSupervisor, feedSupervisor])

  // A bridge worker finished → relay its reply and nudge the supervisor to
  // report it. We do NOT wait for the other awaited workers: each completion is
  // fed as soon as the supervisor is free, so a fast worker is reported promptly
  // instead of being blocked behind the slowest one. Any workers still running
  // stay in `waiting` and report themselves when they finish.
  const handleLaneReply = useCallback((laneTabId: string) => {
    const coord = coordRef.current
    if (!coord.waiting.has(laneTabId)) return
    coord.waiting.delete(laneTabId)
    reportLaneReply(laneTabId)
  }, [reportLaneReply])

  // Turn-end + activity subscriptions for the lifetime of the hook; handlers
  // read refs. Activity feeds the idle watchdog; turn-end advances the round.
  useEffect(() => {
    const offTurn = bridges.subscribeTurnEnd((bridgeId, tabId) => {
      if (bridgeId === coordRef.current.bridgeId) handleSupervisorTurnEnd()
      else handleLaneReply(tabId)
    })
    const offActivity = bridges.subscribeActivity((_bridgeId, tabId, type) => handleActivity(tabId, type))
    return () => { offTurn(); offActivity() }
  }, [bridges, handleSupervisorTurnEnd, handleLaneReply, handleActivity])

  // Safety net: bridge turn_end is the primary signal, but crew communication
  // cannot depend on a single event never being dropped. If a waited lane's
  // visible transcript has a stable non-streaming report, relay it even if the
  // turn_end callback did not arrive/match. This turns "supervisor never heard
  // back" into deterministic transcript-based recovery.
  useEffect(() => {
    const interval = setInterval(() => {
      const coord = coordRef.current
      if (coord.waiting.size === 0) return
      const now = Date.now()
      const messagesByTab = useMessagesStore.getState().messagesByTab
      for (const tabId of [...coord.waiting]) {
        const msgs = messagesByTab[tabId]
        const text = laneReportText(msgs)
        if (!text || hasStreamingLaneOutput(msgs)) {
          delete laneStableRef.current[tabId]
          continue
        }
        const stable = laneStableRef.current[tabId]
        if (!stable || stable.text !== text) {
          laneStableRef.current[tabId] = { text, since: now }
          continue
        }
        if (now - stable.since < 1500) continue
        handleLaneReply(tabId)
      }
    }, 750)
    return () => clearInterval(interval)
  }, [handleLaneReply])

  // Reset coordination when the active crew changes, and eagerly bind the
  // supervisor thread so the sidebar has a stable (empty) transcript.
  // Clear the failsafe timer on unmount so it can't fire into a dead hook.
  useEffect(() => () => clearRoundTimer(), [clearRoundTimer])

  useEffect(() => {
    if (!crewSession) return
    if (coordRef.current.sessionId !== crewSession.id) {
      clearRoundTimer()
      coordRef.current = freshCoord(crewSession.id)
      laneStableRef.current = {}
    }
    // Bind once the crew has left config (active or settled) — mirrors the
    // surface's showSupervisor gate so an errored isolated crew still gets a
    // bound supervisor thread.
    const launched = crewSession.state !== 'configuring' && crewSession.state !== 'provisioning'
    if (launched && crewSession.supervisor.enabled && !crewSession.supervisor.tabId) {
      crew.bindSupervisor(activeTabId, { tabId: `crew/${crewSession.id}/supervisor`, status: 'idle' })
    }
  }, [activeTabId, crewSession, crew, clearRoundTimer])

  return { sendToSupervisor, abortSupervisor }
}

/** Tail of each lane's latest agent reply — feeds the status snapshot. */
function lastByLane(s: CrewSession, msgsByTab: Record<string, Message[]>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const lane of s.lanes) {
    if (!lane.tabId) continue
    const t = laneReportText(msgsByTab[lane.tabId])
    if (t) out[lane.laneId] = t
  }
  return out
}

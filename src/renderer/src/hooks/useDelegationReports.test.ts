// The push half of delegation. What matters here is behavioural:
//   - a fan-out that finishes together produces ONE wake, not one per thread
//   - two workers finishing in the same tick cannot fire concurrent prompts
//   - a running parent gets the reply folded into its live turn
//   - a thread that goes silent is reported instead of hanging forever
//   - the budget bounds RECURSION, never the width of a legitimate fan-out
//   - every failure path buffers; a report is never dropped

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { act, flush, renderHook } from './hook-test-host'
import { useDelegationReports, cohortProgress, type DelegationReportsDeps } from './useDelegationReports'
import { MAX_AUTONOMOUS_WAKES, type DelegationReport } from './delegation-report'
import {
  REPORT_COALESCE_MS,
  REPORT_SETTLE_ATTEMPTS,
  REPORT_SETTLE_INTERVAL_MS,
  THREAD_IDLE_CHECK_MS,
  THREAD_IDLE_TIMEOUT_MS,
} from './delegation-wake-policy'
import { delegationInbox, useDelegationInboxStore } from '../stores/delegation-inbox-store'
import type { BridgeEvent, Message, Session } from '../types'

const PARENT = 'ws-chat'
const CHILD = 'ws-chat::s2'
const CHILD_2 = 'ws-chat::s3'

function session(over: Partial<Session> = {}): Session {
  return {
    id: PARENT,
    tabId: 'ws-chat',
    label: 'main',
    agentId: 'pi',
    model: 'm',
    mode: 'build',
    effort: 'medium',
    mcpServerIds: [],
    enabledSkillIds: [],
    ...over,
  }
}

const parentSession = (over: Partial<Session> = {}) => session({ delegationEnabled: true, ...over })
const childSession = (id: string, over: Partial<Session> = {}) => session({
  id, label: `sweep ${id}`, origin: 'delegated', delegatedBy: PARENT, ...over,
})

const reply = (text: string): Message => ({ kind: 'agent', text, time: '3:42 PM' } as Message)

interface Harness {
  deps: DelegationReportsDeps
  /** Fire turn_end for a scope. Does NOT drain the coalescing window. */
  endTurn: (scopeId: string) => Promise<void>
  /** Let the coalescing window elapse and settle the delivery. */
  drain: () => Promise<void>
  activity: (scopeId: string, type: BridgeEvent['type']) => void
  tickWatchdog: (ms: number) => Promise<void>
  unmount: () => void
}

function mount(over: Partial<DelegationReportsDeps> = {}, sessions?: Session[]): Harness {
  let onTurnEnd: ((bridgeId: string, scopeId: string, turnId?: string) => void) | null = null
  let onActivity: ((bridgeId: string, scopeId: string, type: BridgeEvent['type']) => void) | null = null
  const list = sessions ?? [parentSession(), childSession(CHILD)]

  const deps: DelegationReportsDeps = {
    subscribeTurnEnd: (cb) => { onTurnEnd = cb; return () => { onTurnEnd = null } },
    subscribeActivity: (cb) => { onActivity = cb; return () => { onActivity = null } },
    sessionById: (id) => list.find(s => s.id === id),
    allSessions: () => list,
    messagesForSession: (id) => [reply(replyFor[id] ?? '7 tests failed in git.test.ts')],
    isRunning: () => false,
    getBridgeId: () => 'bridge-parent',
    promptBridge: vi.fn(async () => ({ ok: true })),
    appendSystemMessage: vi.fn(),
    // Default the suite to wake OFF so buffering cases read as "this is what
    // happens without auto-wake"; the wake blocks opt in.
    wakeEnabled: () => false,
    ensureBridgeForSession: vi.fn(async () => 'bridge-parent'),
    ...over,
  }

  const harness = renderHook(() => useDelegationReports(deps), {})

  return {
    deps,
    endTurn: async (scopeId: string) => {
      await act(async () => { onTurnEnd?.('bridge-child', scopeId) })
    },
    drain: async () => {
      await act(async () => { vi.advanceTimersByTime(REPORT_COALESCE_MS) })
      await flush()
    },
    activity: (scopeId, type) => { onActivity?.('bridge-child', scopeId, type) },
    tickWatchdog: async (ms: number) => {
      await act(async () => { vi.advanceTimersByTime(ms) })
      await flush()
    },
    unmount: harness.unmount,
  }
}

/** Per-child reply text, so a thread can produce a genuinely new reply — the
 *  dedup key is the reply text, and repeating it suppresses the report. */
let replyFor: Record<string, string> = {}

const promptCalls = (h: Harness) => (h.deps.promptBridge as ReturnType<typeof vi.fn>).mock.calls

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', {})
  replyFor = {}
  useDelegationInboxStore.setState({ reportsByParent: {}, wakeByParent: {} })
})

afterEach(() => { vi.useRealTimers() })

describe('coalescing', () => {
  const fanOut = [parentSession(), childSession(CHILD), childSession(CHILD_2)]

  // The bug this exists to prevent: waking costs a full parent turn at that
  // chat's whole context, so five threads finishing must not cost five turns.
  it('a fan-out that finishes together produces ONE wake carrying every report', async () => {
    replyFor = { [CHILD]: 'suite A green', [CHILD_2]: 'suite B red' }
    const h = mount({ wakeEnabled: () => true }, fanOut)

    await h.endTurn(CHILD)
    await h.endTurn(CHILD_2)
    await h.drain()

    expect(h.deps.promptBridge).toHaveBeenCalledTimes(1)
    const text = promptCalls(h)[0][1] as string
    expect(text).toContain('suite A green')
    expect(text).toContain('suite B red')
    expect(text).toContain('2 delegated threads')
  })

  it('reports the batch as one transcript row, not one per thread', async () => {
    replyFor = { [CHILD]: 'a', [CHILD_2]: 'b' }
    const h = mount({ wakeEnabled: () => true }, fanOut)

    await h.endTurn(CHILD)
    await h.endTurn(CHILD_2)
    await h.drain()

    const rows = (h.deps.appendSystemMessage as ReturnType<typeof vi.fn>).mock.calls
    expect(rows).toHaveLength(1)
    expect(rows[0][1]).toContain('2 delegated threads finished')
  })

  it('marks a mixed batch so a failure is not hidden by successes', async () => {
    replyFor = { [CHILD]: 'green', [CHILD_2]: 'green too' }
    const h = mount({
      wakeEnabled: () => true,
      messagesForSession: (id) => id === CHILD_2
        ? [{ kind: 'system', tone: 'error', text: 'agent exited (1)', time: '3:42 PM' } as Message]
        : [reply('green')],
    }, fanOut)

    await h.endTurn(CHILD)
    await h.endTurn(CHILD_2)
    await h.drain()

    const rows = (h.deps.appendSystemMessage as ReturnType<typeof vi.fn>).mock.calls
    expect(rows[0][1]).toContain('(1 failed)')
  })

  // Crew claims `busy` synchronously before its first await for exactly this:
  // parallel workers each check-then-act on one coordinator.
  it('cannot fire two concurrent prompts at one bridge', async () => {
    replyFor = { [CHILD]: 'a', [CHILD_2]: 'b' }
    let resolvePrompt: ((v: { ok: boolean }) => void) | null = null
    const promptBridge = vi.fn(() => new Promise<{ ok: boolean }>(r => { resolvePrompt = r }))
    const h = mount({ wakeEnabled: () => true, promptBridge }, fanOut)

    await h.endTurn(CHILD)
    await h.drain()
    expect(promptBridge).toHaveBeenCalledTimes(1)

    // Second worker lands while the first delivery is still in flight.
    await h.endTurn(CHILD_2)
    await h.drain()
    expect(promptBridge).toHaveBeenCalledTimes(1)

    await act(async () => { resolvePrompt?.({ ok: true }) })
    await flush()
    // Only once the first settles does the queued report go out.
    expect(promptBridge).toHaveBeenCalledTimes(2)
  })

  // Nothing to coalesce for when the parent is already burning a turn the user
  // is watching — the reply should land in it immediately.
  it('skips the delay entirely for a parent mid-turn', async () => {
    const h = mount({ isRunning: () => true })
    await h.endTurn(CHILD)
    await flush()

    expect(h.deps.promptBridge).toHaveBeenCalledWith(
      'bridge-parent',
      expect.stringContaining('7 tests failed'),
      { streamingBehavior: 'followUp' },
    )
  })
})

describe('cohort progress', () => {
  const runId = `${PARENT}::g1`
  const cohort = [
    parentSession(),
    childSession(CHILD, { delegationRunId: runId }),
    childSession(CHILD_2, { delegationRunId: runId }),
  ]

  it('tells the agent not to call a partly-finished batch done', async () => {
    const h = mount({ wakeEnabled: () => true, isRunning: (id) => id === CHILD_2 }, cohort)
    await h.endTurn(CHILD)
    await h.drain()

    const text = promptCalls(h)[0][1] as string
    expect(text).toContain('1 of 2 threads from this batch have reported')
    expect(text).toContain('1 still running')
    expect(text).toContain('Do not summarize the batch as done yet')
  })

  it('says so when the whole batch is in', async () => {
    replyFor = { [CHILD]: 'a', [CHILD_2]: 'b' }
    const h = mount({ wakeEnabled: () => true }, cohort)
    await h.endTurn(CHILD)
    await h.endTurn(CHILD_2)
    await h.drain()

    expect(promptCalls(h)[0][1] as string).toContain('All 2 threads from this batch have now reported')
  })

  it('is omitted for threads with no cohort (spawned before run ids existed)', () => {
    const report: DelegationReport = {
      threadId: CHILD, parentSessionId: PARENT, title: 't', reply: 'r', failed: false, at: 1,
    }
    expect(cohortProgress([report], [childSession(CHILD)], () => false)).toBeUndefined()
  })

  it('is omitted for a batch spanning two runs — there is no single batch', () => {
    const base = { parentSessionId: PARENT, title: 't', reply: 'r', failed: false, at: 1 }
    const reports: DelegationReport[] = [
      { ...base, threadId: CHILD, runId: 'run-a' },
      { ...base, threadId: CHILD_2, runId: 'run-b' },
    ]
    expect(cohortProgress(reports, cohort, () => false)).toBeUndefined()
  })
})

describe('the idle watchdog', () => {
  // Only the CHILD is mid-turn. A blanket `() => true` would make the parent
  // look busy too, and its reports would leave as follow-ups instead of being
  // held — which is not what these tests are about.
  const childRunning = (id: string) => id === CHILD

  it('reports a thread that went silent instead of waiting on it forever', async () => {
    const h = mount({ isRunning: childRunning })
    h.activity(CHILD, 'text_delta')

    await h.tickWatchdog(THREAD_IDLE_TIMEOUT_MS + THREAD_IDLE_CHECK_MS)
    await h.drain()

    const held = delegationInbox.peek(PARENT)
    expect(held).toHaveLength(1)
    expect(held[0].failed).toBe(true)
    expect(held[0].reply).toContain('presumed stuck')
    // Silence is reported, not acted on — the thread stays open.
    expect(held[0].reply).toContain('NOT')
  })

  // A single long tool call emits nothing between start and end; elapsed time
  // alone would abandon a thread that is working perfectly.
  it('does not abandon a thread sitting inside a long tool call', async () => {
    const h = mount({ isRunning: childRunning })
    h.activity(CHILD, 'text_delta')
    h.activity(CHILD, 'tool_start')

    await h.tickWatchdog(THREAD_IDLE_TIMEOUT_MS + THREAD_IDLE_CHECK_MS)
    await h.drain()
    expect(delegationInbox.peek(PARENT)).toHaveLength(0)

    h.activity(CHILD, 'tool_end')
    await h.tickWatchdog(THREAD_IDLE_TIMEOUT_MS + THREAD_IDLE_CHECK_MS)
    await h.drain()
    expect(delegationInbox.peek(PARENT)).toHaveLength(1)
  })

  it('leaves a thread that finished normally alone', async () => {
    const h = mount({ isRunning: () => false })
    h.activity(CHILD, 'text_delta')

    await h.tickWatchdog(THREAD_IDLE_TIMEOUT_MS + THREAD_IDLE_CHECK_MS)
    await h.drain()
    expect(delegationInbox.peek(PARENT)).toHaveLength(0)
  })

  it('reports one hang once, however many sweeps run', async () => {
    const h = mount({ isRunning: childRunning })
    h.activity(CHILD, 'text_delta')

    await h.tickWatchdog(THREAD_IDLE_TIMEOUT_MS + THREAD_IDLE_CHECK_MS * 4)
    await h.drain()
    expect(delegationInbox.peek(PARENT)).toHaveLength(1)
  })

  it('stops watching a thread once it reports normally', async () => {
    const h = mount({ isRunning: childRunning })
    h.activity(CHILD, 'text_delta')
    await h.endTurn(CHILD)
    await h.drain()

    await h.tickWatchdog(THREAD_IDLE_TIMEOUT_MS + THREAD_IDLE_CHECK_MS)
    await h.drain()
    // One report from the turn end, none from the watchdog.
    expect(delegationInbox.peek(PARENT).filter(r => r.reply.includes('presumed stuck'))).toHaveLength(0)
  })
})

describe('an idle parent with auto-wake off', () => {
  it('buffers rather than prompting', async () => {
    const h = mount()
    await h.endTurn(CHILD)
    await h.drain()

    expect(h.deps.promptBridge).not.toHaveBeenCalled()
    expect(delegationInbox.peek(PARENT)).toHaveLength(1)
    expect(h.deps.appendSystemMessage).toHaveBeenCalledWith(PARENT, expect.stringContaining('held for your next message'))
  })
})

describe('an idle parent with auto-wake on', () => {
  const woken = (over: Partial<DelegationReportsDeps> = {}, sessions?: Session[]) =>
    mount({ wakeEnabled: () => true, ...over }, sessions)

  it('starts a fresh turn, not a follow-up', async () => {
    const h = woken()
    await h.endTurn(CHILD)
    await h.drain()

    expect(h.deps.promptBridge).toHaveBeenCalledWith(
      'bridge-parent',
      expect.stringContaining('7 tests failed'),
    )
    expect(h.deps.appendSystemMessage).toHaveBeenCalledWith(PARENT, expect.stringContaining('woke this chat'))
  })

  // A woken agent is talking to nobody. If it does not know that, it ends the
  // turn with a question the absent user never answers.
  it('tells the agent the user is not present', async () => {
    const h = woken()
    await h.endTurn(CHILD)
    await h.drain()

    const text = promptCalls(h)[0][1] as string
    expect(text).toContain('The user is NOT here')
    expect(text).toContain('do not ask them questions')
  })

  // The 10-minute idle sweep reclaims bridges, and the long jobs worth waking
  // for are exactly the ones that outlive it.
  it('revives a parent whose bridge was reclaimed by the idle sweep', async () => {
    const h = woken({ getBridgeId: () => null })
    await h.endTurn(CHILD)
    await h.drain()

    expect(h.deps.ensureBridgeForSession).toHaveBeenCalledWith(expect.objectContaining({ id: PARENT }))
    expect(h.deps.promptBridge).toHaveBeenCalled()
  })

  it('buffers when the bridge cannot be revived', async () => {
    const h = woken({ getBridgeId: () => null, ensureBridgeForSession: vi.fn(async () => null) })
    await h.endTurn(CHILD)
    await h.drain()

    expect(h.deps.promptBridge).not.toHaveBeenCalled()
    expect(delegationInbox.peek(PARENT)).toHaveLength(1)
  })

  it('buffers when the wake prompt is rejected', async () => {
    const h = woken({ promptBridge: vi.fn(async () => ({ ok: false, error: 'bridge not found' })) })
    await h.endTurn(CHILD)
    await h.drain()
    expect(delegationInbox.peek(PARENT)).toHaveLength(1)
  })

  it('buffers when the wake prompt throws', async () => {
    const h = woken({ promptBridge: vi.fn(async () => { throw new Error('ipc down') }) })
    await h.endTurn(CHILD)
    await h.drain()
    expect(delegationInbox.peek(PARENT)).toHaveLength(1)
  })
})

// The budget bounds RECURSION, not volume. A wide fan-out from a turn the user
// drove is the feature working; flat counting would penalize exactly that.
describe('the autonomous wake budget', () => {
  const autoChild = (id: string) => childSession(id, { delegatedDuringWake: true })

  it('never charges a fan-out the user asked for, however wide', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map(s => `${PARENT}::${s}`)
    const list = [parentSession(), ...ids.map(id => childSession(id))]
    replyFor = Object.fromEntries(ids.map((id, i) => [id, `result ${i}`]))
    const h = mount({ wakeEnabled: () => true }, list)

    for (const id of ids) await h.endTurn(id)
    await h.drain()

    expect(h.deps.promptBridge).toHaveBeenCalledTimes(1)
    expect(delegationInbox.wakeState(PARENT).autonomousDepth).toBe(0)
  })

  it('charges a wake caused by threads an autonomous turn spawned', async () => {
    const h = mount({ wakeEnabled: () => true }, [parentSession(), autoChild(CHILD)])
    await h.endTurn(CHILD)
    await h.drain()

    expect(h.deps.promptBridge).toHaveBeenCalledTimes(1)
    expect(delegationInbox.wakeState(PARENT).autonomousDepth).toBe(1)
  })

  it(`pauses after ${MAX_AUTONOMOUS_WAKES} recursive rounds`, async () => {
    const h = mount({ wakeEnabled: () => true }, [parentSession(), autoChild(CHILD)])

    for (let i = 0; i <= MAX_AUTONOMOUS_WAKES; i++) {
      replyFor = { [CHILD]: `recursion ${i}` }
      h.activity(CHILD, 'turn_start')
      await h.endTurn(CHILD)
      await h.drain()
    }

    expect(h.deps.promptBridge).toHaveBeenCalledTimes(MAX_AUTONOMOUS_WAKES)
    expect(delegationInbox.peek(PARENT)).toHaveLength(1)
    expect(h.deps.appendSystemMessage).toHaveBeenCalledWith(
      PARENT,
      expect.stringContaining('send a message to continue'),
    )
  })

  it('refills only on a real user message', async () => {
    const h = mount({ wakeEnabled: () => true }, [parentSession(), autoChild(CHILD)])
    for (let i = 0; i <= MAX_AUTONOMOUS_WAKES; i++) {
      replyFor = { [CHILD]: `recursion ${i}` }
      h.activity(CHILD, 'turn_start')
      await h.endTurn(CHILD)
      await h.drain()
    }
    expect(h.deps.promptBridge).toHaveBeenCalledTimes(MAX_AUTONOMOUS_WAKES)

    delegationInbox.startUserGeneration(PARENT)
    replyFor = { [CHILD]: 'after the user spoke' }
    h.activity(CHILD, 'turn_start')
    await h.endTurn(CHILD)
    await h.drain()
    expect(h.deps.promptBridge).toHaveBeenCalledTimes(MAX_AUTONOMOUS_WAKES + 1)
  })

  it('is never spent by follow-ups into a running turn', async () => {
    const h = mount({ isRunning: () => true, wakeEnabled: () => true }, [parentSession(), autoChild(CHILD)])
    for (let i = 0; i < MAX_AUTONOMOUS_WAKES + 3; i++) {
      replyFor = { [CHILD]: `pass ${i}` }
      h.activity(CHILD, 'turn_start')
      await h.endTurn(CHILD)
      await flush()
    }

    expect(h.deps.promptBridge).toHaveBeenCalledTimes(MAX_AUTONOMOUS_WAKES + 3)
    expect(delegationInbox.wakeState(PARENT).autonomousDepth).toBe(0)
  })

  // Threads spawned by a woken turn must be attributable, or recursion is free.
  it('marks the parent as mid-autonomous-turn while a wake runs', async () => {
    const h = mount({ wakeEnabled: () => true })
    await h.endTurn(CHILD)
    await h.drain()

    expect(delegationInbox.isAutonomousTurn(PARENT)).toBe(true)
    await h.endTurn(PARENT)
    expect(delegationInbox.isAutonomousTurn(PARENT)).toBe(false)
  })
})

// Regression: a real run produced two rows for ONE thread — "woke this chat"
// immediately followed by "delivered into the running turn" — and the first
// carried only the agent's opening line, so the parent complained the thread
// "only restated its intent". Two compounding bugs, both solved in crew already.
describe('one turn reports exactly once', () => {
  // `useAgentBridge` routes turn_end, error AND closed through the same
  // callback, so one logical turn fires it several times. Crew consumes the lane
  // from `waiting` on the first reply; this is that guard.
  it('ignores the trailing closed/error event for the same turn', async () => {
    const h = mount({ wakeEnabled: () => true })

    await h.endTurn(CHILD)   // turn_end
    await h.endTurn(CHILD)   // trailing `closed`
    await h.endTurn(CHILD)   // trailing `error`
    await h.drain()

    expect(h.deps.promptBridge).toHaveBeenCalledTimes(1)
    expect((h.deps.appendSystemMessage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  // The compounding half: the settle retry means an early event and a late one
  // legitimately see DIFFERENT text, so reply-text dedup could never have worked.
  it('deduplicates even when the late event sees more text than the first', async () => {
    let text = 'I will run the suite'
    const h = mount({ wakeEnabled: () => true, messagesForSession: () => [reply(text)] })

    await h.endTurn(CHILD)
    text = 'Vitest: 33 passed, exit 0'
    await h.endTurn(CHILD)
    await h.drain()

    expect(h.deps.promptBridge).toHaveBeenCalledTimes(1)
  })

  // A follow-up the parent sends is genuinely new work and must report again,
  // or a thread could only ever report once in its lifetime.
  it('reports again after the thread starts a new turn', async () => {
    const h = mount({ wakeEnabled: () => true })
    await h.endTurn(CHILD)
    await h.drain()
    expect(h.deps.promptBridge).toHaveBeenCalledTimes(1)

    replyFor = { [CHILD]: 'rerun: 33 passed' }
    h.activity(CHILD, 'turn_start')
    await h.endTurn(CHILD)
    await h.drain()
    expect(h.deps.promptBridge).toHaveBeenCalledTimes(2)
  })
})

describe('waiting for the transcript to settle', () => {
  const streamingReply = (text: string): Message =>
    ({ kind: 'agent', text, streaming: true, time: '3:42 PM' } as Message)

  // The reported symptom: turn_end fires before the renderer flushes its stream
  // buffers, so a synchronous read captures the opening line and no result.
  it('does not report the opening line while output is still streaming', async () => {
    let messages: Message[] = [streamingReply('I will run the vitest suite')]
    const h = mount({ wakeEnabled: () => true, messagesForSession: () => messages })

    await h.endTurn(CHILD)
    await act(async () => { vi.advanceTimersByTime(REPORT_SETTLE_INTERVAL_MS * 2) })
    expect(h.deps.promptBridge).not.toHaveBeenCalled()

    // Buffers flush, the turn settles, and the real result appears.
    messages = [reply('Vitest: 7 files, 33 tests passed, exit 0')]
    await act(async () => { vi.advanceTimersByTime(REPORT_SETTLE_INTERVAL_MS) })
    await h.drain()

    expect(h.deps.promptBridge).toHaveBeenCalledTimes(1)
    expect(promptCalls(h)[0][1] as string).toContain('33 tests passed')
  })

  it('waits on a tool call that has not closed yet', async () => {
    const messages: Message[] = [
      reply('running'),
      { kind: 'toolcall', status: 'running', time: '3:42 PM' } as Message,
    ]
    const h = mount({ wakeEnabled: () => true, messagesForSession: () => messages })

    await h.endTurn(CHILD)
    await act(async () => { vi.advanceTimersByTime(REPORT_SETTLE_INTERVAL_MS * 2) })
    expect(h.deps.promptBridge).not.toHaveBeenCalled()
  })

  // A thread that genuinely never produces text must not retry forever.
  it('gives up after the retry budget and reports nothing', async () => {
    const h = mount({ wakeEnabled: () => true, messagesForSession: () => [] })

    await h.endTurn(CHILD)
    await act(async () => {
      vi.advanceTimersByTime(REPORT_SETTLE_INTERVAL_MS * (REPORT_SETTLE_ATTEMPTS + 2))
    })
    await h.drain()

    expect(h.deps.promptBridge).not.toHaveBeenCalled()
    expect(delegationInbox.peek(PARENT)).toHaveLength(0)
  })

  it('starts only one retry loop however many events arrive', async () => {
    let messages: Message[] = [streamingReply('working')]
    const h = mount({ wakeEnabled: () => true, messagesForSession: () => messages })

    await h.endTurn(CHILD)
    await h.endTurn(CHILD)
    await h.endTurn(CHILD)
    messages = [reply('done')]
    await act(async () => { vi.advanceTimersByTime(REPORT_SETTLE_INTERVAL_MS * 2) })
    await h.drain()

    expect(h.deps.promptBridge).toHaveBeenCalledTimes(1)
  })
})

describe('what does not produce a report', () => {
  it('an ordinary chat the user opened themselves', async () => {
    const h = mount({}, [parentSession(), session({ id: CHILD })])
    await h.endTurn(CHILD)
    await h.drain()

    expect(delegationInbox.peek(PARENT)).toHaveLength(0)
    expect(h.deps.appendSystemMessage).not.toHaveBeenCalled()
  })

  it('a parent whose delegation toggle is off', async () => {
    const h = mount({}, [session(), childSession(CHILD)])
    await h.endTurn(CHILD)
    await h.drain()
    expect(delegationInbox.peek(PARENT)).toHaveLength(0)
  })

  it('a thread that said nothing', async () => {
    const h = mount({ messagesForSession: () => [] })
    await h.endTurn(CHILD)
    await h.drain()
    expect(delegationInbox.peek(PARENT)).toHaveLength(0)
  })

  it('repeated turn_end events for one turn', async () => {
    const h = mount()
    await h.endTurn(CHILD)
    await h.endTurn(CHILD)
    await h.endTurn(CHILD)
    await h.drain()
    expect(delegationInbox.peek(PARENT)).toHaveLength(1)
  })
})

describe('teardown', () => {
  it('unsubscribes and clears pending timers', async () => {
    const h = mount()
    await h.endTurn(CHILD)
    h.unmount()

    // The coalescing timer must not fire into an unmounted hook.
    await act(async () => { vi.advanceTimersByTime(REPORT_COALESCE_MS * 4) })
    expect(h.deps.promptBridge).not.toHaveBeenCalled()
  })
})

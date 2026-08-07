import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { renderHook, flush } from './hook-test-host'
import { useMessagesStore } from '../stores/chat-messages-store'
import { useCrewSupervisor, MAX_SUPERVISOR_ROUNDS } from './useCrewSupervisor'
import { DELEGATE_FENCE } from '../orchestrator/crew-supervisor-protocol'
import type { UseCrewSupervisorOpts } from './useCrewSupervisor'
import type {
  CrewSession, CrewAgentLane, CrewSupervisor,
} from '../orchestrator/crew-session'
import type { AgentInfo, BridgeEvent, Message } from '../types'

// ─── Fixtures ──────────────────────────────────────────────────────────────

const SID = 'crew-test'
const SUP_TAB = `crew/${SID}/supervisor`

function lane(p: Partial<CrewAgentLane> & { laneId: string; agentId: string }): CrewAgentLane {
  return {
    model: '', effort: null, roleId: null, roleName: '', role: '', instructions: '',
    status: 'running', branch: 'main', path: '/repo', worktreeId: null,
    tabId: `crew/${p.laneId}`, bridgeId: null, paneId: null, muted: false,
    usage: { tokensIn: 0, tokensOut: 0, elapsedMs: 0 }, error: null,
    ...p,
  }
}

function session(lanes: CrewAgentLane[], supervisor?: Partial<CrewSupervisor>, distribution: CrewSession['distribution'] = 'split'): CrewSession {
  return {
    id: SID, name: '', mode: 'shared', distribution, state: 'active',
    wsId: 'ws1', hostTabId: 'tab1', basePath: '/repo', baseBranch: 'main',
    worktrees: false, lanes,
    supervisor: {
      enabled: true, agentId: 'pi', model: '', effort: null,
      tabId: SUP_TAB, bridgeId: null, status: 'idle', ...supervisor,
    },
    error: null, createdAt: 0,
  }
}

const AGENTS: AgentInfo[] = [
  { id: 'pi',    name: 'pi',    path: '/pi',    available: true, transport: 'bridge' },
  { id: 'codex', name: 'codex', path: '/codex', available: true, transport: 'pty' },
]

function delegateBlock(to: string, message: string): string {
  return '```' + DELEGATE_FENCE + '\n' + JSON.stringify({ to, message }) + '\n```'
}

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** A bridge bus the test drives: deterministic ids, capturable turn/activity cbs. */
function makeBridges() {
  let turnCb:     ((bridgeId: string, tabId: string) => void) | null = null
  let activityCb: ((bridgeId: string, tabId: string, type: BridgeEvent['type']) => void) | null = null

  const bridges = {
    ensureBridge: vi.fn(async (tabId: string) => ({ bridgeId: `bridge:${tabId}` })),
    prompt: vi.fn(async (_bridgeId: string, _text: string) => ({ ok: true as const })),
    abort: vi.fn(),
    dropBridge: vi.fn(),
    subscribeTurnEnd: (cb: (b: string, t: string) => void) => {
      turnCb = cb
      return () => { if (turnCb === cb) turnCb = null }
    },
    subscribeActivity: (cb: (b: string, t: string, ty: BridgeEvent['type']) => void) => {
      activityCb = cb
      return () => { if (activityCb === cb) activityCb = null }
    },
  }
  return {
    bridges,
    emitTurnEnd:  (bridgeId: string, tabId: string) => turnCb?.(bridgeId, tabId),
    emitActivity: (bridgeId: string, tabId: string, type: BridgeEvent['type']) =>
      activityCb?.(bridgeId, tabId, type),
  }
}

/**
 * Message store accessor backed by the real `useMessagesStore` singleton — the
 * hook reads message snapshots via `useMessagesStore.getState()`, so the test
 * must write there (not into a local object) for those reads to see anything.
 * The store is reset before every test (see top-level beforeEach).
 */
function makeStore() {
  const read = (tabId: string): Message[] => useMessagesStore.getState().messagesByTab[tabId] ?? []
  const setMessagesForTab = (tabId: string, updater: (prev: Message[]) => Message[]) => {
    useMessagesStore.getState().setMessagesForTab(tabId, updater)
  }
  const setAgentReply = (tabId: string, text: string) => {
    useMessagesStore.getState().setMessagesForTab(tabId, () => [{ kind: 'agent', time: '0:00', blocks: [], text }])
  }
  const texts = (tabId: string) =>
    read(tabId).map(m => ('text' in m ? m.text ?? '' : ''))
  const systemTexts = (tabId: string) =>
    read(tabId).filter(m => m.kind === 'system').map(m => ('text' in m ? m.text ?? '' : ''))
  return { setMessagesForTab, setAgentReply, texts, systemTexts }
}

function mount(opts: {
  lanes: CrewAgentLane[]
  supervisor?: Partial<CrewSupervisor>
  agents?: AgentInfo[]
  sendToLane?: UseCrewSupervisorOpts['sendToLane']
  sendToLanes?: UseCrewSupervisorOpts['sendToLanes']
  distribution?: CrewSession['distribution']
}) {
  const b = makeBridges()
  const st = makeStore()
  const crew = { bindSupervisor: vi.fn() }
  const sendToLane = opts.sendToLane ?? vi.fn(async () => true)
  const sendToLanes = opts.sendToLanes ?? vi.fn(async (tasks: Array<{ laneId: string; text: string }>) => {
    const results: Array<{ laneId: string; started: boolean }> = []
    await Promise.all(tasks.map(async task => {
      results.push({ laneId: task.laneId, started: await sendToLane(task.laneId, task.text) })
    }))
    return results
  })
  const s = session(opts.lanes, opts.supervisor, opts.distribution)

  const h = renderHook(
    (p: UseCrewSupervisorOpts) => useCrewSupervisor(p),
    {
      activeTabId: 'tab1',
      crewSession: s,
      agents: opts.agents ?? AGENTS,
      effort: 'medium',
      bridges: b.bridges,
      crew,
      sendToLane,
      sendToLanes,
      setMessagesForTab: st.setMessagesForTab,
    } as unknown as UseCrewSupervisorOpts,
  )
  return { h, b, st, crew, sendToLane, sendToLanes, supBridge: `bridge:${SUP_TAB}` }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

// The messages store is a singleton — clear it between tests so one test's
// supervisor/lane messages don't bleed into the next.
beforeEach(() => { useMessagesStore.setState({ messagesByTab: {} }) })

describe('useCrewSupervisor — delegate fan-out', () => {
  it('parses complete split directives and routes every enabled lane', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' }), lane({ laneId: 'lane-2', agentId: 'pi' })]
    const { h, b, st, sendToLane, supBridge } = mount({ lanes })

    h.result.current.sendToSupervisor('build the api')
    await flush()
    // First prompt: preamble + user text reaches the supervisor bridge.
    expect(b.bridges.ensureBridge).toHaveBeenCalledWith(
      SUP_TAB, 'pi', 'pi', '/repo', undefined, 'medium', 'ask', 'read-only',
    )

    // Supervisor turn delegates one distinct slice to every enabled lane.
    st.setAgentReply(SUP_TAB, [
      delegateBlock('lane-1', 'check auth'),
      delegateBlock('lane-2', 'write tests'),
    ].join('\n'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()

    expect(sendToLane).toHaveBeenCalledTimes(2)
    expect(sendToLane).toHaveBeenCalledWith('lane-1', 'check auth')
    expect(sendToLane).toHaveBeenCalledWith('lane-2', 'write tests')
    // The fan-out is surfaced as a system line in the supervisor thread.
    expect(st.systemTexts(SUP_TAB).some(t => t.includes('tasked') && t.includes('lane-1') && t.includes('lane-2'))).toBe(true)
    h.unmount()
  })

  it('broadcasts to every enabled lane on "to":"all" in broadcast distribution', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' }), lane({ laneId: 'lane-2', agentId: 'pi', muted: true })]
    const sendToLane = vi.fn(async (_laneId: string, _text: string) => true)
    const { h, b, st, supBridge } = mount({ lanes, sendToLane, distribution: 'broadcast' })
    h.result.current.sendToSupervisor('go')
    await flush()
    st.setAgentReply(SUP_TAB, delegateBlock('all', 'status please'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()
    expect(sendToLane).toHaveBeenCalledTimes(1)
    expect(sendToLane.mock.calls.map(c => c[0])).toEqual(['lane-1'])
    h.unmount()
  })

  it('rejects incomplete split directives before dispatching', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' }), lane({ laneId: 'lane-2', agentId: 'pi' })]
    const { h, b, st, sendToLane, supBridge } = mount({ lanes })
    h.result.current.sendToSupervisor('go')
    await flush()
    const promptsBefore = b.bridges.prompt.mock.calls.length

    st.setAgentReply(SUP_TAB, delegateBlock('lane-1', 'only one worker'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()

    expect(sendToLane).not.toHaveBeenCalled()
    expect(st.systemTexts(SUP_TAB).some(t => t.includes('requires one distinct task for every enabled worker'))).toBe(true)
    expect(b.bridges.prompt.mock.calls.length).toBe(promptsBefore + 1)
    expect(b.bridges.prompt.mock.calls.at(-1)![1]).toContain('NO workers were tasked')
    h.unmount()
  })

  it('blocks "to":"all" in split distribution before dispatching', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' }), lane({ laneId: 'lane-2', agentId: 'pi' })]
    const { h, b, st, sendToLane, supBridge } = mount({ lanes })
    h.result.current.sendToSupervisor('go')
    await flush()
    st.setAgentReply(SUP_TAB, delegateBlock('all', 'same task'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()
    expect(sendToLane).not.toHaveBeenCalled()
    expect(st.systemTexts(SUP_TAB).some(t => t.includes('split distribution forbids'))).toBe(true)
    h.unmount()
  })

  it('reports an unmatched target instead of dispatching', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' })]
    const { h, b, st, sendToLane, supBridge } = mount({ lanes })
    h.result.current.sendToSupervisor('go')
    await flush()
    st.setAgentReply(SUP_TAB, delegateBlock('lane-99', 'do it'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()
    expect(sendToLane).not.toHaveBeenCalled()
    expect(st.systemTexts(SUP_TAB).some(t => t.includes('no enabled worker matches "lane-99"'))).toBe(true)
    h.unmount()
  })

  // #1: dispatch must be parallel. `sendToLane` resolves only after the worker's
  // turn fully settles (bridge IPC awaits the provider's turn promise), so
  // awaiting its return inside the dispatch loop would serialize workers and
  // defeat the entire crew fan-out. Here lane-1 stays in-flight intentionally
  // and lane-2's dispatch must STILL have fired — proving we don't gate lane-2
  // on lane-1's completion.
  it('hands all supervisor tasks to the batch dispatcher together', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' }), lane({ laneId: 'lane-2', agentId: 'pi' })]
    const sendToLanes = vi.fn(async (tasks: Array<{ laneId: string; text: string }>) =>
      tasks.map(task => ({ laneId: task.laneId, started: true })),
    )
    const { h, b, st, supBridge } = mount({ lanes, sendToLanes })

    h.result.current.sendToSupervisor('build the api')
    await flush()
    st.setAgentReply(SUP_TAB, [
      delegateBlock('lane-1', 'implement'),
      delegateBlock('lane-2', 'test'),
    ].join('\n'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()

    expect(sendToLanes).toHaveBeenCalledTimes(1)
    expect(sendToLanes).toHaveBeenCalledWith([
      { laneId: 'lane-1', text: 'implement', tabId: 'crew/lane-1' },
      { laneId: 'lane-2', text: 'test', tabId: 'crew/lane-2' },
    ])
    h.unmount()
  })

  it('dispatches every lane concurrently — lane 2 fires before lane 1 settles', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' }), lane({ laneId: 'lane-2', agentId: 'pi' })]
    const lane1Gate = new Promise<void>(() => {}) // never resolves — simulates an in-flight worker turn
    const lane1Calls: string[] = []
    const sendToLane = vi.fn(async (laneId: string) => {
      if (laneId === 'lane-1') { lane1Calls.push(laneId); await lane1Gate }
      return true
    })
    const { h, b, st, supBridge } = mount({ lanes, sendToLane, distribution: 'broadcast' })

    h.result.current.sendToSupervisor('build the api')
    await flush()
    st.setAgentReply(SUP_TAB, delegateBlock('all', 'split it'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()

    // Both dispatches kicked off synchronously despite lane-1 still pending.
    expect(sendToLane.mock.calls.map(c => c[0])).toEqual(['lane-1', 'lane-2'])
    h.unmount()
  })
})

describe('useCrewSupervisor — reply collection & synthesis', () => {
  it('reports each worker as soon as it finishes, without waiting for the batch', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' }), lane({ laneId: 'lane-2', agentId: 'pi' })]
    const { h, b, st, supBridge } = mount({ lanes, distribution: 'broadcast' })

    h.result.current.sendToSupervisor('go')
    await flush()

    st.setAgentReply(SUP_TAB, delegateBlock('all', 'work'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()
    const promptsAfterDelegate = b.bridges.prompt.mock.calls.length

    // First worker finishes → the supervisor is nudged IMMEDIATELY (no batch wait),
    // and the feedback carries only that worker's reply.
    st.setAgentReply('crew/lane-1', 'lane-1 is done')
    b.emitTurnEnd('bridge:crew/lane-1', 'crew/lane-1')
    await flush()
    expect(b.bridges.prompt.mock.calls.length).toBe(promptsAfterDelegate + 1)
    const fb1 = b.bridges.prompt.mock.calls.at(-1)![1]
    expect(fb1).toContain('lane-1 is done')
    expect(fb1).not.toContain('lane-2 is done')  // lane-2 still running

    // Supervisor reports to the user (no new delegation) → its turn ends, freeing it.
    st.setAgentReply(SUP_TAB, 'lane-1 done; still waiting on lane-2.')
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()

    // Second worker finishes → a second, independent report fires.
    st.setAgentReply('crew/lane-2', 'lane-2 is done')
    b.emitTurnEnd('bridge:crew/lane-2', 'crew/lane-2')
    await flush()
    const fb2 = b.bridges.prompt.mock.calls.at(-1)![1]
    expect(fb2).toContain('lane-2 is done')
    expect(fb2).toContain('[crew status]')
    h.unmount()
  })

  it('buffers a reply that lands while the supervisor is mid-turn, then drains it', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' }), lane({ laneId: 'lane-2', agentId: 'pi' })]
    const { h, b, st, supBridge } = mount({ lanes, distribution: 'broadcast' })

    h.result.current.sendToSupervisor('go')
    await flush()
    st.setAgentReply(SUP_TAB, delegateBlock('all', 'work'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()

    // lane-1 finishes → supervisor is prompted and now busy.
    st.setAgentReply('crew/lane-1', 'lane-1 is done')
    b.emitTurnEnd('bridge:crew/lane-1', 'crew/lane-1')
    await flush()
    const promptsWhileBusy = b.bridges.prompt.mock.calls.length

    // lane-2 finishes WHILE the supervisor is still mid-turn → no new prompt yet.
    st.setAgentReply('crew/lane-2', 'lane-2 is done')
    b.emitTurnEnd('bridge:crew/lane-2', 'crew/lane-2')
    await flush()
    expect(b.bridges.prompt.mock.calls.length).toBe(promptsWhileBusy)  // buffered

    // Supervisor's turn ends → the buffered lane-2 reply drains automatically.
    st.setAgentReply(SUP_TAB, 'got lane-1.')
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()
    expect(b.bridges.prompt.mock.calls.length).toBe(promptsWhileBusy + 1)
    expect(b.bridges.prompt.mock.calls.at(-1)![1]).toContain('lane-2 is done')
    h.unmount()
  })

  it('does not wait on a terminal (pty) worker — its reply cannot flow back', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'codex' })] // codex = pty
    const { h, b, st, sendToLane, supBridge } = mount({ lanes })
    h.result.current.sendToSupervisor('go')
    await flush()
    const promptsBefore = b.bridges.prompt.mock.calls.length

    st.setAgentReply(SUP_TAB, delegateBlock('lane-1', 'do it'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()

    expect(sendToLane).toHaveBeenCalledWith('lane-1', 'do it')
    // Terminal worker: a note is posted, nothing is awaited, no synthesis prompt.
    expect(st.systemTexts(SUP_TAB).some(t => t.includes('terminal worker'))).toBe(true)
    expect(b.bridges.prompt.mock.calls.length).toBe(promptsBefore)
    h.unmount()
  })

  it('skips a worker whose runtime failed to start (sendToLane → false)', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' }), lane({ laneId: 'lane-2', agentId: 'pi' })]
    const sendToLane = vi.fn(async (laneId: string) => laneId !== 'lane-1') // lane-1 never starts
    const { h, b, st, supBridge } = mount({ lanes, sendToLane, distribution: 'broadcast' })

    h.result.current.sendToSupervisor('go')
    await flush()
    st.setAgentReply(SUP_TAB, delegateBlock('all', 'work'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()
    const promptsBefore = b.bridges.prompt.mock.calls.length

    // Only lane-2 actually started → its single reply closes the round.
    st.setAgentReply('crew/lane-2', 'done')
    b.emitTurnEnd('bridge:crew/lane-2', 'crew/lane-2')
    await flush()
    expect(b.bridges.prompt.mock.calls.length).toBe(promptsBefore + 1) // synthesis fired on the one live worker
    h.unmount()
  })

  // #2 & #3: bridge streaming splits a worker turn into multiple agent bubbles
  // (text → tool → text → ...), one per segment between tool/thinking blocks.
  // The "last agent text" used to return just the trailing bubble, so the
  // supervisor received only the tail of the worker's reply — both the relay
  // bubble in the supervisor thread and the `[replies from workers]` prompt
  // were truncated. The hook now concatenates every agent bubble sharing the
  // last turn's id, so the supervisor gets the full textual reply.
  it('feeds the supervisor the full text of a multi-segment worker turn', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' })]
    const { h, b, st, supBridge } = mount({ lanes })

    h.result.current.sendToSupervisor('go')
    await flush()
    st.setAgentReply(SUP_TAB, delegateBlock('lane-1', 'work'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()

    useMessagesStore.getState().setMessagesForTab('crew/lane-1', () => [
      { kind: 'user', text: 'work', time: '0:00' },
      { kind: 'agent', time: '0:00', blocks: [], turnId: 't1', text: 'I will check ' },
      { kind: 'toolcall', time: '0:00', turnId: 't1', toolCallId: 'c1', toolName: 'grep', args: {}, status: 'completed' },
      { kind: 'agent', time: '0:00', blocks: [], turnId: 't1', text: 'the auth module — found 1 issue.' },
    ])
    b.emitTurnEnd('bridge:crew/lane-1', 'crew/lane-1')
    await flush()

    // The relay bubble in the supervisor thread carries the full reply.
    expect(st.texts(SUP_TAB).some(t => t.includes('I will check') && t.includes('found 1 issue.'))).toBe(true)
    // The synthesis prompt sent to the supervisor carries the full reply.
    const last = b.bridges.prompt.mock.calls.at(-1)![1] as string
    expect(last).toContain('I will check')
    expect(last).toContain('the auth module — found 1 issue.')
    h.unmount()
  })

  it('captures agent output without turn ids from the latest worker task', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' })]
    const { h, b, st, supBridge } = mount({ lanes })

    h.result.current.sendToSupervisor('go')
    await flush()
    st.setAgentReply(SUP_TAB, delegateBlock('lane-1', 'work'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()

    useMessagesStore.getState().setMessagesForTab('crew/lane-1', () => [
      { kind: 'user', text: 'older task', time: '0:00' },
      { kind: 'agent', time: '0:00', blocks: [], text: 'old output should not be reported' },
      { kind: 'user', text: 'work', time: '0:01' },
      { kind: 'agent', time: '0:01', blocks: [], text: 'fresh output without turn id' },
    ])
    b.emitTurnEnd('bridge:crew/lane-1', 'crew/lane-1')
    await flush()

    const last = b.bridges.prompt.mock.calls.at(-1)![1] as string
    expect(last).toContain('fresh output without turn id')
    expect(last).not.toContain('old output should not be reported')
    h.unmount()
  })

  it('waits briefly for delayed final lane output before notifying the supervisor', async () => {
    vi.useFakeTimers()
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' })]
    const { h, b, st, supBridge } = mount({ lanes })
    try {
      h.result.current.sendToSupervisor('go')
      await flush()
      st.setAgentReply(SUP_TAB, delegateBlock('lane-1', 'work'))
      b.emitTurnEnd(supBridge, SUP_TAB)
      await flush()
      const promptsBeforeReply = b.bridges.prompt.mock.calls.length

      useMessagesStore.getState().setMessagesForTab('crew/lane-1', () => [
        { kind: 'user', text: 'work', time: '0:00' },
      ])
      b.emitTurnEnd('bridge:crew/lane-1', 'crew/lane-1')
      await flush()
      expect(b.bridges.prompt.mock.calls.length).toBe(promptsBeforeReply)

      useMessagesStore.getState().setMessagesForTab('crew/lane-1', messages => [
        ...messages,
        { kind: 'agent', time: '0:00', blocks: [], turnId: 't1', text: 'delayed final report' },
      ])
      await vi.advanceTimersByTimeAsync(80)
      await flush()

      expect(b.bridges.prompt.mock.calls.at(-1)![1]).toContain('delayed final report')
    } finally {
      h.unmount()
      vi.useRealTimers()
    }
  })

  it('polls visible lane transcript if worker turn_end is missed', async () => {
    vi.useFakeTimers()
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' })]
    const { h, b, st, supBridge } = mount({ lanes })
    try {
      h.result.current.sendToSupervisor('go')
      await flush()
      st.setAgentReply(SUP_TAB, delegateBlock('lane-1', 'work'))
      b.emitTurnEnd(supBridge, SUP_TAB)
      await flush()
      const promptsAfterDispatch = b.bridges.prompt.mock.calls.length

      // No worker turn_end is emitted. The lane transcript nevertheless shows a
      // completed non-streaming response; the safety poller must relay it.
      useMessagesStore.getState().setMessagesForTab('crew/lane-1', () => [
        { kind: 'user', text: 'work', time: '0:00' },
        { kind: 'agent', time: '0:00', blocks: [], turnId: 't1', text: 'visible completed report', streaming: false },
      ])
      await vi.advanceTimersByTimeAsync(2500)
      await flush()

      expect(b.bridges.prompt.mock.calls.length).toBe(promptsAfterDispatch + 1)
      expect(b.bridges.prompt.mock.calls.at(-1)![1]).toContain('visible completed report')
    } finally {
      h.unmount()
      vi.useRealTimers()
    }
  })

  it('does not leak tool-only worker internals into the supervisor reply', async () => {
    vi.useFakeTimers()
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' })]
    const { h, b, st, supBridge } = mount({ lanes })
    try {
      h.result.current.sendToSupervisor('go')
      await flush()
      st.setAgentReply(SUP_TAB, delegateBlock('lane-1', 'work'))
      b.emitTurnEnd(supBridge, SUP_TAB)
      await flush()

      useMessagesStore.getState().setMessagesForTab('crew/lane-1', () => [
        { kind: 'user', text: 'work', time: '0:00' },
        { kind: 'thinking', time: '0:00', turnId: 't1', text: 'I am thinking internally', streaming: false },
        { kind: 'toolcall', time: '0:00', turnId: 't1', toolCallId: 'c1', toolName: 'read', args: {}, status: 'completed', result: 'file contents' },
      ])
      b.emitTurnEnd('bridge:crew/lane-1', 'crew/lane-1')
      await vi.advanceTimersByTimeAsync(700)
      await flush()

      const supervisorTexts = st.texts(SUP_TAB).join('\n')
      expect(supervisorTexts).not.toContain('[thinking]')
      expect(supervisorTexts).not.toContain('tool read')
      expect(supervisorTexts).toContain('captured no textual output')
    } finally {
      h.unmount()
      vi.useRealTimers()
    }
  })

  // Regression: silent-crash race. Two workers dispatched in parallel finish at
  // nearly the same time (two turn_ends back-to-back). Each calls feedSupervisor,
  // which used to check `coord.busy` and — because promptSupervisor only set
  // `busy` AFTER `await ensureBridge` resolved — slip a second promptSupervisor
  // through. Two concurrent `bridges.prompt(supBridge, …)` calls on the same
  // supervisor bridge corrupt the provider subprocess and silently crash the
  // renderer. The hook must claim the busy slot synchronously so the second
  // feedSupervisor buffers its reply instead of re-prompting.
  it('never double-prompts the supervisor when two workers finish simultaneously', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' }), lane({ laneId: 'lane-2', agentId: 'pi' })]
    const { h, b, st, supBridge } = mount({ lanes, distribution: 'broadcast' })

    h.result.current.sendToSupervisor('go')
    await flush()
    st.setAgentReply(SUP_TAB, delegateBlock('all', 'work'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()
    const promptsAfterDelegate = b.bridges.prompt.mock.calls.length

    // Both lanes reply *simultaneously* — emit both turn_ends, then flush.
    st.setAgentReply('crew/lane-1', 'lane-1 reply')
    st.setAgentReply('crew/lane-2', 'lane-2 reply')
    b.emitTurnEnd('bridge:crew/lane-1', 'crew/lane-1')
    b.emitTurnEnd('bridge:crew/lane-2', 'crew/lane-2')
    await flush()

    // Exactly ONE synthesis prompt to the supervisor this cycle (the second
    // reply buffers and drains when this synthesis turn ends).
    expect(b.bridges.prompt.mock.calls.length).toBe(promptsAfterDelegate + 1)
    const feedback = b.bridges.prompt.mock.calls.at(-1)![1] as string
    // Both replies should reach the supervisor — the second drains on turn_end.
    expect(feedback).toContain('lane-1 reply')
    expect(feedback).toContain('lane-2 reply')
    h.unmount()
  })
})

describe('useCrewSupervisor — round cap', () => {
  it(`pauses auto-advance after ${MAX_SUPERVISOR_ROUNDS} rounds`, async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' })]
    const { h, b, st, supBridge } = mount({ lanes })
    h.result.current.sendToSupervisor('go')
    await flush()

    // Each cycle: supervisor delegates to lane-1, lane-1 replies → one finishRound.
    for (let i = 0; i < MAX_SUPERVISOR_ROUNDS + 1; i++) {
      st.setAgentReply(SUP_TAB, delegateBlock('lane-1', `task ${i}`))
      b.emitTurnEnd(supBridge, SUP_TAB)
      await flush()
      st.setAgentReply('crew/lane-1', `reply ${i}`)
      b.emitTurnEnd('bridge:crew/lane-1', 'crew/lane-1')
      await flush()
    }

    expect(st.systemTexts(SUP_TAB).some(t => t.includes('auto-advance paused'))).toBe(true)
    h.unmount()
  })
})

describe('useCrewSupervisor — silent missed-delegation recovery', () => {
  it('re-prompts silently (no visible nag) when the supervisor names a worker but emits no block', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' })]
    const { h, b, st, sendToLane, supBridge } = mount({ lanes })
    h.result.current.sendToSupervisor('go')
    await flush()
    const promptsBefore = b.bridges.prompt.mock.calls.length

    st.setAgentReply(SUP_TAB, "I'll get pi on it.")
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()

    expect(sendToLane).not.toHaveBeenCalled()
    // The correction is background: no user-visible crew-delegate lecture.
    expect(st.systemTexts(SUP_TAB).some(t => t.includes('crew-delegate'))).toBe(false)
    // …but the supervisor is silently re-prompted exactly once.
    expect(b.bridges.prompt.mock.calls.length).toBe(promptsBefore + 1)
    h.unmount()
  })

  it('ignores duplicate delegation to lanes that are already waiting', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' }), lane({ laneId: 'lane-2', agentId: 'pi' })]
    const { h, b, st, sendToLane, supBridge } = mount({ lanes })
    h.result.current.sendToSupervisor('go')
    await flush()

    const firstPlan = [
      delegateBlock('lane-1', 'first task'),
      delegateBlock('lane-2', 'second task'),
    ].join('\n')
    st.setAgentReply(SUP_TAB, firstPlan)
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()
    expect(sendToLane).toHaveBeenCalledTimes(2)

    st.setAgentReply(SUP_TAB, firstPlan)
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()

    expect(sendToLane).toHaveBeenCalledTimes(2)
    expect(st.systemTexts(SUP_TAB).some(t => t.includes('duplicate dispatch ignored'))).toBe(true)
    h.unmount()
  })

  it('does not fire missed-delegation correction while workers are already waiting', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' })]
    const { h, b, st, sendToLane, supBridge } = mount({ lanes })
    h.result.current.sendToSupervisor('go')
    await flush()

    st.setAgentReply(SUP_TAB, delegateBlock('lane-1', 'work'))
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()
    const promptsAfterDispatch = b.bridges.prompt.mock.calls.length

    st.setAgentReply(SUP_TAB, "I'll check with pi since it has not replied yet.")
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()

    expect(sendToLane).toHaveBeenCalledTimes(1)
    expect(b.bridges.prompt.mock.calls.length).toBe(promptsAfterDispatch)
    h.unmount()
  })

  it('dispatches and hides the correction turn when the silent re-prompt yields a block', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' })]
    const { h, b, st, sendToLane, supBridge } = mount({ lanes })
    h.result.current.sendToSupervisor('go')
    await flush()

    st.setAgentReply(SUP_TAB, "I'll get pi on it.")
    b.emitTurnEnd(supBridge, SUP_TAB)           // → fires silent correction
    await flush()

    const block = delegateBlock('lane-1', 'review the auth module')
    st.setAgentReply(SUP_TAB, block)            // supervisor's correction reply
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()

    // Work is dispatched…
    expect(sendToLane).toHaveBeenCalledWith('lane-1', 'review the auth module')
    // …surfaced only via the "tasked" line, and the raw block turn is stripped.
    expect(st.systemTexts(SUP_TAB).some(t => t.includes('tasked') && t.includes('lane-1'))).toBe(true)
    expect(st.texts(SUP_TAB).some(t => t.includes(DELEGATE_FENCE))).toBe(false)
    h.unmount()
  })

  it('silently drops a false-positive correction with no block', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' })]
    const { h, b, st, sendToLane, supBridge } = mount({ lanes })
    h.result.current.sendToSupervisor('go')
    await flush()

    st.setAgentReply(SUP_TAB, "I'll get pi on it.")
    b.emitTurnEnd(supBridge, SUP_TAB)           // → fires silent correction
    await flush()

    st.setAgentReply(SUP_TAB, 'I was only talking to you, no delegation intended.')
    b.emitTurnEnd(supBridge, SUP_TAB)
    await flush()

    expect(sendToLane).not.toHaveBeenCalled()
    // The correction turn is removed from view — nothing user-facing remains.
    expect(st.texts(SUP_TAB).some(t => t.includes('only talking to you'))).toBe(false)
    h.unmount()
  })
})

describe('useCrewSupervisor — abort', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('aborts the in-flight turn and ignores its trailing turn_end', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' })]
    const b = makeBridges()
    const st = makeStore()
    const crew = { bindSupervisor: vi.fn() }
    const sendToLane = vi.fn(async () => true)
    const s = session(lanes)

    const h = renderHook(
      (p: UseCrewSupervisorOpts) => useCrewSupervisor(p),
      {
        activeTabId: 'tab1', crewSession: s, agents: AGENTS, effort: 'medium',
        bridges: b.bridges, crew, sendToLane,
        setMessagesForTab: st.setMessagesForTab,
      } as unknown as UseCrewSupervisorOpts,
    )

    h.result.current.sendToSupervisor('go')
    await flush()

    h.result.current.abortSupervisor()
    // Abort now tears the supervisor bridge down entirely (drop), not just abort.
    expect(b.bridges.dropBridge).toHaveBeenCalledWith(SUP_TAB, 'pi')
    expect(st.systemTexts(SUP_TAB).some(t => t.includes('orchestration stopped'))).toBe(true)

    // A turn_end arriving after the abort must NOT spawn a delegation round.
    st.setAgentReply(SUP_TAB, delegateBlock('lane-1', 'do it'))
    b.emitTurnEnd(`bridge:${SUP_TAB}`, SUP_TAB)
    await flush()
    expect(sendToLane).not.toHaveBeenCalled()
    h.unmount()
  })
})

describe('useCrewSupervisor — idle watchdog', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('abandons a worker that goes silent past the idle timeout and advances the round', async () => {
    const lanes = [lane({ laneId: 'lane-1', agentId: 'pi' })]
    const b = makeBridges()
    const st = makeStore()
    const crew = { bindSupervisor: vi.fn() }
    const sendToLane = vi.fn(async () => true)
    const s = session(lanes)

    const h = renderHook(
      (p: UseCrewSupervisorOpts) => useCrewSupervisor(p),
      {
        activeTabId: 'tab1', crewSession: s, agents: AGENTS, effort: 'medium',
        bridges: b.bridges, crew, sendToLane,
        setMessagesForTab: st.setMessagesForTab,
      } as unknown as UseCrewSupervisorOpts,
    )

    h.result.current.sendToSupervisor('go')
    await flush()

    // Delegate to lane-1 → it's now awaited and the idle watchdog is armed.
    st.setAgentReply(SUP_TAB, delegateBlock('lane-1', 'long task'))
    b.emitTurnEnd(`bridge:${SUP_TAB}`, SUP_TAB)
    await vi.advanceTimersByTimeAsync(0)
    const promptsBefore = b.bridges.prompt.mock.calls.length

    // lane-1 emits nothing for longer than the idle timeout (3 min) → abandoned.
    await vi.advanceTimersByTimeAsync(4 * 60_000)

    expect(st.systemTexts(SUP_TAB).some(t => t.includes('lane-1') && t.includes('went silent'))).toBe(true)
    // The round still advances (feedback prompt fired) instead of hanging forever.
    expect(b.bridges.prompt.mock.calls.length).toBe(promptsBefore + 1)
    h.unmount()
  })
})

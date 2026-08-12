import { describe, it, expect } from 'vitest'
import {
  parseDirectives,
  resolveTargets,
  buildSupervisorPreamble,
  buildRunSelectionSnapshot,
  distributionDirective,
  buildStatusSnapshot,
  buildReplyFeedback,
  buildWorkerPreamble,
  detectMissedDelegation,
  laneCanReply,
  validateDirectivePolicy,
  DELEGATE_FENCE,
} from './crew-supervisor-protocol'
import { createSession, crewReducer, type CrewSession, type CrewAgentLane } from './crew-session'
import type { AgentInfo } from '../types'

const agents: AgentInfo[] = [
  { id: 'pi',     name: 'pi',     path: null, available: true, transport: 'bridge' },
  { id: 'codex',  name: 'codex',  path: null, available: true, transport: 'pty' },
]

function sessionWithLanes(): CrewSession {
  let s = createSession({ wsId: 'ws1', hostTabId: 'tab1', basePath: '/repo', baseBranch: 'main' })
  s = crewReducer(s, { type: 'add_lane', agentId: 'pi', role: { roleId: 'r1', roleName: 'implementer', role: 'writes code', instructions: '' } })
  s = crewReducer(s, { type: 'add_lane', agentId: 'codex', role: { roleId: 'r2', roleName: 'reviewer', role: 'reviews code', instructions: '' } })
  return s
}

const fence = (json: string) => '```' + DELEGATE_FENCE + '\n' + json + '\n```'

describe('parseDirectives', () => {
  it('extracts a single delegate block', () => {
    const text = `Sure, I'll have the implementer start.\n${fence('{ "to": "lane-1", "message": "implement the parser" }')}`
    expect(parseDirectives(text)).toEqual([{ to: 'lane-1', message: 'implement the parser' }])
  })

  it('extracts multiple blocks in one turn', () => {
    const text = `${fence('{ "to": "pi", "message": "build it" }')}\nand\n${fence('{ "to": "all", "message": "status?" }')}`
    expect(parseDirectives(text)).toEqual([
      { to: 'pi', message: 'build it' },
      { to: 'all', message: 'status?' },
    ])
  })

  it('accepts common markdown fence variants from supervisor follow-up turns', () => {
    const text = [
      `I'll start the next task with both workers.`,
      '   ```` crew-delegate\r\n{ "to": "lane-1", "message": "implement task 7" }\r\n   ````',
      `Some prose between blocks.`,
      '\t```CREW-DELEGATE\n{ "to": "lane-2", "message": "write task 7 tests" }\n\t```',
    ].join('\n')
    expect(parseDirectives(text)).toEqual([
      { to: 'lane-1', message: 'implement task 7' },
      { to: 'lane-2', message: 'write task 7 tests' },
    ])
  })

  it('accepts the broadcast shorthand and the task alias', () => {
    const text = fence('{ "broadcast": true, "task": "run tests" }')
    expect(parseDirectives(text)).toEqual([{ to: 'all', message: 'run tests' }])
  })

  it('skips malformed JSON and blocks missing fields without throwing', () => {
    const text = [
      fence('{ not json }'),
      fence('{ "to": "lane-1" }'),       // no message
      fence('{ "message": "orphan" }'),  // no target
      fence('{ "to": "lane-2", "message": "ok" }'),
    ].join('\n')
    expect(parseDirectives(text)).toEqual([{ to: 'lane-2', message: 'ok' }])
  })

  it('returns nothing for plain prose', () => {
    expect(parseDirectives('just reporting status to the user, no delegation.')).toEqual([])
  })
})

describe('resolveTargets', () => {
  const s = sessionWithLanes()
  const [lane1, lane2] = s.lanes

  it('matches "all" to every enabled lane', () => {
    expect(resolveTargets('all', s.lanes)).toHaveLength(2)
  })

  it('matches an exact laneId', () => {
    expect(resolveTargets(lane1.laneId, s.lanes)).toEqual([lane1])
  })

  it('matches by agentId', () => {
    expect(resolveTargets('codex', s.lanes)).toEqual([lane2])
  })

  it('matches by role', () => {
    expect(resolveTargets('reviewer', s.lanes)).toEqual([lane2])
  })

  it('returns [] for an unknown target', () => {
    expect(resolveTargets('nobody', s.lanes)).toEqual([])
  })

  it('excludes lanes disabled by the run toggle', () => {
    const disabledCodex = { ...lane2, muted: true }
    const lanes = [lane1, disabledCodex]
    expect(resolveTargets('all', lanes)).toEqual([lane1])
    expect(resolveTargets(disabledCodex.laneId, lanes)).toEqual([])
    expect(resolveTargets('codex', lanes)).toEqual([])
  })
})

describe('supervisor fan-out instructions', () => {
  it('tells split-mode supervisors to assign independent workers before waiting', () => {
    const s = sessionWithLanes()
    expect(distributionDirective(s)).toContain('every enabled worker exactly one')
    expect(distributionDirective(s)).toContain('SAME supervisor turn')
  })

  it('tells the supervisor preamble to prefer parallel fan-out for coding work', () => {
    const s = sessionWithLanes()
    const preamble = buildSupervisorPreamble(s, agents)
    expect(preamble).toContain('MUST emit one fenced block for every enabled worker')
    expect(preamble).toContain('before waiting for any worker reply')
  })
})

describe('validateDirectivePolicy', () => {
  it('blocks unavailable targets', () => {
    const s = sessionWithLanes()
    const violations = validateDirectivePolicy(s, [{ to: 'lane-99', message: 'do it' }])
    expect(violations.some(v => v.reason.includes('no enabled worker matches'))).toBe(true)
    expect(violations.some(v => v.reason.includes('requires one distinct task for every enabled worker'))).toBe(true)
  })

  it('blocks all and multi-worker target resolution in split mode', () => {
    const s = sessionWithLanes()
    const duplicatePi = { ...s.lanes[0], laneId: 'lane-3' }
    expect(validateDirectivePolicy(s, [{ to: 'all', message: 'same task' }])[0].reason).toContain('split distribution forbids')
    expect(validateDirectivePolicy({ ...s, lanes: [...s.lanes, duplicatePi] }, [{ to: 'pi', message: 'same task' }])[0].reason).toContain('resolves to 2 workers')
  })

  it('blocks duplicate exact task text in split mode', () => {
    const s = sessionWithLanes()
    const violations = validateDirectivePolicy(s, [
      { to: s.lanes[0].laneId, message: 'Review auth' },
      { to: s.lanes[1].laneId, message: ' review   auth ' },
    ])
    const duplicateViolations = violations.filter(v => v.reason.includes('duplicate'))
    expect(duplicateViolations.map(v => v.index).sort()).toEqual([0, 1])
  })



  it('allows all under broadcast distribution', () => {
    const s = { ...sessionWithLanes(), distribution: 'broadcast' as const }
    expect(validateDirectivePolicy(s, [{ to: 'all', message: 'status' }])).toEqual([])
  })
})

describe('laneCanReply', () => {
  it('is true only for bridge-transport workers', () => {
    const s = sessionWithLanes()
    const pi    = s.lanes.find(l => l.agentId === 'pi')   as CrewAgentLane
    const codex = s.lanes.find(l => l.agentId === 'codex') as CrewAgentLane
    expect(laneCanReply(pi, agents)).toBe(true)
    expect(laneCanReply(codex, agents)).toBe(false)
  })
})

describe('detectMissedDelegation', () => {
  const lanes = sessionWithLanes().lanes  // pi/implementer, codex/reviewer

  it('fires on an unambiguous hand-off verb near a named worker', () => {
    expect(detectMissedDelegation("I'll ask the reviewer to check the auth code.", lanes)).toBe(true)
    expect(detectMissedDelegation('Let me have pi implement the parser.', lanes)).toBe(true)
    expect(detectMissedDelegation('Delegating the migration to the implementer now.', lanes)).toBe(true)
  })

  // Soft tier: a commitment marker + a specifically named worker recovers
  // natural phrasings that carry no explicit hand-off verb.
  it('recovers soft delegation phrasings that name a worker', () => {
    expect(detectMissedDelegation("I'll get pi on it.", lanes)).toBe(true)
    expect(detectMissedDelegation("Let me loop pi in on the parser work.", lanes)).toBe(true)
  })

  // A strong hand-off verb targeting a generic "worker" is still a real (just
  // unnamed) delegation intent, worth re-prompting for specifics.
  it('fires on a strong verb aimed at a generic worker', () => {
    expect(detectMissedDelegation("I'll assign this to a worker shortly.", lanes)).toBe(true)
  })

  it('stays quiet when the supervisor is just answering the user', () => {
    expect(detectMissedDelegation('The architecture uses an event bus; here is how it works.', lanes)).toBe(false)
  })

  it('stays quiet on intent with no worker reference', () => {
    expect(detectMissedDelegation("I'll think about the best approach here.", lanes)).toBe(false)
  })

  // Regression: bare commitment markers ("I'll"/"let me") + a worker name used
  // to false-nag on the supervisor's normal recaps. The recap veto stops that.
  it('does not nag when recapping or summarizing worker output', () => {
    expect(detectMissedDelegation('Let me summarize what pi built so far.', lanes)).toBe(false)
    expect(detectMissedDelegation("I'll walk you through what the reviewer found.", lanes)).toBe(false)
    expect(detectMissedDelegation('The reviewer already flagged the auth issue.', lanes)).toBe(false)
  })

  // A dual-use verb against a generic crew word with no commitment is just chat.
  it('ignores generic crew questions', () => {
    expect(detectMissedDelegation('Do we have any other agents available?', lanes)).toBe(false)
  })

  // Word boundaries: a short agentId ("pi") must not match inside other words.
  it('does not match a short agent id inside an unrelated word', () => {
    expect(detectMissedDelegation('Have the api reviewed for correctness.', lanes)).toBe(false)
  })

  it('is empty-safe', () => {
    expect(detectMissedDelegation('', lanes)).toBe(false)
  })
})

describe('buildWorkerPreamble', () => {
  const lane = (over: Partial<CrewAgentLane>): CrewAgentLane => ({
    laneId: 'lane-1', agentId: 'pi', model: '', effort: null,
    roleId: null, roleName: '', role: '', instructions: '',
    status: 'ready', branch: 'main', path: '/repo',
    worktreeId: null, tabId: 'crew/lane-1', bridgeId: null, paneId: null,
    muted: false, usage: { tokensIn: 0, tokensOut: 0, elapsedMs: 0 }, error: null,
    ...over,
  })

  it('returns empty for a lane with no role adopted (nothing to prime)', () => {
    expect(buildWorkerPreamble(lane({}), '/repo')).toBe('')
  })

  it('injects the role name verbatim even without instructions', () => {
    const p = buildWorkerPreamble(lane({ roleName: 'reviewer' }), '/repo')
    expect(p).toContain('name: reviewer')
    expect(p).toContain('/repo')
  })

  it('injects all three role fields verbatim', () => {
    const p = buildWorkerPreamble(lane({ roleName: 'tester', role: 'runs the suite', instructions: 'only touch *.test.ts' }), '/repo')
    expect(p).toContain('name: tester')
    expect(p).toContain('role: runs the suite')
    expect(p).toContain('instructions: only touch *.test.ts')
  })

  it('primes a lane that has only instructions', () => {
    expect(buildWorkerPreamble(lane({ instructions: 'be terse' }), '/repo')).toContain('be terse')
  })
})

describe('formatters', () => {
  it('renders only available workers + transport hints in the preamble', () => {
    const s = sessionWithLanes()
    const hiddenCodex = { ...s.lanes[1], muted: true }
    const preamble = buildSupervisorPreamble({ ...s, lanes: [s.lanes[0], hiddenCodex] }, agents)
    expect(preamble).toContain('crew of AI coding agents')
    expect(preamble).toContain('Run selection')
    expect(preamble).toContain('can reply to you')                       // pi (bridge)
    expect(preamble).not.toContain('codex')                              // hidden skipped worker
    expect(preamble).not.toContain('reviewer')
    expect(preamble).toContain(DELEGATE_FENCE)
  })

  it('hides skipped workers in the live run-selection snapshot', () => {
    const s = sessionWithLanes()
    const hiddenCodex = { ...s.lanes[1], muted: true }
    const snap = buildRunSelectionSnapshot({ ...s, lanes: [s.lanes[0], hiddenCodex] }, agents)
    expect(snap).toContain('available workers')
    expect(snap).toContain('pi')
    expect(snap).not.toContain('codex')
    expect(snap).not.toContain('reviewer')
  })

  it('carries the live distribution directive in the snapshot', () => {
    const s = sessionWithLanes()  // createSession defaults to split
    const splitSnap = buildRunSelectionSnapshot(s, agents)
    expect(splitSnap).toContain('task distribution: SPLIT')
    expect(splitSnap).toContain('DISTINCT')

    const bcastSnap = buildRunSelectionSnapshot({ ...s, distribution: 'broadcast' }, agents)
    expect(bcastSnap).toContain('task distribution: BROADCAST')
    expect(bcastSnap).not.toContain('task distribution: SPLIT')
  })

  it('distributionDirective forbids to:all under split and allows it under broadcast', () => {
    const s = sessionWithLanes()
    expect(distributionDirective(s)).toContain('do NOT use "to": "all"')
    expect(distributionDirective({ ...s, distribution: 'broadcast' })).toContain('"to": "all"')
  })

  it('builds a per-lane status snapshot with reply tails and paused checkpoints', () => {
    const s = sessionWithLanes()
    const pausedCodex = { ...s.lanes[1], muted: true, nextAction: 're-run migration tests' }
    const snap = buildStatusSnapshot({ ...s, lanes: [s.lanes[0], pausedCodex] }, { [s.lanes[0].laneId]: 'done — all green' })
    expect(snap).toContain('[crew status]')
    expect(snap).toContain('done — all green')
    expect(snap).toContain('codex')
    expect(snap).toContain('paused')
    expect(snap).toContain('next action: "re-run migration tests"')
    expect(snap.split('\n')).toHaveLength(3)  // header + both owned lanes
  })

  it('formats worker replies for feedback', () => {
    const fb = buildReplyFeedback(
      [{ laneId: 'lane-1', agentId: 'pi', text: 'parser done' }],
      '[crew status]\n- lane-1 (pi, implementer): done',
    )
    expect(fb).toContain('[replies from workers]')
    expect(fb).toContain('lane-1 (pi)')
    expect(fb).toContain('parser done')
    expect(fb).toContain(DELEGATE_FENCE)
  })
})

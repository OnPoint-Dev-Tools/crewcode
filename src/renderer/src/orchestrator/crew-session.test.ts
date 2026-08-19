import { describe, it, expect } from 'vitest'
import {
  createSession,
  crewReducer,
  canProvision,
  canActivate,
  crewWarnings,
  crewRoster,
  MAX_LANES,
  type CrewSession,
  type CrewAction,
} from './crew-session'

/** Apply a sequence of actions to a session — terse setup for multi-step states. */
function run(session: CrewSession, actions: CrewAction[]): CrewSession {
  return actions.reduce(crewReducer, session)
}

const base = () => createSession({
  wsId: 'ws1', hostTabId: 'tab1', basePath: '/repo', baseBranch: 'main',
})

describe('crew-session — non-git workspace (no worktrees)', () => {
  const noGit = () => createSession({
    wsId: 'ws1', hostTabId: 'tab1', basePath: '/folder', baseBranch: 'main', worktrees: false,
  })

  it('provisions isolated lanes in-place on the base path, skipping worktrees', () => {
    const s = run(noGit(), [
      { type: 'add_lane', agentId: 'pi' },
      { type: 'add_lane', agentId: 'codex' },
      { type: 'provision' },
    ])
    expect(s.mode).toBe('isolated')
    expect(s.state).toBe('provisioning')
    // Every lane is immediately ready on the base path/branch — no git wait.
    expect(s.lanes.every(l => l.status === 'ready')).toBe(true)
    expect(s.lanes.every(l => l.path === '/folder')).toBe(true)
    expect(s.lanes.every(l => l.branch === 'main')).toBe(true)
    expect(s.lanes.every(l => l.worktreeId === null)).toBe(true)
  })

  it('activates without any lane_provisioned dispatch (no git layer involved)', () => {
    const s = run(noGit(), [
      { type: 'add_lane', agentId: 'pi' },
      { type: 'provision' },
      { type: 'activate' },
    ])
    expect(s.state).toBe('active')
  })

  it('defaults worktrees to true for a normal git workspace', () => {
    expect(base().worktrees).toBe(true)
    expect(noGit().worktrees).toBe(false)
  })
})

describe('crew-session — isolated mode (multiple workspaces)', () => {
  it('forks a distinct branch per lane off the base, with no worktree until provisioned', () => {
    const s = run(base(), [
      { type: 'add_lane', agentId: 'pi' },
      { type: 'add_lane', agentId: 'codex' },
    ])
    expect(s.mode).toBe('isolated')
    expect(s.lanes).toHaveLength(2)
    // Each lane gets its own branch namespaced under crew/<tag>/...
    expect(s.lanes[0].branch).toMatch(/^crew\/.+\/pi-1$/)
    expect(s.lanes[1].branch).toMatch(/^crew\/.+\/codex-2$/)
    expect(s.lanes[0].branch).toContain(s.id.replace(/^crew-/, ''))
    expect(s.lanes[0].branch).not.toBe(s.lanes[1].branch)
    // No directory or worktree exists yet — provisioning fills these in.
    expect(s.lanes.every(l => l.path === '' && l.worktreeId === null)).toBe(true)
  })

  it('provisions lanes asynchronously then activates once all are ready', () => {
    let s = run(base(), [
      { type: 'add_lane', agentId: 'pi' },
      { type: 'add_lane', agentId: 'codex' },
    ])
    expect(canProvision(s)).toBe(true)

    s = crewReducer(s, { type: 'provision' })
    expect(s.state).toBe('provisioning')
    expect(s.lanes.every(l => l.status === 'provisioning')).toBe(true)
    // Can't activate until every lane reports ready.
    expect(canActivate(s)).toBe(false)
    expect(crewReducer(s, { type: 'activate' }).state).toBe('provisioning')

    s = crewReducer(s, { type: 'lane_provisioned', laneId: s.lanes[0].laneId, worktreeId: 'wt-a', path: '/repo/.worktrees/a', branch: s.lanes[0].branch })
    s = crewReducer(s, { type: 'lane_provisioned', laneId: s.lanes[1].laneId, worktreeId: 'wt-b', path: '/repo/.worktrees/b', branch: s.lanes[1].branch })
    expect(s.lanes[0].path).toBe('/repo/.worktrees/a')
    expect(s.lanes[0].worktreeId).toBe('wt-a')
    expect(canActivate(s)).toBe(true)

    s = crewReducer(s, { type: 'activate' })
    expect(s.state).toBe('active')
    // Distinct worktree dirs — the isolation guarantee.
    expect(s.lanes[0].path).not.toBe(s.lanes[1].path)
  })

  it('warns that each isolated branch must be merged or discarded separately', () => {
    const s = run(base(), [
      { type: 'add_lane', agentId: 'pi' },
      { type: 'add_lane', agentId: 'codex' },
    ])
    expect(crewWarnings(s).some(w => /isolated worktrees/.test(w))).toBe(true)
  })
})

describe('crew-session — shared mode (single workspace)', () => {
  it('pins every lane to the same base path and branch with no worktree', () => {
    const s = run(base(), [
      { type: 'set_mode', mode: 'shared' },
      { type: 'add_lane', agentId: 'pi' },
      { type: 'add_lane', agentId: 'codex' },
      { type: 'add_lane', agentId: 'opencode' },
    ])
    expect(s.mode).toBe('shared')
    // The core shared-mode invariant: one dir, one branch, one file set.
    expect(s.lanes.every(l => l.path === '/repo')).toBe(true)
    expect(s.lanes.every(l => l.branch === 'main')).toBe(true)
    expect(s.lanes.every(l => l.worktreeId === null)).toBe(true)
  })

  it('provisions instantly — shared lanes are ready with no git work', () => {
    let s = run(base(), [
      { type: 'set_mode', mode: 'shared' },
      { type: 'add_lane', agentId: 'pi' },
      { type: 'add_lane', agentId: 'codex' },
    ])
    s = crewReducer(s, { type: 'provision' })
    expect(s.state).toBe('provisioning')
    // No async worktree creation — lanes land directly on 'ready'.
    expect(s.lanes.every(l => l.status === 'ready')).toBe(true)
    expect(canActivate(s)).toBe(true)
    expect(s.lanes.every(l => l.path === '/repo' && l.branch === 'main')).toBe(true)
  })

  it('re-derives lane branches/paths when toggling isolated → shared and back', () => {
    let s = run(base(), [
      { type: 'add_lane', agentId: 'pi' },
      { type: 'add_lane', agentId: 'codex' },
    ])
    const isolatedBranches = s.lanes.map(l => l.branch)

    s = crewReducer(s, { type: 'set_mode', mode: 'shared' })
    expect(s.lanes.every(l => l.branch === 'main' && l.path === '/repo')).toBe(true)

    s = crewReducer(s, { type: 'set_mode', mode: 'isolated' })
    // Branch namespace is regenerated to the same per-lane shape; paths cleared.
    expect(s.lanes.map(l => l.branch)).toEqual(isolatedBranches)
    expect(s.lanes.every(l => l.path === '')).toBe(true)
  })

  it('warns about concurrent edits to the shared branch', () => {
    const s = run(base(), [
      { type: 'set_mode', mode: 'shared' },
      { type: 'add_lane', agentId: 'pi' },
      { type: 'add_lane', agentId: 'codex' },
    ])
    expect(crewWarnings(s).some(w => /concurrent edits/.test(w))).toBe(true)
  })

  it('archives shared lanes immediately — nothing to tear down', () => {
    let s = run(base(), [
      { type: 'set_mode', mode: 'shared' },
      { type: 'add_lane', agentId: 'pi' },
      { type: 'provision' },
      { type: 'activate' },
    ])
    expect(s.state).toBe('active')
    s = crewReducer(s, { type: 'archive' })
    expect(s.state).toBe('archiving')
    expect(s.lanes.every(l => l.status === 'done')).toBe(true)
  })
})

describe('crew-session — guards and invariants', () => {
  it('does not cap the number of lanes (MAX_LANES is unbounded)', () => {
    expect(MAX_LANES).toBe(Infinity)
    let s = base()
    const n = 20
    for (let i = 0; i < n; i++) s = crewReducer(s, { type: 'add_lane', agentId: `a${i}` })
    expect(s.lanes).toHaveLength(n)
  })

  it('rejects structural edits once past configuring', () => {
    let s = run(base(), [{ type: 'add_lane', agentId: 'pi' }, { type: 'provision' }])
    const before = s.lanes.length
    s = crewReducer(s, { type: 'add_lane', agentId: 'codex' })
    expect(s.lanes).toHaveLength(before)            // add_lane ignored outside configuring
    s = crewReducer(s, { type: 'set_mode', mode: 'shared' })
    expect(s.mode).toBe('isolated')                 // mode locked after provision
  })

  it('cannot provision with zero lanes', () => {
    expect(canProvision(base())).toBe(false)
    expect(crewReducer(base(), { type: 'provision' }).state).toBe('configuring')
  })

  it('roster excludes lanes still pending in config', () => {
    const s = run(base(), [{ type: 'add_lane', agentId: 'pi' }, { type: 'add_lane', agentId: 'codex' }])
    expect(crewRoster(s)).toHaveLength(0)           // all pending → nothing owns disk yet
    const provisioned = crewReducer(s, { type: 'provision' })
    // isolated lanes go to 'provisioning' (not pending) → now in the roster
    expect(crewRoster(provisioned)).toHaveLength(2)
  })

  it('fail() moves the session to error and tags the lane', () => {
    let s = run(base(), [{ type: 'add_lane', agentId: 'pi' }, { type: 'provision' }])
    const laneId = s.lanes[0].laneId
    s = crewReducer(s, { type: 'fail', error: 'worktree add failed', laneId })
    expect(s.state).toBe('error')
    expect(s.error).toBe('worktree add failed')
    expect(s.lanes[0].status).toBe('error')
  })
})

describe('crew-session — durable lane pause checkpoints', () => {
  function activeLane(): CrewSession {
    return run(base(), [
      { type: 'set_mode', mode: 'shared' },
      { type: 'add_lane', agentId: 'pi' },
      { type: 'provision' },
      { type: 'activate' },
    ])
  }

  it('pauses a live runtime without losing its worktree or next action', () => {
    let s = activeLane()
    const laneId = s.lanes[0].laneId
    s = crewReducer(s, {
      type: 'lane_status', laneId, status: 'running',
      tabId: 'crew/lane-1', bridgeId: 'bridge-1',
    })
    s = crewReducer(s, { type: 'set_lane_next_action', laneId, nextAction: 'finish auth tests' })
    s = crewReducer(s, { type: 'toggle_lane_mute', laneId })

    expect(s.lanes[0]).toMatchObject({
      muted: true,
      nextAction: 'finish auth tests',
      status: 'ready',
      bridgeId: null,
      path: '/repo',
      branch: 'main',
    })
  })

  it('resumes ready with the checkpoint intact', () => {
    let s = activeLane()
    const laneId = s.lanes[0].laneId
    s = crewReducer(s, { type: 'set_lane_next_action', laneId, nextAction: 'inspect migration output' })
    s = crewReducer(s, { type: 'toggle_lane_mute', laneId })
    s = crewReducer(s, { type: 'toggle_lane_mute', laneId })

    expect(s.lanes[0].muted).toBe(false)
    expect(s.lanes[0].status).toBe('ready')
    expect(s.lanes[0].nextAction).toBe('inspect migration output')
  })

  it('bounds checkpoint text stored with a session', () => {
    let s = activeLane()
    const laneId = s.lanes[0].laneId
    s = crewReducer(s, { type: 'set_lane_next_action', laneId, nextAction: 'x'.repeat(700) })
    expect(s.lanes[0].nextAction).toHaveLength(500)
  })
})

describe('crew-session — task distribution', () => {
  it('defaults new sessions to split', () => {
    expect(base().distribution).toBe('split')
  })

  it('set_distribution flips the mode', () => {
    const s = crewReducer(base(), { type: 'set_distribution', distribution: 'broadcast' })
    expect(s.distribution).toBe('broadcast')
  })

  it('is editable mid-run (unlike mode)', () => {
    // Distribution is a live setting — it must change even after provisioning,
    // where structural edits like set_mode are locked out.
    let s = run(base(), [{ type: 'add_lane', agentId: 'pi' }, { type: 'provision' }])
    s = crewReducer(s, { type: 'set_distribution', distribution: 'broadcast' })
    expect(s.distribution).toBe('broadcast')
  })
})

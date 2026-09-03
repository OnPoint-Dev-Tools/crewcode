import { describe, expect, it } from 'vitest'
import {
  authorityDriftViolation,
  CUSTODY_INVARIANTS,
  decideModeChange,
  describeDrift,
  diffAuthority,
  normalizeAuthority,
  refusalMessage,
  violation,
} from './custody-invariants'

const base = { provider: 'claude', cwd: '/repo', mode: 'build' as const }

describe('normalizeAuthority', () => {
  it('defaults the unset fields instead of leaving authority undefined', () => {
    expect(normalizeAuthority(base)).toEqual({
      provider: 'claude', cwd: '/repo', mode: 'build', crewcoderMode: 'configured', crewcoderApprovalMode: 'review', toolPolicy: 'default',
      externalDirectories: [], mcpServers: [],
    })
  })

  it('sorts collections so reordering config is not misread as drift', () => {
    const a = normalizeAuthority({ ...base, externalDirectories: ['/b', '/a'], mcpServers: [{ name: 'z' }, { name: 'a' }] })
    const b = normalizeAuthority({ ...base, externalDirectories: ['/a', '/b'], mcpServers: [{ name: 'a' }, { name: 'z' }] })
    expect(diffAuthority(a, b)).toEqual([])
  })
})

describe('diffAuthority', () => {
  it('reports no drift when authority is unchanged', () => {
    expect(diffAuthority(normalizeAuthority(base), normalizeAuthority(base))).toEqual([])
  })

  it('names every changed field with both values so the report is exact', () => {
    const recorded = normalizeAuthority(base)
    const observed = normalizeAuthority({ ...base, mode: 'full', cwd: '/elsewhere' })
    expect(diffAuthority(recorded, observed)).toEqual([
      { field: 'cwd', recorded: '/repo', observed: '/elsewhere' },
      { field: 'mode', recorded: 'build', observed: 'full' },
    ])
    expect(describeDrift(diffAuthority(recorded, observed)))
      .toBe('cwd: recorded "/repo", now "/elsewhere"; mode: recorded "build", now "full"')
  })

  it('catches an MCP server appearing under a live grant', () => {
    const recorded = normalizeAuthority(base)
    const observed = normalizeAuthority({ ...base, mcpServers: [{ name: 'filesystem' }] })
    expect(diffAuthority(recorded, observed)).toEqual([
      { field: 'mcpServers', recorded: '(none)', observed: 'filesystem' },
    ])
  })

  it('treats CrewCoder approval escalation as authority drift', () => {
    const recorded = normalizeAuthority({ ...base, provider: 'crewcoder', crewcoderApprovalMode: 'review' })
    const observed = normalizeAuthority({ ...base, provider: 'crewcoder', crewcoderApprovalMode: 'full-access' })
    expect(diffAuthority(recorded, observed)).toEqual([
      { field: 'crewcoderApprovalMode', recorded: 'review', observed: 'full-access' },
    ])
  })
})

describe('decideModeChange', () => {
  it('applies immediately when no turn is in flight', () => {
    expect(decideModeChange('build', 'full', false)).toEqual({ apply: true })
  })

  it('refuses and defers an escalation requested mid-turn', () => {
    const decision = decideModeChange('build', 'full', true)
    expect(decision.apply).toBe(false)
    expect(decision.deferred).toBe(true)
    expect(decision.reason).toContain('next turn')
  })

  it('refuses a de-escalation mid-turn too, so the running turn never changes authority', () => {
    expect(decideModeChange('full', 'plan', true).apply).toBe(false)
  })

  it('treats a no-op change as applied so the UI does not report a false refusal', () => {
    expect(decideModeChange('build', 'build', true)).toEqual({ apply: true })
  })

  it('treats an unset current mode as build', () => {
    expect(decideModeChange(undefined, 'build', true)).toEqual({ apply: true })
  })
})

describe('authorityDriftViolation', () => {
  const scope = { bridgeId: 'br-1', provider: 'claude', cwd: '/repo', turnId: 'turn-3' }

  it('returns null when the live authority still matches the record', () => {
    expect(authorityDriftViolation(normalizeAuthority(base), normalizeAuthority(base), scope)).toBeNull()
  })

  it('halts and states the exact drift when authority escalated under a live grant', () => {
    const trip = authorityDriftViolation(
      normalizeAuthority(base),
      normalizeAuthority({ ...base, mode: 'full' }),
      scope,
      99,
    )
    expect(trip).toMatchObject({ invariant: 'authority-drift', halts: true, at: 99, scope })
    expect(trip!.detail).toContain('mode: recorded "build", now "full"')
  })

  it('halts on de-escalation too — any unexplained change means the record is stale', () => {
    const trip = authorityDriftViolation(
      normalizeAuthority({ ...base, mode: 'full' }),
      normalizeAuthority({ ...base, mode: 'plan' }),
      scope,
    )
    expect(trip?.invariant).toBe('authority-drift')
  })
})

describe('invariant catalog', () => {
  it('halts on every invariant where the state is unknown rather than known-bad', () => {
    expect(CUSTODY_INVARIANTS['authority-drift'].halts).toBe(true)
    expect(CUSTODY_INVARIANTS['execution-custody-lost'].halts).toBe(true)
    expect(CUSTODY_INVARIANTS['scope-unknown'].halts).toBe(true)
    expect(CUSTODY_INVARIANTS['restart-recovery'].halts).toBe(true)
    // An orphaned permission request is fully known: cancel it and say so.
    expect(CUSTODY_INVARIANTS['orphaned-authorization'].halts).toBe(false)
  })

  it('stamps halts onto the violation it builds', () => {
    const scope = { bridgeId: 'br-1', provider: 'claude', cwd: '/repo' }
    expect(violation('authority-drift', 'mode changed', scope, 42)).toEqual({
      invariant: 'authority-drift', detail: 'mode changed', scope, at: 42, halts: true,
    })
  })

  it('names the failed invariant and the required action in the refusal', () => {
    const halt = violation('scope-unknown', '/repo no longer exists', { bridgeId: 'br-1', provider: 'claude', cwd: '/repo' })
    expect(refusalMessage('prompt', halt)).toBe(
      'prompt refused: workspace scope is unknown — /repo no longer exists. Reauthorize this thread to continue.',
    )
    expect(refusalMessage('authorize', halt)).toContain('authorize refused')
  })
})

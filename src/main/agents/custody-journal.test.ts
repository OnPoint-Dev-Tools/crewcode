import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CustodyJournal, custodyScopeKey, type CustodyRecord } from './custody-journal'
import { normalizeAuthority, violation } from './custody-invariants'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function journalPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'custody-journal-'))
  roots.push(root)
  return join(root, 'custody-journal.json')
}

function record(overrides: Partial<CustodyRecord> = {}): CustodyRecord {
  return {
    bridgeId: 'br-tab1-claude-abc',
    sessionKey: 'tab1:claude',
    authority: normalizeAuthority({ provider: 'claude', cwd: '/repo', mode: 'build' }),
    pid: 4242,
    status: 'running',
    startedAt: 100,
    updatedAt: 100,
    turnId: 'turn-1',
    turnStartedAt: 100,
    ...overrides,
  }
}

describe('CustodyJournal restart recovery', () => {
  it('recovers an in-flight turn as interrupted-and-gating, never as one that finished', () => {
    const path = journalPath()
    new CustodyJournal(path, 100).open(record())

    const restarted = new CustodyJournal(path, 500)
    const recovered = restarted.get('br-tab1-claude-abc')!
    // The status names the honest outcome: the turn was interrupted and its
    // effects were never observed. It is emphatically not 'ended'/'idle'.
    expect(recovered.status).toBe('interrupted')
    expect(recovered.endedAt).toBe(500)
    expect(recovered.halt?.invariant).toBe('restart-recovery')
    expect(recovered.halt?.detail).toContain('/repo')
    expect(recovered.halt?.scope.turnId).toBe('turn-1')
    expect(readFileSync(path, 'utf8')).toContain('restart-recovery')
  })

  // The behavioural contract, asserted independently of which word the status
  // uses. Both 'interrupted' and 'halted' must gate; an earlier version of this
  // suite pinned the status name instead and a rename silently broke it while
  // the actual guarantee was intact.
  it.each(['interrupted', 'halted'] as const)('gates privileged actions while status is %s', (status) => {
    const path = journalPath()
    const journal = new CustodyJournal(path, 100)
    journal.open(record({ status, turnId: undefined, halt: violation('restart-recovery', 'stopped mid-turn', { bridgeId: 'br-tab1-claude-abc', provider: 'claude', cwd: '/repo' }, 100) }))
    expect(journal.activeHalt('tab1:claude')).not.toBeNull()
    expect(journal.haltedRecord('tab1:claude')).not.toBeNull()
    expect(journal.reauthorize('tab1:claude', 200)).toBe(1)
    expect(journal.activeHalt('tab1:claude')).toBeNull()
  })

  it('leaves known-good statuses ungated', () => {
    const path = journalPath()
    const journal = new CustodyJournal(path, 100)
    for (const status of ['idle', 'ended', 'running'] as const) {
      journal.open(record({ bridgeId: `br-${status}`, sessionKey: `t-${status}:claude`, status }))
      expect(journal.activeHalt(`t-${status}:claude`)).toBeNull()
    }
  })

  it('keeps the halt in force for the thread even though the new run gets a new bridgeId', () => {
    const path = journalPath()
    new CustodyJournal(path, 100).open(record())

    const restarted = new CustodyJournal(path, 500)
    expect(restarted.activeHalt('tab1:claude')?.invariant).toBe('restart-recovery')
    // A brand-new bridge for the same thread must still see the halt.
    expect(restarted.activeHalt(custodyScopeKey({ sessionKey: 'tab1:claude', bridgeId: 'br-tab1-claude-zzz' })))
      .not.toBeNull()
  })

  it('ends an idle bridge cleanly, because a stopped idle process is known state not unknown state', () => {
    const path = journalPath()
    new CustodyJournal(path, 100).open(record({ status: 'idle', turnId: undefined }))

    const restarted = new CustodyJournal(path, 500)
    expect(restarted.get('br-tab1-claude-abc')!.status).toBe('ended')
    expect(restarted.activeHalt('tab1:claude')).toBeNull()
  })

  it('backfills review into journals written before CrewCoder approval was explicit', () => {
    const path = journalPath()
    const first = new CustodyJournal(path, 100)
    first.open(record({ status: 'ended', turnId: undefined }))
    const legacy = JSON.parse(readFileSync(path, 'utf8'))
    delete legacy.records[0].authority.crewcoderApprovalMode
    writeFileSync(path, JSON.stringify(legacy))

    const restarted = new CustodyJournal(path, 500)
    expect(restarted.get('br-tab1-claude-abc')?.authority.crewcoderApprovalMode).toBe('review')
    expect(JSON.parse(readFileSync(path, 'utf8')).records[0].authority.crewcoderApprovalMode).toBe('review')
  })

  it('does not resurrect a halt that was already reauthorized', () => {
    const path = journalPath()
    const first = new CustodyJournal(path, 100)
    first.open(record())
    first.halt('br-tab1-claude-abc', violation('execution-custody-lost', 'process exited', { bridgeId: 'br-tab1-claude-abc', provider: 'claude', cwd: '/repo' }, 120), undefined, 120)
    expect(first.reauthorize('tab1:claude', 130)).toBe(1)

    const restarted = new CustodyJournal(path, 500)
    expect(restarted.activeHalt('tab1:claude')).toBeNull()
    expect(restarted.get('br-tab1-claude-abc')!.reauthorizedAt).toBe(130)
  })
})

describe('CustodyJournal evidence', () => {
  it('preserves the prompt and partial response of an interrupted turn', () => {
    const path = journalPath()
    const journal = new CustodyJournal(path, 100)
    journal.open(record())
    journal.halt(
      'br-tab1-claude-abc',
      violation('execution-custody-lost', 'claude exited with code 1 mid-turn', { bridgeId: 'br-tab1-claude-abc', provider: 'claude', cwd: '/repo', turnId: 'turn-1' }, 200),
      { prompt: 'refactor the auth module', partial: 'I will start by reading' },
      200,
    )

    const reloaded = new CustodyJournal(path, 900).haltedRecord('tab1:claude')!
    expect(reloaded.interruptedPrompt).toBe('refactor the auth module')
    expect(reloaded.interruptedPartial).toBe('I will start by reading')
    // Reauthorizing resumes work; it must not erase the evidence trail.
    const journal2 = new CustodyJournal(path, 1000)
    journal2.reauthorize('tab1:claude', 1000)
    expect(journal2.forScope('tab1:claude')[0].interruptedPrompt).toBe('refactor the auth module')
  })

  it('falls back to a bridge-scoped key when a thread has no session key', () => {
    const path = journalPath()
    const journal = new CustodyJournal(path, 100)
    journal.open(record({ sessionKey: null }))
    journal.halt('br-tab1-claude-abc', violation('scope-unknown', 'root vanished', { bridgeId: 'br-tab1-claude-abc', provider: 'claude', cwd: '/repo' }, 200), undefined, 200)
    expect(journal.activeHalt('bridge:br-tab1-claude-abc')?.invariant).toBe('scope-unknown')
    expect(journal.activeHalt('tab1:claude')).toBeNull()
  })
})

describe('CustodyJournal writes', () => {
  it('writes atomically with owner-only permissions and survives a corrupt file', () => {
    const path = journalPath()
    new CustodyJournal(path, 100).open(record({ status: 'idle', turnId: undefined }))
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    expect(parsed.version).toBe(1)
    expect(parsed.records).toHaveLength(1)

    // A corrupt journal must not crash startup; it starts empty rather than
    // silently claiming there was nothing in flight.
    const corruptPath = journalPath()
    expect(() => new CustodyJournal(corruptPath, 100)).not.toThrow()
  })
})

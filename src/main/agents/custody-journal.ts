// Atomically persisted custody record for every agent bridge execution.
//
// This is the agent-layer sibling of CrewMergeJournal. The principle is the
// same and it is the whole point of the file: an execution whose outcome was
// never observed is recovered as INTERRUPTED, never inferred successful.
//
// Halts are keyed by the stable thread key (`sessionKey`, "tabId:agentId")
// rather than `bridgeId`, because bridgeIds embed a timestamp and are minted
// fresh on every start. A halt raised by a crashed run must still be in force
// when the thread comes back with a new bridgeId.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { type CustodyAuthority, type CustodyViolation, violation } from './custody-invariants'

export type CustodyStatus =
  /** A turn is in flight right now. */
  | 'running'
  /** Bridge is alive, no turn in flight. */
  | 'idle'
  /** Bridge stopped cleanly and no turn was in flight. */
  | 'ended'
  /** A turn was in flight and its outcome was never observed. */
  | 'interrupted'
  /** An invariant tripped; privileged actions are refused until reauthorized. */
  | 'halted'

export interface CustodyRecord {
  bridgeId: string
  sessionKey: string | null
  authority: CustodyAuthority
  pid: number | null
  status: CustodyStatus
  startedAt: number
  updatedAt: number
  endedAt?: number
  /** Set while a turn is in flight, cleared on a real turn_end. */
  turnId?: string
  turnStartedAt?: number
  halt?: CustodyViolation
  reauthorizedAt?: number
  /** Prompt currently in flight. Promoted to interruptedPrompt during recovery. */
  activePrompt?: string
  /** Preserved evidence for an interrupted turn: what was asked, what came back. */
  interruptedPrompt?: string
  interruptedPartial?: string
  /** Bounded audit trail, including non-halting orphaned authorization records. */
  violations?: CustodyViolation[]
}

interface JournalFile { version: 1; records: CustodyRecord[] }

const MAX_RECORDS = 200

/** Halt scope key. Falls back to the bridgeId when a thread key is unavailable. */
export function custodyScopeKey(record: Pick<CustodyRecord, 'sessionKey' | 'bridgeId'>): string {
  return record.sessionKey ?? `bridge:${record.bridgeId}`
}

export class CustodyJournal {
  private records: CustodyRecord[] = []

  constructor(private readonly path: string, now = Date.now()) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as JournalFile
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('unsupported or malformed journal')
      this.records = parsed.records
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.records = []
      else {
        throw new Error(
          `Execution custody journal at "${path}" is unreadable. Refusing to infer that no execution was in flight: ${(error as Error).message}`,
        )
      }
    }

    let recovered = false
    this.records = this.records.map(record => {
      // Before CrewCoder exposed its native approval picker every bridge was
      // launched in review. Backfill that known authority fact so an upgraded
      // app does not mistake an older journal shape for unexplained drift.
      if (!record.authority.crewcoderApprovalMode) {
        recovered = true
        record = {
          ...record,
          authority: { ...record.authority, crewcoderApprovalMode: 'review' },
        }
      }
      // A turn that was in flight when CrewCode stopped has unknown effects on
      // the workspace. It is interrupted and gated, never assumed complete.
      if (record.status === 'running') {
        recovered = true
        const halt = violation(
          'restart-recovery',
          `CrewCode stopped while ${record.authority.provider} was executing a turn. Whatever that turn had already done to ${record.authority.cwd} was not observed and is not assumed complete.`,
          { bridgeId: record.bridgeId, provider: record.authority.provider, cwd: record.authority.cwd, turnId: record.turnId, sessionKey: record.sessionKey },
          now,
        )
        return {
          ...record,
          status: 'interrupted' as const,
          updatedAt: now,
          endedAt: now,
          halt,
          activePrompt: undefined,
          interruptedPrompt: record.interruptedPrompt ?? record.activePrompt,
          violations: [...(record.violations ?? []), halt].slice(-20),
        }
      }
      // An idle bridge's process is gone after a restart; that outcome IS known,
      // so it ends cleanly rather than halting.
      if (record.status === 'idle') {
        recovered = true
        return { ...record, status: 'ended' as const, updatedAt: now, endedAt: now }
      }
      return record
    })
    if (recovered) this.flush()
  }

  get(bridgeId: string): CustodyRecord | null {
    return this.records.find(record => record.bridgeId === bridgeId) ?? null
  }

  open(record: CustodyRecord): CustodyRecord {
    const index = this.records.findIndex(item => item.bridgeId === record.bridgeId)
    if (index >= 0) this.records[index] = record
    else this.records.push(record)
    if (this.records.length > MAX_RECORDS) this.records = this.records.slice(-MAX_RECORDS)
    this.flush()
    return record
  }

  patch(bridgeId: string, update: Partial<CustodyRecord>, now = Date.now()): CustodyRecord | null {
    const record = this.records.find(item => item.bridgeId === bridgeId)
    if (!record) return null
    Object.assign(record, update, { updatedAt: now })
    this.flush()
    return record
  }

  /**
   * The halt currently in force for a thread, if any. Scans by thread key so a
   * halt survives the bridgeId churn of a restart or a fresh start.
   */
  activeHalt(scopeKey: string): CustodyViolation | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i]
      if (custodyScopeKey(record) !== scopeKey) continue
      if ((record.status !== 'halted' && record.status !== 'interrupted') || record.reauthorizedAt) continue
      return record.halt ?? null
    }
    return null
  }

  /** The halted record itself — used to surface preserved evidence alongside the banner. */
  haltedRecord(scopeKey: string): CustodyRecord | null {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i]
      if (custodyScopeKey(record) !== scopeKey) continue
      if ((record.status !== 'halted' && record.status !== 'interrupted') || record.reauthorizedAt) continue
      return record
    }
    return null
  }

  halt(bridgeId: string, halt: CustodyViolation, evidence?: { prompt?: string; partial?: string }, now = Date.now()): CustodyRecord | null {
    const record = this.get(bridgeId)
    return this.patch(bridgeId, {
      status: 'halted',
      halt,
      endedAt: now,
      activePrompt: undefined,
      // Fall back to the persisted in-flight prompt: after a crash the
      // in-memory turn map is gone, so the journal is the only evidence left.
      interruptedPrompt: evidence?.prompt ?? record?.activePrompt,
      interruptedPartial: evidence?.partial,
      violations: [...(record?.violations ?? []), halt].slice(-20),
    }, now)
  }

  /** Persist a known violation that does not itself halt execution. */
  recordViolation(bridgeId: string, issue: CustodyViolation, now = Date.now()): CustodyRecord | null {
    const record = this.get(bridgeId)
    if (!record) return null
    return this.patch(bridgeId, { violations: [...(record.violations ?? []), issue].slice(-20) }, now)
  }

  /**
   * Explicit human reauthorization. Clears every unreauthorized halt for the
   * thread and stamps when it happened — the record itself is never deleted, so
   * the evidence trail survives the resume.
   */
  reauthorize(scopeKey: string, now = Date.now()): number {
    let cleared = 0
    for (const record of this.records) {
      if (custodyScopeKey(record) !== scopeKey) continue
      if ((record.status !== 'halted' && record.status !== 'interrupted') || record.reauthorizedAt) continue
      record.reauthorizedAt = now
      record.updatedAt = now
      cleared++
    }
    if (cleared) this.flush()
    return cleared
  }

  /** All records for a thread, oldest first. Read-only view for diagnostics. */
  forScope(scopeKey: string): CustodyRecord[] {
    return this.records.filter(record => custodyScopeKey(record) === scopeKey).map(record => ({ ...record }))
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, records: this.records } satisfies JournalFile, null, 2), { mode: 0o600 })
    renameSync(temp, this.path)
  }
}

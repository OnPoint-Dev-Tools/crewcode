import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { IntegrationCheckResult, IntegrationLane } from './crew-integration-verification'

export type CrewIntegrationPhase = 'preflight' | 'combining' | 'checking' | 'ready' | 'applying' | 'complete'
export type CrewIntegrationStatus = 'running' | 'passed' | 'failed' | 'conflict' | 'interrupted' | 'applied' | 'stale'

export interface CrewIntegrationJournalRecord {
  id: string
  sessionId: string
  repoPath: string
  baseBranch: string
  baseHead: string
  lanes: IntegrationLane[]
  retentionRef: string
  integrationHead?: string
  phase: CrewIntegrationPhase
  status: CrewIntegrationStatus
  checks: IntegrationCheckResult[]
  startedAt: number
  updatedAt: number
  finishedAt?: number
  error?: string
}

interface JournalFile { version: 1; records: CrewIntegrationJournalRecord[] }

/** Main-process, atomically persisted source of truth for integration ownership and recovery. */
export class CrewMergeJournal {
  private records: CrewIntegrationJournalRecord[] = []

  constructor(private readonly path: string, now = Date.now()) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as JournalFile
      this.records = Array.isArray(parsed.records) ? parsed.records : []
    } catch { this.records = [] }

    let recovered = false
    this.records = this.records.map(record => {
      if (record.status !== 'running') return record
      recovered = true
      return {
        ...record, status: 'interrupted', updatedAt: now, finishedAt: now,
        checks: record.checks.map(check => check.status === 'running' ? {
          ...check,
          status: 'interrupted',
          output: [check.output, 'CrewCode stopped while this check was running'].filter(Boolean).join('\n'),
          execution: check.execution ? { ...check.execution, state: 'unknown', checkedAt: now, detail: 'awaiting post-restart liveness probe' } : undefined,
        } : check),
        error: `CrewCode stopped during ${record.phase}; the base was not updated unless the record reached complete`,
      }
    })
    if (recovered) this.flush()
  }

  latest(sessionId: string): CrewIntegrationJournalRecord | null {
    return [...this.records].reverse().find(record => record.sessionId === sessionId) ?? null
  }

  put(record: CrewIntegrationJournalRecord): void {
    const index = this.records.findIndex(item => item.id === record.id)
    if (index >= 0) this.records[index] = record
    else this.records.push(record)
    this.records = this.records.slice(-100)
    this.flush()
  }

  patch(id: string, update: Partial<CrewIntegrationJournalRecord>): CrewIntegrationJournalRecord | null {
    const record = this.records.find(item => item.id === id)
    if (!record) return null
    Object.assign(record, update)
    this.flush()
    return record
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify({ version: 1, records: this.records } satisfies JournalFile, null, 2), { mode: 0o600 })
    renameSync(temp, this.path)
  }
}

export function journalExists(path: string): boolean { return existsSync(path) }

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { CrewMergeJournal, type CrewIntegrationJournalRecord } from './crew-merge-journal'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe('CrewMergeJournal', () => {
  it('atomically persists ownership and marks in-flight work interrupted after restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-journal-'))
    roots.push(root)
    const path = join(root, 'merge-journal.json')
    const record: CrewIntegrationJournalRecord = {
      id: 'op-1', sessionId: 'session-1', repoPath: '/repo', baseBranch: 'main', baseHead: 'base123',
      lanes: [
        { laneId: 'migration', label: 'Migration', branch: 'lane/migration', head: 'aaa111', worktreePath: '/repo/wt-migration', files: ['db/migration.sql'] },
        { laneId: 'api', label: 'API', branch: 'lane/api', head: 'bbb222', worktreePath: '/repo/wt-api', files: ['src/model.ts'] },
      ],
      retentionRef: 'refs/crewcode/integration/session-1', phase: 'checking', status: 'running',
      checks: [], startedAt: 100, updatedAt: 110,
    }
    new CrewMergeJournal(path, 100).put(record)

    const restarted = new CrewMergeJournal(path, 200)
    expect(restarted.latest('session-1')).toMatchObject({
      status: 'interrupted', phase: 'checking', finishedAt: 200,
      lanes: record.lanes, baseHead: 'base123',
    })
    expect(readFileSync(path, 'utf8')).toContain('interrupted')
  })
})

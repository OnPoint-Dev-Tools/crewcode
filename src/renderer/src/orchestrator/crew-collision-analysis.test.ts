import { describe, expect, it } from 'vitest'
import { analyzeCrewCollisions } from './crew-collision-analysis'

describe('analyzeCrewCollisions', () => {
  it('reports exact overlapping files even though Git may merge different hunks', () => {
    const findings = analyzeCrewCollisions([
      { laneId: 'a', label: 'agent a', files: ['src/auth.ts'] },
      { laneId: 'b', label: 'agent b', files: ['src/auth.ts'] },
    ])
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'file-overlap', severity: 'high', files: ['src/auth.ts'] }),
    ])
  })

  it('flags a migration changed separately from its model and API consumers', () => {
    const findings = analyzeCrewCollisions([
      { laneId: 'db', label: 'database', files: ['db/migrations/004_add_owner.sql'] },
      { laneId: 'api', label: 'api', files: ['src/models/project.ts', 'src/api/projects.ts'] },
    ])
    expect(findings).toContainEqual(expect.objectContaining({
      kind: 'behavioral-risk',
      laneIds: ['db', 'api'],
      reason: expect.stringContaining('database contract'),
    }))
  })

  it('does not claim unrelated source files collide', () => {
    expect(analyzeCrewCollisions([
      { laneId: 'a', label: 'a', files: ['src/editor/theme.ts'] },
      { laneId: 'b', label: 'b', files: ['src/voice/player.ts'] },
    ])).toEqual([])
  })
})

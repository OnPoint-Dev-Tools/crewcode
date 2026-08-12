import { describe, expect, it } from 'vitest'
import { presentCrewIntegration } from './crew-integration-presentation'
import type { CrewIntegrationRecord } from '../types'

function record(status: CrewIntegrationRecord['status'], phase: CrewIntegrationRecord['phase']): CrewIntegrationRecord {
  return {
    id: 'op', sessionId: 'session', repoPath: '/repo', baseBranch: 'main', baseHead: 'base',
    lanes: [], retentionRef: 'refs/crewcode/integration/session', status, phase,
    checks: [], startedAt: 1, updatedAt: 2,
  }
}

describe('presentCrewIntegration', () => {
  it('explains that a failed candidate means the safety gate worked and base was untouched', () => {
    const view = presentCrewIntegration(record('failed', 'checking'))
    expect(view.badge).toBe('Candidate rejected')
    expect(view.progress).toBe('Stopped at: Running project checks')
    expect(view.summary).toContain('completed the safety check')
    expect(view.summary).toContain('Nothing was applied')
  })

  it('reserves positive language for a candidate that can be applied', () => {
    const view = presentCrewIntegration(record('passed', 'ready'))
    expect(view.badge).toBe('Ready to apply')
    expect(view.heading).toBe('Combined candidate verified')
  })

  it('does not imply an interrupted operation survived restart', () => {
    const view = presentCrewIntegration(record('interrupted', 'checking'))
    expect(view.badge).toBe('Interrupted')
    expect(view.summary).toContain('No successful result is being assumed')
  })
})

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
  it('prompts the operator to verify the selected lane subset', () => {
    const view = presentCrewIntegration(null)
    expect(view.verifyLabel).toBe('Verify selected lanes')
    expect(view.nextStep).toContain('Select one or more')
  })

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

  it('surfaces a base-change restoration warning after the integration was applied', () => {
    const applied = record('applied', 'complete')
    applied.error = 'recovery stash abc was retained'
    const view = presentCrewIntegration(applied)
    expect(view.badge).toContain('restore needs attention')
    expect(view.summary).toContain('recovery stash was retained')
    expect(view.nextStep).toContain('do not reapply')
  })

  it('does not imply an interrupted operation survived restart', () => {
    const view = presentCrewIntegration(record('interrupted', 'checking'))
    expect(view.badge).toBe('Interrupted')
    expect(view.summary).toContain('No successful result is being assumed')
  })

  it('warns when a token-matched interrupted check is still executing', () => {
    const interrupted = record('interrupted', 'checking')
    interrupted.checks = [{
      id: 'test', label: 'tests', command: 'npm test', script: 'vitest', status: 'interrupted', output: '',
      execution: { token: 'token', pid: 42, state: 'running' },
    }]
    const view = presentCrewIntegration(interrupted)
    expect(view.summary).toContain('still executing')
    expect(view.verifyLabel).toBe('Check process still running')
  })
})

import type { CrewIntegrationRecord } from '../types'

export type IntegrationTone = 'idle' | 'running' | 'rejected' | 'attention' | 'ready' | 'applied'

export interface IntegrationPresentation {
  tone: IntegrationTone
  badge: string
  heading: string
  summary: string
  progress?: string
  nextStep: string
  verifyLabel: string
}

const PHASE_LABELS: Record<CrewIntegrationRecord['phase'], string> = {
  preflight: 'Checking repository state',
  combining: 'Combining lane commits',
  checking: 'Running project checks',
  ready: 'Verification complete',
  applying: 'Applying verified commit',
  complete: 'Complete',
}

/** Plain-language copy that separates candidate results from CrewCode operation. */
export function presentCrewIntegration(record: CrewIntegrationRecord | null): IntegrationPresentation {
  if (!record) return {
    tone: 'idle', badge: 'Not verified', heading: 'Combined verification',
    summary: 'No combined candidate has been checked yet. Your base branch has not been changed.',
    nextStep: 'Verify all committed lane changes together before applying anything to the base branch.',
    verifyLabel: 'Verify combined lanes',
  }

  switch (record.status) {
    case 'running':
      return {
        tone: 'running', badge: 'In progress', heading: 'Verifying combined candidate',
        summary: 'CrewCode is building and checking a disposable combined worktree. The base branch is unchanged.',
        progress: PHASE_LABELS[record.phase], nextStep: 'Wait for combination and project checks to finish.',
        verifyLabel: 'Verifying combined lanes…',
      }
    case 'passed':
      return {
        tone: 'ready', badge: 'Ready to apply', heading: 'Combined candidate verified',
        summary: 'All discovered checks passed against the exact combined commit. The base branch is still unchanged.',
        progress: PHASE_LABELS[record.phase], nextStep: 'Review the evidence, then apply the verified commit to the base branch.',
        verifyLabel: 'Verify again',
      }
    case 'applied':
      return {
        tone: 'applied', badge: 'Applied', heading: 'Verified integration applied',
        summary: 'The exact combined commit that passed verification was applied to the base branch.',
        progress: PHASE_LABELS[record.phase], nextStep: 'No merge action is required.',
        verifyLabel: 'Verify current lanes',
      }
    case 'failed':
      return {
        tone: 'rejected', badge: 'Candidate rejected', heading: 'Combined candidate did not pass',
        summary: 'CrewCode completed the safety check and rejected these lane commits because a project check or preflight requirement failed. Nothing was applied to the base branch.',
        progress: `Stopped at: ${PHASE_LABELS[record.phase]}`,
        nextStep: 'Inspect the failure below, fix and commit the affected lane, refresh, then verify again.',
        verifyLabel: 'Verify combined lanes again',
      }
    case 'conflict':
      return {
        tone: 'rejected', badge: 'Candidate rejected', heading: 'Lane commits could not be combined',
        summary: 'The disposable integration worktree hit a Git conflict. Nothing was applied to the base branch.',
        progress: `Stopped at: ${PHASE_LABELS[record.phase]}`,
        nextStep: 'Resolve the conflicting intent in a lane, commit it, refresh, then verify again.',
        verifyLabel: 'Verify combined lanes again',
      }
    case 'stale':
      return {
        tone: 'attention', badge: 'Verification expired', heading: 'Candidate inputs changed',
        summary: 'The base, a lane commit, or the retained candidate moved after verification. CrewCode will not apply stale evidence.',
        nextStep: 'Refresh and verify the current commits again.',
        verifyLabel: 'Verify current commits',
      }
    case 'interrupted': {
      const executing = record.checks.some(check => check.status === 'interrupted' && check.execution?.state === 'running')
      const unresolved = record.checks.some(check => check.status === 'interrupted' && check.execution?.state === 'unknown')
      return {
        tone: 'attention', badge: 'Interrupted', heading: 'Verification was interrupted',
        summary: executing
          ? 'CrewCode restarted, but a custody-token probe shows an interrupted project check is still executing. No successful result is being assumed.'
          : unresolved
            ? 'CrewCode restarted and could not prove that an interrupted project check exited. No successful result or stopped process is being assumed.'
            : 'CrewCode restarted or stopped before this operation completed. No successful result is being assumed.',
        progress: `Interrupted during: ${PHASE_LABELS[record.phase]}`,
        nextStep: executing || unresolved
          ? 'Resolve or wait for the interrupted check process, refresh this evidence, then verify again.'
          : 'Verify the current commits again to produce fresh evidence.',
        verifyLabel: executing ? 'Check process still running' : unresolved ? 'Process state unresolved' : 'Restart verification',
      }
    }
  }
}

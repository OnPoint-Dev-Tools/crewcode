import { describe, expect, it } from 'vitest'

import type { Message, ToolCallMessage, ToolCallStatus, UserMessage } from '../../types'
import {
  CREWCODER_APPROVE_PLAN_PROMPT,
  isCrewCoderPlanApprovalMessage,
  latestCrewCoderPlanGate,
} from './crewcoder-plan-gate'

function user(text: string, speaker?: string): UserMessage {
  return { kind: 'user', text, time: '', speaker }
}

function tool(
  toolName: string,
  args: unknown,
  status: ToolCallStatus = 'completed',
  result?: unknown,
  extra: Partial<ToolCallMessage> = {},
): ToolCallMessage {
  return { kind: 'toolcall', time: '', turnId: 't', toolCallId: 'c', toolName, args, status, result, ...extra }
}

describe('isCrewCoderPlanApprovalMessage', () => {
  it('accepts CrewCoder TUI /approve-plan and short unambiguous approvals', () => {
    expect(isCrewCoderPlanApprovalMessage('/approve-plan')).toBe(true)
    expect(isCrewCoderPlanApprovalMessage('approve')).toBe(true)
    expect(isCrewCoderPlanApprovalMessage('lgtm')).toBe(true)
    expect(isCrewCoderPlanApprovalMessage('yes')).toBe(true)
  })

  it('treats a revision that starts with yes as a revision', () => {
    expect(isCrewCoderPlanApprovalMessage('yes, but also add logging')).toBe(false)
  })
})

describe('latestCrewCoderPlanGate', () => {
  it('shows clarification questions after crewcoder_clarify settles', () => {
    expect(latestCrewCoderPlanGate([
      user('add audit logs'),
      tool('crewcoder_clarify', { questions: ['Which store owns the logs?', 'JSON or text?'] }),
    ])).toEqual({
      phase: 'awaiting_answers',
      questions: ['Which store owns the logs?', 'JSON or text?'],
    })
  })

  it('hides the gate after the user answers clarification', () => {
    expect(latestCrewCoderPlanGate([
      user('add audit logs'),
      tool('crewcoder_clarify', { questions: ['JSON or text?'] }),
      user('JSON'),
    ])).toBeNull()
  })

  it('shows the proposed plan until the user replies', () => {
    expect(latestCrewCoderPlanGate([
      user('add audit logs'),
      tool('crewcoder_clarify', { questions: ['JSON or text?'] }),
      user('JSON'),
      tool('crewcoder_propose_plan', {
        requirements: 'Add JSON audit logs.',
        plan: '1. Write the writer\n2. Wire the hook',
        acceptanceCriteria: 'A JSON line is emitted per request.',
      }),
    ])).toEqual({
      phase: 'awaiting_approval',
      requirements: 'Add JSON audit logs.',
      plan: '1. Write the writer\n2. Wire the hook',
      acceptanceCriteria: 'A JSON line is emitted per request.',
    })
  })

  it('reads plan fields from ACP rawOutput when args are empty', () => {
    expect(latestCrewCoderPlanGate([
      tool('crewcoder_propose_plan', {}, 'completed', {
        output: 'Plan proposed.',
        requirements: 'Keep the API stable.',
        plan: 'Add a test first.',
        acceptanceCriteria: 'Existing tests pass.',
        phase: 'awaiting_approval',
      }),
    ])).toEqual({
      phase: 'awaiting_approval',
      requirements: 'Keep the API stable.',
      plan: 'Add a test first.',
      acceptanceCriteria: 'Existing tests pass.',
    })
  })

  it('matches the tool from a title when ACP kind collapsed the name', () => {
    expect(latestCrewCoderPlanGate([
      tool('think', {}, 'completed', { questions: ['Confirm scope?'] }, { title: 'crewcoder_clarify' }),
    ])).toEqual({
      phase: 'awaiting_answers',
      questions: ['Confirm scope?'],
    })
  })

  it('hides the card after /approve-plan or a revision', () => {
    const proposed: Message[] = [
      tool('crewcoder_propose_plan', {
        requirements: 'Add logs.',
        plan: 'Write writer.ts',
        acceptanceCriteria: 'A log line exists.',
      }),
    ]
    expect(latestCrewCoderPlanGate([...proposed, user(CREWCODER_APPROVE_PLAN_PROMPT)])).toBeNull()
    expect(latestCrewCoderPlanGate([...proposed, user('yes, but also add logging')])).toBeNull()
  })

  it('offers the revised plan after a later propose_plan', () => {
    expect(latestCrewCoderPlanGate([
      tool('crewcoder_propose_plan', {
        requirements: 'Add logs.',
        plan: 'Write writer.ts',
        acceptanceCriteria: 'A log line exists.',
      }),
      user('yes, but also add logging'),
      tool('crewcoder_propose_plan', {
        requirements: 'Add logs plus a logger call.',
        plan: 'Write writer.ts and log.ts',
        acceptanceCriteria: 'A log line exists.',
      }),
    ])?.phase).toBe('awaiting_approval')
  })

  it('ignores incomplete, failed, or supervisor-relayed messages', () => {
    expect(latestCrewCoderPlanGate([
      tool('crewcoder_clarify', { questions: ['JSON or text?'] }, 'running'),
    ])).toBeNull()
    expect(latestCrewCoderPlanGate([
      tool('crewcoder_propose_plan', {
        requirements: 'Add logs.',
        plan: 'Write writer.ts',
        acceptanceCriteria: 'A log line exists.',
      }, 'completed', undefined, { isError: true }),
    ])).toBeNull()
    expect(latestCrewCoderPlanGate([
      tool('crewcoder_clarify', { questions: ['JSON or text?'] }),
      user('JSON', 'worker-1'),
    ])).toEqual({
      phase: 'awaiting_answers',
      questions: ['JSON or text?'],
    })
  })

  it('does not treat a generic plan-array todo tool as CrewCoder plan approval', () => {
    expect(latestCrewCoderPlanGate([
      tool('update_plan', {
        plan: [{ step: 'Explore', status: 'completed' }],
      }),
    ])).toBeNull()
  })
})

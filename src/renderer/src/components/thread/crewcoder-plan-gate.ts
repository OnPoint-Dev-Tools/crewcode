import type { Message, ToolCallMessage } from '../../types'

export const CREWCODER_APPROVE_PLAN_PROMPT = '/approve-plan'

export type CrewCoderPlanGate =
  | { phase: 'awaiting_answers'; questions: string[] }
  | {
      phase: 'awaiting_approval'
      requirements: string
      plan: string
      acceptanceCriteria: string
    }

// Matches CrewCoder's runtime gate: only these whole-message replies approve a
// proposed plan. "yes, but also add logging" is a revision, not approval.
const APPROVAL_MESSAGE_RE = /^(?:\/approve-plan|approve-plan|approve(?:d)?|lgtm|looks good(?: to me)?|go(?: ahead)?|do it|ship it|yes|y|ok(?:ay)?)\.?$/i

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => stringValue(item)).filter(Boolean)
}

function compactToolLabel(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function workflowTool(msg: ToolCallMessage): 'clarify' | 'propose_plan' | null {
  const label = compactToolLabel(msg.toolName) + compactToolLabel(msg.title)
  if (label.includes('crewcoderclarify')) return 'clarify'
  if (label.includes('crewcoderproposeplan')) return 'propose_plan'
  return null
}

function payload(msg: ToolCallMessage): Record<string, unknown> {
  return {
    ...asRecord(msg.args),
    ...asRecord(msg.result),
  }
}

export function isCrewCoderPlanApprovalMessage(text: string): boolean {
  return APPROVAL_MESSAGE_RE.test(text.trim())
}

/**
 * Reconstruct CrewCoder-mode clarify/plan state from the local transcript.
 * The runtime gate lives in CrewCoder; this is a passive UI projection.
 * A later user message after a proposed plan hides the card whether that
 * message approved or revised — revisions must be re-proposed before approve
 * is offered again.
 */
export function latestCrewCoderPlanGate(messages: Message[]): CrewCoderPlanGate | null {
  let gate: CrewCoderPlanGate | null = null

  for (const msg of messages) {
    if (msg.kind === 'user') {
      if (msg.speaker) continue
      if (!gate) continue
      gate = null
      continue
    }
    if (msg.kind !== 'toolcall' || msg.isError || msg.status !== 'completed') continue
    const tool = workflowTool(msg)
    if (!tool) continue
    const data = payload(msg)
    if (tool === 'clarify') {
      const questions = stringList(data.questions)
      if (questions.length === 0) continue
      gate = { phase: 'awaiting_answers', questions }
      continue
    }
    const requirements = stringValue(data.requirements)
    const plan = stringValue(data.plan)
    const acceptanceCriteria = stringValue(data.acceptanceCriteria)
    if (!requirements || !plan || !acceptanceCriteria) continue
    gate = { phase: 'awaiting_approval', requirements, plan, acceptanceCriteria }
  }

  return gate
}

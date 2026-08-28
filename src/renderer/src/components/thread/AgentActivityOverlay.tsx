import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircleIcon,
  CheckSquareIcon,
  CaretDownIcon,
  ChatTextIcon,
  CircleIcon,
  HourglassHighIcon,
  ListChecksIcon,
  ListIcon,
  SpinnerIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { AgentUserRequest, AgentUserResponse } from '../../types'
import { isBlockedTodo, todoDisplayLabel, type TodoItem } from './TurnWorkLog'
import { AgentRequestCard } from './AgentRequestCard'
import { useSettings } from '../../hooks/useSettings'
import type { CrewCoderPlanGate } from './crewcoder-plan-gate'

interface AgentActivityOverlayProps {
  /** Active todos from an agent TodoWrite tool call. */
  todos: TodoItem[]
  /** Whether the owning tool call/turn is still active. */
  isStreaming: boolean
  /** Provider pause that needs a human answer before the same turn can resume. */
  request?: AgentUserRequest
  /** Sends the human answer back to the bridge/provider. */
  onRespond?: (response: AgentUserResponse) => void | Promise<unknown>
  /** CrewCoder-mode clarify/plan gate. Not a tool-permission request. */
  planGate?: CrewCoderPlanGate | null
  /** Sends `/approve-plan` as a prompt or follow-up. */
  onApprovePlan?: () => void
  /** Optional dismissal for completed inline activity. */
  onDismiss?: () => void
}

export function shouldShowAgentActivity(
  showTodoActivity: boolean,
  todoCount: number,
  hasRequest: boolean,
  hasPlanGate = false,
): boolean {
  // Requests and CrewCoder plan gates can pause work, so Todo activity off must never hide them.
  return hasRequest || hasPlanGate || (showTodoActivity && todoCount > 0)
}

/**
 * Converted from the Tailwind design in `.design/AgentActivityOverlay.tsx`.
 * This inline variant keeps chat history stable while still showing live task progress.
 */
export function AgentActivityOverlay({ todos, isStreaming, request, onRespond, planGate, onApprovePlan, onDismiss }: AgentActivityOverlayProps) {
  const { state: settings } = useSettings()
  const [isExpanded, setIsExpanded] = useState(isStreaming)
  const [dismissed, setDismissed] = useState(false)
  const [planSent, setPlanSent] = useState(false)
  const visibleTodos = settings.showTodoActivity ? todos : []
  const planKey = planGate
    ? planGate.phase === 'awaiting_answers'
      ? planGate.questions.join('\0')
      : `${planGate.requirements}\0${planGate.plan}\0${planGate.acceptanceCriteria}`
    : ''

  useEffect(() => {
    setIsExpanded(true)
  }, [request?.requestId])

  useEffect(() => {
    setPlanSent(false)
  }, [planKey])

  const completedCount = useMemo(
    () => visibleTodos.filter(todo => todo.status === 'completed').length,
    [visibleTodos],
  )
  const cancelledCount = useMemo(
    () => visibleTodos.filter(todo => todo.status === 'cancelled').length,
    [visibleTodos],
  )
  const activeText = visibleTodos.find(todo => todo.status === 'in_progress')?.activeForm
    ?? visibleTodos.find(todo => todo.status === 'in_progress')?.text
    ?? visibleTodos.find(todo => todo.status === 'pending')?.text

  if (request) {
    return (
      <div className="agent-activity agent-activity-request">
        <AgentRequestCard request={request} onRespond={onRespond} />
      </div>
    )
  }

  if (planGate) {
    return (
      <div className="agent-activity agent-activity-plan">
        <CrewCoderPlanGateCard
          gate={planGate}
          sent={planSent}
          onApprove={() => {
            if (planSent || !onApprovePlan) return
            setPlanSent(true)
            onApprovePlan()
          }}
        />
      </div>
    )
  }

  if (dismissed || !shouldShowAgentActivity(settings.showTodoActivity, todos.length, false, false)) return null

  const allComplete = completedCount === visibleTodos.length
  const allSettled = completedCount + cancelledCount === visibleTodos.length
  const progress = Math.round((completedCount / visibleTodos.length) * 100)

  return (
    <div className="agent-activity">
      <div className="agent-activity-card">
        <button
          type="button"
          className="agent-activity-header"
          onClick={() => setIsExpanded(open => !open)}
          aria-expanded={isExpanded}
        >
          <span className="agent-activity-title-group">
            <span className="agent-activity-icon-wrap">
              {isStreaming ? (
                <SpinnerIcon className="agent-activity-icon spin" />
              ) : (
                <CheckSquareIcon className="agent-activity-icon done" />
              )}
              {isStreaming || (!isStreaming && allComplete) ? (
                <span className="agent-activity-ping" />
              ) : null}
            </span>
            <span className="agent-activity-title">
              {isStreaming ? (
                <span className="agent-activity-working">
                  agent working
                  <HourglassHighIcon className="agent-activity-hourglass" />
                </span>
              ) : allComplete ? 'tasks complete' : allSettled ? 'activity stopped' : 'tasks updated'}
            </span>
            <span className="agent-activity-count">{completedCount}/{visibleTodos.length}</span>
          </span>
          <span className="agent-activity-actions">
            {!isStreaming && onDismiss ? (
              <span
                role="button"
                tabIndex={0}
                className="agent-activity-dismiss"
                onClick={(event) => {
                  event.stopPropagation()
                  setDismissed(true)
                  onDismiss()
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  event.stopPropagation()
                  setDismissed(true)
                  onDismiss()
                }}
                aria-label="dismiss task activity"
              >
                <XIcon size={14} />
              </span>
            ) : null}
            <CaretDownIcon className={`agent-activity-chevron ${isExpanded ? 'open' : ''}`} />
          </span>
        </button>

        {isExpanded ? (
          <div className="agent-activity-content">
            <div className="agent-activity-list-title">
              <ListIcon size={14} />
              <span>current tasks</span>
            </div>
            <div className="agent-activity-list">
              {visibleTodos.map((todo, index) => (
                <TodoActivityItem
                  key={`${todo.text}-${index}`}
                  todo={todo}
                  isActive={isStreaming && todo.status === 'in_progress'}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="agent-activity-preview">
            <div className="agent-activity-progress-row">
              <div className="agent-activity-progress-track">
                <div className="agent-activity-progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <span className="agent-activity-progress-label">{progress}%</span>
            </div>
            {activeText ? (
              <div className="agent-activity-active-text">{activeText}</div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

interface TodoActivityItemProps {
  todo: TodoItem
  isActive: boolean
}

function TodoActivityItem({ todo, isActive }: TodoActivityItemProps) {
  const label = todoDisplayLabel(todo)
  const blocked = isBlockedTodo(todo)
  const hints = [todo.owner ? `owner=${todo.owner}` : '', blocked ? `blockedBy=${todo.blockedBy!.join(',')}` : ''].filter(Boolean).join(' ')

  return (
    <div className={`agent-activity-item agent-activity-item-${todo.status} ${isActive ? 'active' : ''}`}>
      <span className="agent-activity-item-icon">
        {todo.status === 'completed' ? (
          <CheckCircleIcon size={16} />
        ) : todo.status === 'cancelled' ? (
          <CircleIcon size={16} />
        ) : todo.status === 'in_progress' ? (
          <span className="agent-activity-spinner-wrap">
            <span className="agent-activity-spinner-ping" />
            <SpinnerIcon size={16} className="spin" />
          </span>
        ) : blocked ? (
          <span className="agent-activity-blocked-mark">!</span>
        ) : (
          <span className="agent-activity-pending-dot-wrap">
            <CircleIcon size={16} />
            <span className="agent-activity-pending-dot" />
          </span>
        )}
      </span>
      {todo.displayNumber !== undefined ? <span className="agent-activity-task-number">#{todo.displayNumber}</span> : null}
      <span className="agent-activity-item-text">{label}</span>
      {hints ? <span className="agent-activity-task-hints">{hints}</span> : null}
      {isActive ? (
        <span className="agent-activity-working-chip">
          <span className="agent-activity-working-dot" />
          <span>working</span>
          <span className="agent-activity-dots"><span>.</span><span>.</span><span>.</span></span>
        </span>
      ) : null}
    </div>
  )
}

interface CrewCoderPlanGateCardProps {
  gate: CrewCoderPlanGate
  sent: boolean
  onApprove: () => void
}

function CrewCoderPlanGateCard({ gate, sent, onApprove }: CrewCoderPlanGateCardProps) {
  const awaitingApproval = gate.phase === 'awaiting_approval'

  return (
    <div className="agent-activity-card">
      <div className="agent-activity-header agent-activity-request-header">
        <span className="agent-activity-title-group">
          <span className="agent-activity-icon-wrap">
            {awaitingApproval ? <ListChecksIcon className="agent-activity-icon" /> : <ChatTextIcon className="agent-activity-icon" />}
            <span className="agent-activity-ping" />
          </span>
          <span className="agent-activity-title">
            {awaitingApproval ? 'Approve plan' : 'Clarification needed'}
          </span>
          <span className="agent-activity-count">crewcoder</span>
        </span>
      </div>
      <div className="agent-activity-content agent-request-content">
        {gate.phase === 'awaiting_answers' ? (
          <>
            <ol className="agent-plan-questions">
              {gate.questions.map((question, index) => (
                <li key={`${index}-${question}`}>{question}</li>
              ))}
            </ol>
            <div className="agent-plan-hint">Reply in the composer. Answering a question is not plan approval.</div>
          </>
        ) : (
          <>
            <PlanSection label="requirements" text={gate.requirements} />
            <PlanSection label="plan" text={gate.plan} />
            <PlanSection label="acceptance" text={gate.acceptanceCriteria} />
            <div className="agent-plan-hint">Approve this plan, or describe revisions in the composer.</div>
            <div className="agent-request-actions">
              <button
                type="button"
                className="agent-request-btn primary"
                disabled={sent}
                onClick={onApprove}
              >
                {sent ? 'approving…' : 'approve plan'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function PlanSection({ label, text }: { label: string; text: string }) {
  return (
    <div className="agent-plan-section">
      <div className="agent-plan-section-label">{label}</div>
      <pre className="agent-request-detail">{text}</pre>
    </div>
  )
}

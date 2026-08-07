import { useEffect, useMemo, useState } from 'react'
import {
  CheckCircleIcon,
  CheckSquareIcon,
  CaretDownIcon,
  CircleIcon,
  HourglassHighIcon,
  ListIcon,
  SpinnerIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { AgentUserRequest, AgentUserResponse } from '../../types'
import type { TodoItem } from './TurnWorkLog'
import { AgentRequestCard } from './AgentRequestCard'
import { useSettings } from '../../hooks/useSettings'

interface AgentActivityOverlayProps {
  /** Active todos from an agent TodoWrite tool call. */
  todos: TodoItem[]
  /** Whether the owning tool call/turn is still active. */
  isStreaming: boolean
  /** Provider pause that needs a human answer before the same turn can resume. */
  request?: AgentUserRequest
  /** Sends the human answer back to the bridge/provider. */
  onRespond?: (response: AgentUserResponse) => void | Promise<unknown>
  /** Optional dismissal for completed inline activity. */
  onDismiss?: () => void
}

export function shouldShowAgentActivity(
  showTodoActivity: boolean,
  todoCount: number,
  hasRequest: boolean,
): boolean {
  // Requests can pause the provider, so presentation preferences must never hide them.
  return hasRequest || (showTodoActivity && todoCount > 0)
}

/**
 * Converted from the Tailwind design in `.design/AgentActivityOverlay.tsx`.
 * This inline variant keeps chat history stable while still showing live task progress.
 */
export function AgentActivityOverlay({ todos, isStreaming, request, onRespond, onDismiss }: AgentActivityOverlayProps) {
  const { state: settings } = useSettings()
  const [isExpanded, setIsExpanded] = useState(isStreaming)
  const [dismissed, setDismissed] = useState(false)
  const visibleTodos = settings.showTodoActivity ? todos : []

  useEffect(() => {
    setIsExpanded(true)
  }, [request?.requestId])

  const completedCount = useMemo(
    () => visibleTodos.filter(todo => todo.status === 'completed').length,
    [visibleTodos],
  )
  const inProgressCount = useMemo(
    () => visibleTodos.filter(todo => todo.status === 'in_progress').length,
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

  if (dismissed || !shouldShowAgentActivity(settings.showTodoActivity, todos.length, false)) return null

  const allComplete = completedCount === visibleTodos.length
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
              {isStreaming && inProgressCount > 0 ? (
                <SpinnerIcon className="agent-activity-icon spin" />
              ) : (
                <CheckSquareIcon className="agent-activity-icon done" />
              )}
              {(isStreaming && inProgressCount > 0) || (!isStreaming && allComplete) ? (
                <span className="agent-activity-ping" />
              ) : null}
            </span>
            <span className="agent-activity-title">
              {isStreaming ? (
                <span className="agent-activity-working">
                  agent working
                  <HourglassHighIcon className="agent-activity-hourglass" />
                </span>
              ) : allComplete ? 'tasks complete' : 'tasks updated'}
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
  const label = todo.status === 'in_progress' ? (todo.activeForm ?? todo.text) : todo.text

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
        ) : (
          <span className="agent-activity-pending-dot-wrap">
            <CircleIcon size={16} />
            <span className="agent-activity-pending-dot" />
          </span>
        )}
      </span>
      <span className="agent-activity-item-text">{label}</span>
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

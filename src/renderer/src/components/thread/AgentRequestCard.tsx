import { useEffect, useState } from 'react'
import { WarningIcon, ChatTextIcon, ShieldCheckIcon } from '@phosphor-icons/react'
import type { AgentUserRequest, AgentUserResponse } from '../../types'

interface AgentRequestCardProps {
  /** Provider pause that needs a human answer before the same turn can resume. */
  request: AgentUserRequest
  /** Sends the human answer back to the bridge/provider. */
  onRespond?: (response: AgentUserResponse) => void | Promise<unknown>
  /** Dense variant for the menulet / mission-control card surfaces. */
  compact?: boolean
}

/**
 * Renders one interactive agent pause (permission / question / select / editor)
 * with allow/deny/option/submit controls. Shared by the inline chat overlay,
 * Mission Control cards, and the menulet so a request can be answered from any
 * surface and resolves the same `requestId` everywhere.
 */
export function AgentRequestCard({ request, onRespond, compact }: AgentRequestCardProps) {
  const [input, setInput] = useState(request.defaultValue ?? '')

  useEffect(() => {
    setInput(request.defaultValue ?? '')
  }, [request.requestId, request.defaultValue])

  const needsText = request.kind === 'prompt' || request.kind === 'editor'
  const hasOptions = !!request.options?.length
  const showSubmitButton = needsText || !hasOptions
  const send = (response: Omit<AgentUserResponse, 'requestId'>): void => {
    void onRespond?.({ requestId: request.requestId, ...response })
  }

  return (
    <div className={`agent-activity-card ${request.dangerous ? 'agent-activity-card-danger' : ''}${compact ? ' agent-activity-card-compact' : ''}`}>
      <div className="agent-activity-header agent-activity-request-header">
        <span className="agent-activity-title-group">
          <span className="agent-activity-icon-wrap">
            {request.dangerous ? <WarningIcon className="agent-activity-icon danger" /> : request.kind === 'permission' ? <ShieldCheckIcon className="agent-activity-icon" /> : <ChatTextIcon className="agent-activity-icon" />}
            <span className="agent-activity-ping" />
          </span>
          <span className="agent-activity-title">
            {request.kind === 'permission' ? 'Permission Required' : 'Agent Questions'}
          </span>
          {request.source ? <span className="agent-activity-count">{request.source}</span> : null}
        </span>
      </div>
      <div className="agent-activity-content agent-request-content">
        <div className="agent-request-title">{request.title}</div>
        {request.message ? <div className="agent-request-message">{request.message}</div> : null}
        {request.detail ? <pre className="agent-request-detail">{request.detail}</pre> : null}
        {needsText ? (
          request.kind === 'editor' ? (
            <textarea
              className="agent-request-input agent-request-textarea"
              value={input}
              onChange={event => setInput(event.target.value)}
              placeholder={request.placeholder ?? 'reply to the agent…'}
              autoFocus
            />
          ) : (
            <input
              className="agent-request-input"
              value={input}
              onChange={event => setInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') send({ action: 'submit', value: input })
              }}
              placeholder={request.placeholder ?? 'reply to the agent…'}
              autoFocus
            />
          )
        ) : null}
        {hasOptions ? (
          <div className="agent-request-options">
            {request.options?.map(option => (
              <button key={option.id} type="button" className="agent-request-option" onClick={() => send({ action: 'submit', optionId: option.id })}>
                <span>{option.label}</span>
                {option.description ? <small>{option.description}</small> : null}
              </button>
            ))}
          </div>
        ) : null}
        <div className="agent-request-actions">
          {request.kind === 'permission' ? (
            <>
              <button type="button" className="agent-request-btn ghost" onClick={() => send({ action: 'decline' })}>deny</button>
              <button type="button" className="agent-request-btn primary" onClick={() => send({ action: 'accept' })}>allow</button>
              {request.allowAllForTurn ? (
                <button
                  type="button"
                  className="agent-request-btn primary allow-all"
                  title="Allow this and all later tool requests in the current agent turn"
                  onClick={() => send({ action: 'accept_for_turn' })}
                >
                  allow all (this turn ONLY)
                </button>
              ) : null}
            </>
          ) : (
            <>
              <button type="button" className="agent-request-btn ghost" onClick={() => send({ action: 'cancel' })}>cancel</button>
              {showSubmitButton ? <button type="button" className="agent-request-btn primary" onClick={() => send({ action: 'submit', value: input })}>send</button> : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

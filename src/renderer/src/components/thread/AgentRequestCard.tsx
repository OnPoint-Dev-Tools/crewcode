import { useEffect, useState } from 'react'
import { WarningIcon, ChatTextIcon, ShieldCheckIcon, CheckIcon } from '@phosphor-icons/react'
import type { AgentUserRequest, AgentUserResponse } from '../../types'

interface AgentRequestCardProps {
  /** Provider pause that needs a human answer before the same turn can resume. */
  request: AgentUserRequest
  /** Sends the human answer back to the bridge/provider. */
  onRespond?: (response: AgentUserResponse) => void | Promise<unknown>
  /** Dense variant for the menulet / mission-control card surfaces. */
  compact?: boolean
}

type RequestOption = NonNullable<AgentUserRequest['options']>[number]

/** Short, description-free choices (Yes/No, Allow/Skip) read best as one row of buttons. */
export function isInlineChoiceSet(options: readonly RequestOption[]): boolean {
  return options.length >= 2
    && options.length <= 4
    && options.every(option => !option.description && option.label.length <= 16)
}

/**
 * Renders one interactive agent pause (permission / question / select / editor)
 * with allow/deny/option/submit controls. Shared by the inline chat overlay,
 * Mission Control cards, and the menulet so a request can be answered from any
 * surface and resolves the same `requestId` everywhere.
 *
 * Question shapes:
 * - options only       -> one button per option; a click answers immediately.
 * - options + multiple -> toggle buttons, answered with the send button.
 * - free text          -> input + send button (alongside options when the
 *                         provider accepts a typed "other" answer).
 */
export function AgentRequestCard({ request, onRespond, compact }: AgentRequestCardProps) {
  const [input, setInput] = useState(request.defaultValue ?? '')
  const [toggled, setToggled] = useState<string[]>([])
  const [sent, setSent] = useState(false)

  useEffect(() => {
    setInput(request.defaultValue ?? '')
    setToggled([])
    setSent(false)
  }, [request.requestId, request.defaultValue])

  const isPermission = request.kind === 'permission'
  const needsText = request.kind === 'prompt' || request.kind === 'editor'
  const options = request.options ?? []
  const hasOptions = options.length > 0
  const multiple = !isPermission && hasOptions && request.multiple === true
  const showSubmitButton = needsText || multiple || !hasOptions
  const typed = input.trim()
  const canSubmit = !sent && (typed.length > 0 || (multiple && toggled.length > 0) || (!needsText && !hasOptions))

  const send = (response: Omit<AgentUserResponse, 'requestId'>): void => {
    if (sent || !onRespond) return
    setSent(true)
    // Unlock only on an observed failure so the human can retry; success is
    // confirmed by the request resolving and the card unmounting.
    Promise.resolve(onRespond({ requestId: request.requestId, ...response }))
      .then(result => {
        if (result && typeof result === 'object' && 'error' in result && (result as { error?: unknown }).error) setSent(false)
      })
      .catch(() => setSent(false))
  }
  const submit = (): void => {
    if (!canSubmit) return
    if (multiple) {
      // Keep option order stable regardless of click order.
      const optionIds = options.map(option => option.id).filter(id => toggled.includes(id))
      send({ action: 'submit', optionIds, ...(typed ? { value: typed } : {}) })
      return
    }
    send({ action: 'submit', value: input })
  }
  const toggle = (id: string): void => {
    setToggled(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  }

  const optionButtons = hasOptions && !isPermission ? (
    <div className={`agent-request-options${isInlineChoiceSet(options) && !multiple ? ' agent-request-options-inline' : ''}`}>
      {options.map(option => {
        const selected = multiple && toggled.includes(option.id)
        return (
          <button
            key={option.id}
            type="button"
            className={`agent-request-option${selected ? ' selected' : ''}`}
            disabled={sent}
            aria-pressed={multiple ? selected : undefined}
            onClick={() => (multiple ? toggle(option.id) : send({ action: 'submit', optionId: option.id }))}
          >
            <span className="agent-request-option-label">
              {multiple ? <span className="agent-request-check" aria-hidden>{selected ? <CheckIcon weight="bold" /> : null}</span> : null}
              {option.label}
            </span>
            {option.description ? <small>{option.description}</small> : null}
          </button>
        )
      })}
    </div>
  ) : null

  const textInput = needsText ? (
    request.kind === 'editor' ? (
      <textarea
        className="agent-request-input agent-request-textarea"
        value={input}
        onChange={event => setInput(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder={request.placeholder ?? 'reply to the agent…'}
        disabled={sent}
        autoFocus
      />
    ) : (
      <input
        className="agent-request-input"
        type={request.secret ? 'password' : 'text'}
        autoComplete={request.secret ? 'off' : undefined}
        value={input}
        onChange={event => setInput(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit()
          }
        }}
        placeholder={request.placeholder ?? 'reply to the agent…'}
        disabled={sent}
        // Options are the primary answer; don't steal focus from them.
        autoFocus={!hasOptions}
      />
    )
  ) : null

  return (
    <div className={`agent-activity-card ${request.dangerous ? 'agent-activity-card-danger' : ''}${compact ? ' agent-activity-card-compact' : ''}`}>
      <div className="agent-activity-header agent-activity-request-header">
        <span className="agent-activity-title-group">
          <span className="agent-activity-icon-wrap">
            {request.dangerous ? <WarningIcon className="agent-activity-icon danger" /> : isPermission ? <ShieldCheckIcon className="agent-activity-icon" /> : <ChatTextIcon className="agent-activity-icon" />}
            <span className="agent-activity-ping" />
          </span>
          <span className="agent-activity-title">
            {isPermission ? 'Permission Required' : 'Agent Questions'}
          </span>
          {request.source ? <span className="agent-activity-count">{request.source}</span> : null}
        </span>
      </div>
      <div className="agent-activity-content agent-request-content">
        <div className="agent-request-title">{request.title}</div>
        {request.message ? <div className="agent-request-message">{request.message}</div> : null}
        {request.detail ? <pre className="agent-request-detail">{request.detail}</pre> : null}
        {optionButtons}
        {textInput}
        <div className="agent-request-actions">
          {isPermission ? (
            <>
              <button type="button" className="agent-request-btn ghost" disabled={sent} onClick={() => send({ action: 'decline' })}>deny</button>
              <button type="button" className="agent-request-btn primary" disabled={sent} onClick={() => send({ action: 'accept' })}>allow</button>
              {request.allowAllForTurn ? (
                <button
                  type="button"
                  className="agent-request-btn primary allow-all"
                  title="Allow this and all later tool requests in the current agent turn"
                  disabled={sent}
                  onClick={() => send({ action: 'accept_for_turn' })}
                >
                  allow all (this turn ONLY)
                </button>
              ) : null}
            </>
          ) : (
            <>
              <button type="button" className="agent-request-btn ghost" disabled={sent} onClick={() => send({ action: 'cancel' })}>cancel</button>
              {showSubmitButton ? (
                <button type="button" className="agent-request-btn primary" disabled={!canSubmit} onClick={submit}>
                  {sent ? 'sending…' : 'send reply'}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

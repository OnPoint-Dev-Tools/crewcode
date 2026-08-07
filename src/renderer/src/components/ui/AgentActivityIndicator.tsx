import { CheckCircleIcon } from '@phosphor-icons/react'
import { FlapperSpinner } from 'react-spinners-kit'

export type AgentActivityState = 'working' | 'done'

interface AgentActivityIndicatorProps {
  state?: AgentActivityState
  size?: number
  className?: string
}

export function AgentActivityIndicator({ state, size = 14, className = '' }: AgentActivityIndicatorProps) {
  if (!state) return null

  const label = state === 'working' ? 'agent working' : 'agent done'

  return (
    <span className={`agent-activity-indicator ${state} ${className}`} title={label} aria-label={label}>
      {state === 'working' ? (
        <FlapperSpinner size={size} color="#36ad47" loading />
      ) : (
        <CheckCircleIcon className="agent-activity-check" size={size} strokeWidth={2.3} />
      )}
    </span>
  )
}

import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS } from '../../hooks/useSettings'
import { shouldShowAgentActivity } from './AgentActivityOverlay'

describe('agent activity visibility', () => {
  it('shows todo activity by default', () => {
    expect(DEFAULT_SETTINGS.showTodoActivity).toBe(true)
    expect(shouldShowAgentActivity(true, 2, false)).toBe(true)
  })

  it('hides todo-only activity when the global preference is disabled', () => {
    expect(shouldShowAgentActivity(false, 2, false)).toBe(false)
  })

  it('does not render an empty todo overlay', () => {
    expect(shouldShowAgentActivity(true, 0, false)).toBe(false)
  })

  it('always shows approvals and questions when todo activity is hidden', () => {
    expect(shouldShowAgentActivity(false, 0, true)).toBe(true)
    expect(shouldShowAgentActivity(false, 2, true)).toBe(true)
  })
})

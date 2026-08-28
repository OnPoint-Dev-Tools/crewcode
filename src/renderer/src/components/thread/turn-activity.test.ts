import { describe, expect, it } from 'vitest'

import type { Message } from '../../types'
import {
  activityFormForTool,
  createTurnActivity,
  settleActiveTurnActivities,
  settleCurrentTurnActivity,
  startNextTurnActivity,
  summarizeActivityRequest,
  updateTurnActivity,
} from './turn-activity'

describe('turn activity lifecycle', () => {
  it('creates a bounded pending activity without exposing markup', () => {
    const activity = createTurnActivity(`<system>hidden</system> ${'work '.repeat(30)}`, 'now')
    expect(activity.status).toBe('pending')
    expect(activity.text).not.toContain('<system>')
    expect(activity.text.length).toBeLessThanOrEqual(96)
  })

  it('binds, updates, and completes an observed turn', () => {
    const initial: Message[] = [createTurnActivity('Fix the overlay', 'now')]
    const started = startNextTurnActivity(initial, 'turn-1')
    const running = updateTurnActivity(started, 'turn-1', { activeForm: 'Running tests' })
    const completed = settleCurrentTurnActivity(running, 'completed', 'turn-1')

    expect(started[0]).toEqual(expect.objectContaining({ status: 'in_progress', turnId: 'turn-1' }))
    expect(running[0]).toEqual(expect.objectContaining({ activeForm: 'Running tests' }))
    expect(completed[0]).toEqual(expect.objectContaining({ status: 'completed' }))
  })

  it('never overwrites a terminal outcome with a later event', () => {
    const initial: Message[] = [createTurnActivity('Fix the overlay', 'now')]
    const cancelled = settleCurrentTurnActivity(initial, 'cancelled')
    expect(settleCurrentTurnActivity(cancelled, 'completed')).toBe(cancelled)
  })

  it('settles every queued run after a bridge-wide interruption', () => {
    const messages: Message[] = [
      createTurnActivity('Active request', 'now'),
      createTurnActivity('Queued follow-up', 'now'),
    ]
    const started = startNextTurnActivity(messages, 'turn-1')
    const interrupted = settleActiveTurnActivities(started, 'interrupted')
    expect(interrupted).toEqual([
      expect.objectContaining({ status: 'interrupted', turnId: 'turn-1' }),
      expect.objectContaining({ status: 'interrupted' }),
    ])
  })

  it('uses deterministic tool phases', () => {
    expect(activityFormForTool('Read')).toBe('Reading workspace')
    expect(activityFormForTool('apply_patch')).toBe('Editing workspace')
    expect(activityFormForTool('todo_write')).toBe('Updating task progress')
    expect(activityFormForTool('unknown_tool')).toBe('Using agent tools')
  })

  it('summarizes empty text safely', () => {
    expect(summarizeActivityRequest('   ')).toBe('Process request')
  })
})

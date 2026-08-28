import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { isBlockedTodo, todoDisplayLabel, TurnWorkLog, type TaskSummaryItem, type TodoItem } from './TurnWorkLog'

const blockedTask: TodoItem = {
  id: 'task-2',
  displayNumber: 2,
  subject: 'Run verification',
  text: 'Run verification',
  description: 'Run the focused tests.',
  status: 'pending',
  owner: 'crew',
  sessionId: 'session-1',
  projectPath: '/workspace',
  metadata: {},
  blocks: [],
  blockedBy: ['task-1'],
  createdAt: 10,
  updatedAt: 20,
}

describe('CrewCoder task presentation', () => {
  it('uses the TUI active label and blocker semantics', () => {
    expect(todoDisplayLabel({ ...blockedTask, status: 'in_progress', activeForm: 'Running verification' }))
      .toBe('Running verification')
    expect(isBlockedTodo(blockedTask)).toBe(true)
    expect(isBlockedTodo({ ...blockedTask, status: 'in_progress' })).toBe(false)
  })

  it('renders session display numbers, owner, and dependency hints', () => {
    const html = renderToStaticMarkup(React.createElement(TurnWorkLog, {
      rows: [{ kind: 'todowrite', label: 'Tasks', body: '', todos: [blockedTask], status: 'done' }],
      live: false,
    }))

    expect(html).toContain('class="wl-todo pending blocked"')
    expect(html).toContain('>#2<')
    expect(html).toContain('>owner=crew<')
    expect(html).toContain('>blockedBy=task-1<')
  })

  it('allows TaskSummaryItem to retain a complete task record', () => {
    const summary: TaskSummaryItem = { tool: 'TaskUpdate', text: blockedTask.text, task: blockedTask }
    expect(summary.task).toEqual(blockedTask)
  })
})

import React from 'react'
import TestRenderer from 'react-test-renderer'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { isBlockedTodo, todoDisplayLabel, TurnWorkLog, type WorkLogRow, type TaskSummaryItem, type TodoItem } from './TurnWorkLog'

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


describe('solo Work log sections', () => {
  it('partitions file calls and other tools with independent disclosure and completion reset', () => {
    const rows: WorkLogRow[] = [
      { kind: 'read', title: 'Read config', label: 'Read', body: '' },
      { kind: 'edit', title: 'Modified config', label: 'Edit', body: '' },
      { kind: 'bash', title: 'Shell changed file', label: 'Shell', body: '', modifiesFiles: true },
      { kind: 'search', title: 'Search docs', label: 'Search', body: '' },
    ]
    let renderer!: TestRenderer.ReactTestRenderer
    const props = { rows, live: false, separateFileCalls: true, collapsedByDefault: true }
    TestRenderer.act(() => {
      renderer = TestRenderer.create(React.createElement(TurnWorkLog, { ...props, turnActive: true }))
    })
    const section = (id: string) => renderer.root.findByProps({ 'data-worklog-section': id })
    const header = (id: string) => section(id).findAllByType('button')[0]
    const contains = (id: string, text: string) => section(id).findAll(node => node.children.includes(text)).length > 0
    expect(contains('files', 'Modified config')).toBe(true)
    expect(contains('files', 'Shell changed file')).toBe(true)
    expect(contains('files', 'Read config')).toBe(false)
    expect(contains('tools', 'Read config')).toBe(true)
    expect(contains('tools', 'Search docs')).toBe(true)
    expect(header('files').props['aria-expanded']).toBe(true)
    expect(header('tools').props['aria-expanded']).toBe(true)
    TestRenderer.act(() => header('files').props.onClick())
    TestRenderer.act(() => {
      renderer.update(React.createElement(TurnWorkLog, { ...props, rows: [...rows], turnActive: true }))
    })
    expect(header('files').props['aria-expanded']).toBe(false)
    expect(header('tools').props['aria-expanded']).toBe(true)
    TestRenderer.act(() => {
      renderer.update(React.createElement(TurnWorkLog, { ...props, turnActive: false }))
    })
    expect(header('files').props['aria-expanded']).toBe(false)
    expect(header('tools').props['aria-expanded']).toBe(false)
    TestRenderer.act(() => header('files').props.onClick())
    expect(header('files').props['aria-expanded']).toBe(true)
    expect(header('tools').props['aria-expanded']).toBe(false)
    TestRenderer.act(() => renderer.unmount())
  })
})

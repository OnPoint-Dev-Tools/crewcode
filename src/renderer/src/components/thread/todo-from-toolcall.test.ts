import { describe, expect, it } from 'vitest'

import type { Message, ToolCallMessage, ToolCallStatus } from '../../types'
import { latestTodoActivity, normalizeTodoStatus, todosFromToolCall } from './todo-from-toolcall'

function toolCall(toolName: string, args: unknown, status: ToolCallStatus = 'completed', result?: unknown): ToolCallMessage {
  return { kind: 'toolcall', time: '', turnId: 't', toolCallId: 'c', toolName, args, status, result }
}

describe('todosFromToolCall', () => {
  it("reads claude TodoWrite's todos array (content/status/activeForm)", () => {
    const msg = toolCall('TodoWrite', {
      todos: [
        { content: 'Write the parser', status: 'in_progress', activeForm: 'Writing the parser' },
        { content: 'Add tests', status: 'pending' },
      ],
    })
    expect(todosFromToolCall(msg)).toEqual([
      { status: 'in_progress', text: 'Write the parser', activeForm: 'Writing the parser' },
      { status: 'pending', text: 'Add tests', activeForm: undefined },
    ])
  })

  it("reads codex update_plan's `plan` array (step/status)", () => {
    const msg = toolCall('update_plan', {
      plan: [
        { step: 'Explore the codebase', status: 'completed' },
        { step: 'Implement the fix', status: 'in_progress' },
      ],
    })
    expect(todosFromToolCall(msg)).toEqual([
      { status: 'completed', text: 'Explore the codebase', activeForm: undefined },
      { status: 'in_progress', text: 'Implement the fix', activeForm: undefined },
    ])
  })

  it("reads pi manage_todo_list (args.todoList with title + not-started/in-progress status)", () => {
    const msg = toolCall('manage_todo_list', {
      operation: 'write',
      todoList: [
        { id: 1, title: 'read file', description: 'read file', status: 'completed' },
        { id: 2, title: 'edit function', description: 'edit function', status: 'in-progress' },
        { id: 3, title: 'run tests', description: 'run tests', status: 'not-started' },
      ],
    })
    expect(todosFromToolCall(msg)).toEqual([
      { status: 'completed', text: 'read file', activeForm: undefined },
      { status: 'in_progress', text: 'edit function', activeForm: undefined },
      { status: 'pending', text: 'run tests', activeForm: undefined },
    ])
  })

  it("reads pi's nested result.details.todos", () => {
    const msg = toolCall('manage_todo_list', { operation: 'write' }, 'completed', {
      content: [{ type: 'text', text: 'Todos have been modified successfully.' }],
      details: { operation: 'write', todos: [{ id: 1, title: 'ship it', status: 'not-started' }] },
    })
    expect(todosFromToolCall(msg)).toEqual([{ status: 'pending', text: 'ship it', activeForm: undefined }])
  })

  it('accepts bare string entries', () => {
    expect(todosFromToolCall(toolCall('plan', { plan: ['first', '  second  '] }))).toEqual([
      { status: 'pending', text: 'first' },
      { status: 'pending', text: 'second' },
    ])
  })

  it('falls back to the result payload when args has none', () => {
    const msg = toolCall('todowrite', {}, 'completed', { todos: [{ text: 'done thing', status: 'done' }] })
    expect(todosFromToolCall(msg)).toEqual([{ status: 'completed', text: 'done thing', activeForm: undefined }])
  })

  it('prefers the final result over stale running args after a tool settles', () => {
    const msg = toolCall(
      'claude_tasks',
      { todos: [{ content: 'Finish the work', status: 'in_progress' }] },
      'completed',
      { todos: [{ content: 'Finish the work', status: 'completed' }] },
    )
    expect(todosFromToolCall(msg)).toEqual([
      { status: 'completed', text: 'Finish the work', activeForm: undefined },
    ])
  })

  it('returns null for tool calls with no todo/plan payload', () => {
    expect(todosFromToolCall(toolCall('grep', { pattern: 'x', items: [{ path: 'a' }] }))).toBeNull()
    expect(todosFromToolCall(toolCall('todowrite', { todos: [] }))).toBeNull()
  })
})

describe('normalizeTodoStatus', () => {
  it('maps provider status variants onto the canonical set', () => {
    expect(normalizeTodoStatus('in-progress')).toBe('in_progress')
    expect(normalizeTodoStatus('inProgress')).toBe('in_progress')
    expect(normalizeTodoStatus('done')).toBe('completed')
    expect(normalizeTodoStatus('canceled')).toBe('cancelled')
    expect(normalizeTodoStatus('something-else')).toBe('pending')
    expect(normalizeTodoStatus(undefined)).toBe('pending')
  })
})

describe('latestTodoActivity', () => {
  const text = (t: string): Message => ({ kind: 'text', role: 'assistant', text: t, time: '' } as unknown as Message)

  it('picks the most recent todo-bearing tool call and reports streaming', () => {
    const messages: Message[] = [
      toolCall('TodoWrite', { todos: [{ content: 'old', status: 'completed' }] }),
      toolCall('TodoWrite', { todos: [{ content: 'current', status: 'in_progress' }] }, 'running'),
    ]
    const snap = latestTodoActivity(messages)
    expect(snap?.todos).toEqual([{ status: 'in_progress', text: 'current', activeForm: undefined }])
    expect(snap?.isStreaming).toBe(true)
  })

  it('skips non-todo tool calls and plain messages instead of stopping at them', () => {
    const messages: Message[] = [
      toolCall('TodoWrite', { todos: [{ content: 'the plan', status: 'pending' }] }),
      toolCall('Bash', { command: 'ls' }),
      text('all done'),
    ]
    expect(latestTodoActivity(messages)?.todos).toEqual([
      { status: 'pending', text: 'the plan', activeForm: undefined },
    ])
  })

  it('returns null when no message carries todos', () => {
    expect(latestTodoActivity([toolCall('Read', { file: 'a' })])).toBeNull()
  })

  it('drops a finished turn\'s todos once a newer turn begins', () => {
    const user = (t: string): Message => ({ kind: 'user', text: t, time: '' })
    const messages: Message[] = [
      toolCall('TodoWrite', { todos: [{ content: 'done', status: 'completed' }] }),
      text('all done'),
      user('testing 123'),
      text('testing received'),
    ]
    expect(latestTodoActivity(messages)).toBeNull()
  })

  it('still shows the current turn\'s todos after its own user message', () => {
    const user = (t: string): Message => ({ kind: 'user', text: t, time: '' })
    const messages: Message[] = [
      user('do the thing'),
      toolCall('TodoWrite', { todos: [{ content: 'working', status: 'in_progress' }] }, 'running'),
    ]
    expect(latestTodoActivity(messages)?.todos).toEqual([
      { status: 'in_progress', text: 'working', activeForm: undefined },
    ])
  })
})

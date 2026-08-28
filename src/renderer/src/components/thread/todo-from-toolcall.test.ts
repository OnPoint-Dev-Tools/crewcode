import { describe, expect, it } from 'vitest'

import type { Message, ToolCallMessage, ToolCallStatus } from '../../types'
import { crewCoderTaskOp, latestTodoActivity, normalizeTodoStatus, todosFromToolCall } from './todo-from-toolcall'
import { createTurnActivity, settleCurrentTurnActivity } from './turn-activity'

function toolCall(toolName: string, args: unknown, status: ToolCallStatus = 'completed', result?: unknown, toolCallId = 'c'): ToolCallMessage {
  return { kind: 'toolcall', time: '', turnId: 't', toolCallId, toolName, args, status, result }
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

  it('does not treat CrewCoder propose_plan string fields as a todo list', () => {
    expect(todosFromToolCall(toolCall('crewcoder_propose_plan', {
      requirements: 'Add logs.',
      plan: 'Write writer.ts',
      acceptanceCriteria: 'A log line exists.',
    }))).toBeNull()
  })

  it('falls back to the result payload when args has none', () => {
    const msg = toolCall('todowrite', {}, 'completed', { todos: [{ text: 'done thing', status: 'done' }] })
    expect(todosFromToolCall(msg)).toEqual([{ status: 'completed', text: 'done thing', activeForm: undefined }])
  })

  it("reads CrewCoder Task* ACP rawOutput snapshots (output + todos)", () => {
    const msg = toolCall('TaskUpdate', { taskId: '1', status: 'in_progress' }, 'completed', {
      output: 'Updated: Write the parser (status)',
      isError: false,
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

  it('preserves the complete CrewCoder Agent task record alongside its lossy TUI snapshot', () => {
    const task = {
      id: 'task-17',
      subject: 'Write the parser',
      description: 'Parse every supported payload shape.',
      status: 'pending',
      activeForm: 'Writing the parser',
      owner: 'crew',
      sessionId: 'session-1',
      projectPath: '/workspace',
      metadata: { acceptance: 'tests pass' },
      blocks: ['task-18'],
      blockedBy: ['task-16'],
      createdAt: 100,
      updatedAt: 200,
    }
    const messages: Message[] = [
      toolCall('TaskCreate', { subject: task.subject, description: task.description }, 'completed', {
        output: 'Created #7: Write the parser',
        task,
        todos: [{ content: task.subject, status: task.status, activeForm: task.activeForm }],
      }),
    ]

    expect(latestTodoActivity(messages)?.todos).toEqual([{
      status: 'pending',
      text: 'Write the parser',
      activeForm: 'Writing the parser',
      id: 'task-17',
      displayNumber: 7,
      subject: 'Write the parser',
      description: 'Parse every supported payload shape.',
      owner: 'crew',
      sessionId: 'session-1',
      projectPath: '/workspace',
      metadata: { acceptance: 'tests pass' },
      blocks: ['task-18'],
      blockedBy: ['task-16'],
      createdAt: 100,
      updatedAt: 200,
    }])
  })

  it('enriches a TaskGet snapshot even when the task was not already visible', () => {
    const messages: Message[] = [
      toolCall('TaskGet', { taskId: 'task-3' }, 'completed', {
        output: '#3 [pending] Verify dependencies',
        task: {
          id: 'task-3',
          subject: 'Verify dependencies',
          description: 'Wait for the parser task.',
          status: 'pending',
          owner: 'crew',
          sessionId: 'session-1',
          projectPath: '/workspace',
          metadata: {},
          blocks: [],
          blockedBy: ['task-2'],
          createdAt: 300,
          updatedAt: 400,
        },
        todos: [{ content: 'Verify dependencies', status: 'pending' }],
      }),
    ]

    expect(latestTodoActivity(messages)?.todos[0]).toMatchObject({
      id: 'task-3',
      subject: 'Verify dependencies',
      description: 'Wait for the parser task.',
      owner: 'crew',
      blockedBy: ['task-2'],
      createdAt: 300,
      updatedAt: 400,
    })
  })

  it('orders CrewCoder tasks like the TUI: active, pending, then completed', () => {
    const messages: Message[] = [
      toolCall('TaskList', { sessionOnly: true }, 'completed', {
        output: [
          '#1 [completed] Old task',
          '#2 [pending] Next task blockedBy=task-4',
          '#3 [in_progress] Current task owner=crew',
        ].join('\n'),
      }),
    ]

    expect(latestTodoActivity(messages)?.todos.map(todo => ({ text: todo.text, owner: todo.owner, blockedBy: todo.blockedBy }))).toEqual([
      { text: 'Current task', owner: 'crew', blockedBy: undefined },
      { text: 'Next task', owner: undefined, blockedBy: ['task-4'] },
      { text: 'Old task', owner: undefined, blockedBy: undefined },
    ])
  })

  it("reads Grok TodoWrite's settled TodosUpdated snapshot", () => {
    const msg = toolCall('todo_write', {
      variant: 'TodoWrite',
      merge: true,
      todos: [{ id: '1', content: null, status: 'completed' }],
    }, 'completed', {
      type: 'Todo',
      TodosUpdated: {
        todos: [
          { content: 'Inspect the payload', priority: 'medium', status: 'completed' },
          { content: 'Fix the overlay', priority: 'medium', status: 'in_progress' },
        ],
      },
    })

    expect(todosFromToolCall(msg)).toEqual([
      { status: 'completed', text: 'Inspect the payload', activeForm: undefined },
      { status: 'in_progress', text: 'Fix the overlay', activeForm: undefined },
    ])
  })

  it("prefers Grok's full TodosUpdated.state.todos map over the merge subset", () => {
    const msg = toolCall('todo_write', {
      variant: 'TodoWrite',
      merge: true,
      todos: [
        { id: '1', content: null, status: 'completed' },
        { id: '2', content: null, status: 'completed' },
      ],
    }, 'completed', {
      type: 'Todo',
      TodosUpdated: {
        todos: [
          { content: 'Inspect the payload', priority: 'medium', status: 'completed' },
          { content: 'Fix the overlay', priority: 'medium', status: 'completed' },
        ],
        state: {
          todos: {
            1: { content: 'Inspect the payload', priority: 'medium', status: 'completed' },
            2: { content: 'Fix the overlay', priority: 'medium', status: 'completed' },
            3: { content: 'Write the regression', priority: 'medium', status: 'in_progress' },
          },
        },
      },
    })

    expect(todosFromToolCall(msg)).toEqual([
      { status: 'completed', text: 'Inspect the payload', activeForm: undefined },
      { status: 'completed', text: 'Fix the overlay', activeForm: undefined },
      { status: 'in_progress', text: 'Write the regression', activeForm: undefined },
    ])
  })

  it('reads CrewCoder Task* snapshots that use subject instead of content', () => {
    const msg = toolCall('TaskCreate', { subject: 'Write the parser', description: 'parse input' }, 'completed', {
      output: 'Created #1: Write the parser',
      todos: [{ subject: 'Write the parser', status: 'pending', activeForm: 'Writing the parser' }],
    })
    expect(todosFromToolCall(msg)).toEqual([
      { status: 'pending', text: 'Write the parser', activeForm: 'Writing the parser' },
    ])
  })

  it('reads a todo snapshot from tool_update metadata while the call is still running', () => {
    const msg: ToolCallMessage = {
      ...toolCall('todo_write', {
        merge: false,
        todos: [{ id: '1', content: 'Inspect the payload', status: 'in_progress' }],
      }, 'running'),
      metadata: {
        type: 'Todo',
        TodosUpdated: {
          state: {
            todos: {
              1: { content: 'Inspect the payload', status: 'in_progress' },
              2: { content: 'Fix the overlay', status: 'pending' },
            },
          },
        },
      },
    }
    expect(todosFromToolCall(msg)).toEqual([
      { status: 'in_progress', text: 'Inspect the payload', activeForm: undefined },
      { status: 'pending', text: 'Fix the overlay', activeForm: undefined },
    ])
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

  it('shows CrewCode-owned activity before a provider emits native todos', () => {
    const activity = createTurnActivity('Fix the overlay', '')
    expect(latestTodoActivity([
      { kind: 'user', text: 'Fix the overlay', time: '' },
      activity,
    ])).toEqual({
      todos: [{ status: 'pending', text: 'Fix the overlay', activeForm: 'Starting request' }],
      isStreaming: true,
    })
  })

  it('uses native provider todos while CrewCode execution is active', () => {
    const activity = createTurnActivity('Fix the overlay', '')
    const messages: Message[] = [
      { kind: 'user', text: 'Fix the overlay', time: '' },
      { ...activity, status: 'in_progress', turnId: 't' },
      toolCall('TodoWrite', { todos: [{ content: 'Inspect payload', status: 'in_progress' }] }, 'running'),
    ]
    expect(latestTodoActivity(messages)).toEqual({
      todos: [{ status: 'in_progress', text: 'Inspect payload', activeForm: undefined }],
      isStreaming: true,
    })
  })

  it('lets the observed CrewCode terminal outcome override stale native work', () => {
    const activity = { ...createTurnActivity('Fix the overlay', ''), status: 'in_progress' as const, turnId: 't' }
    const messages: Message[] = [
      { kind: 'user', text: 'Fix the overlay', time: '' },
      activity,
      toolCall('TodoWrite', { todos: [{ content: 'Inspect payload', status: 'in_progress' }] }, 'completed'),
    ]
    expect(latestTodoActivity(settleCurrentTurnActivity(messages, 'completed', 't'))).toEqual({
      todos: [{ status: 'completed', text: 'Fix the overlay', activeForm: undefined }],
      isStreaming: false,
    })
  })

  it('does not let an older running turn overwrite a queued follow-up activity', () => {
    const queued = createTurnActivity('Queued follow-up', '')
    const messages: Message[] = [
      { kind: 'user', text: 'Queued follow-up', time: '' },
      queued,
      toolCall('TodoWrite', { todos: [{ content: 'Old turn work', status: 'in_progress' }] }, 'running'),
    ]
    expect(latestTodoActivity(messages)).toEqual({
      todos: [{ status: 'pending', text: 'Queued follow-up', activeForm: 'Starting request' }],
      isStreaming: true,
    })
  })

  it('projects activity from an earlier app runtime as interrupted', () => {
    const stale = { ...createTurnActivity('Old request', ''), runtimeId: 'previous-runtime', status: 'in_progress' as const }
    expect(latestTodoActivity([stale])).toEqual({
      todos: [{ status: 'cancelled', text: 'Interrupted — Old request', activeForm: undefined }],
      isStreaming: false,
    })
  })

  it('preserves a terminal activity outcome across app runtimes', () => {
    const completed = { ...createTurnActivity('Old request', ''), runtimeId: 'previous-runtime', status: 'completed' as const }
    expect(latestTodoActivity([completed])).toEqual({
      todos: [{ status: 'completed', text: 'Old request', activeForm: undefined }],
      isStreaming: false,
    })
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

  it('reconstructs CrewCoder TaskCreate/TaskUpdate mutations into one overlay list', () => {
    const user = (t: string): Message => ({ kind: 'user', text: t, time: '' })
    const messages: Message[] = [
      user('do the work'),
      toolCall('TaskCreate', { subject: 'Write the parser', description: 'parse input', activeForm: 'Writing the parser' }, 'completed', { output: 'Task #1 created: Write the parser' }, 'c1'),
      toolCall('TaskCreate', { subject: 'Add tests', description: 'cover the parser' }, 'completed', { output: 'Task #2 created: Add tests' }, 'c2'),
      toolCall('TaskUpdate', { taskId: '1', status: 'in_progress' }, 'running', undefined, 'c3'),
    ]
    const snap = latestTodoActivity(messages)
    expect(snap?.todos).toEqual([
      { status: 'in_progress', text: 'Write the parser', activeForm: 'Writing the parser', id: '1', displayNumber: 1, description: 'parse input' },
      { status: 'pending', text: 'Add tests', activeForm: undefined, displayNumber: 2, description: 'cover the parser' },
    ])
    expect(snap?.isStreaming).toBe(true)
  })

  it('shows a streaming CrewCoder TaskCreate before the store id exists', () => {
    const messages: Message[] = [
      toolCall('TaskCreate', { subject: 'Write the parser', description: 'parse input', activeForm: 'Writing the parser' }, 'running', undefined, 'c1'),
    ]
    expect(latestTodoActivity(messages)).toEqual({
      todos: [{ status: 'pending', text: 'Write the parser', activeForm: 'Writing the parser', description: 'parse input' }],
      isStreaming: true,
    })
  })

  it('replaces a pending create with CrewCoder\'s stable task id from rawOutput', () => {
    const messages: Message[] = [
      toolCall('TaskCreate', { subject: 'Write the parser', description: 'parse input' }, 'completed', {
        output: 'Created #1: Write the parser',
        isError: false,
        task: { id: 'task-stable-17', subject: 'Write the parser' },
      }, 'c1'),
      toolCall('TaskUpdate', { taskId: 'task-stable-17', status: 'in_progress' }, 'running', undefined, 'c2'),
    ]
    expect(latestTodoActivity(messages)?.todos).toEqual([
      { status: 'in_progress', text: 'Write the parser', activeForm: undefined, id: 'task-stable-17', displayNumber: 1, description: 'parse input' },
    ])
  })

  it('applies a running CrewCoder update on top of the previous completed snapshot', () => {
    const messages: Message[] = [
      toolCall('TaskCreate', { subject: 'Write the parser', description: 'parse input' }, 'completed', {
        output: 'Created #1: Write the parser',
        isError: false,
        task: { id: 'task-1', subject: 'Write the parser' },
        todos: [
          { content: 'Write the parser', status: 'pending', activeForm: 'Writing the parser' },
          { content: 'Add tests', status: 'pending' },
        ],
      }, 'c1'),
      toolCall('TaskUpdate', { taskId: 'task-1', status: 'in_progress' }, 'running', undefined, 'c2'),
    ]

    expect(latestTodoActivity(messages)).toEqual({
      todos: [
        { status: 'in_progress', text: 'Write the parser', activeForm: 'Writing the parser', id: 'task-1', displayNumber: 1, description: 'parse input' },
        { status: 'pending', text: 'Add tests', activeForm: undefined },
      ],
      isStreaming: true,
    })
  })

  it('does not resurrect a prior snapshot after CrewCoder deletes the final task', () => {
    const messages: Message[] = [
      toolCall('TaskCreate', { subject: 'Remove me', description: 'temporary task' }, 'completed', {
        task: { id: 'task-1', subject: 'Remove me' },
        todos: [{ content: 'Remove me', status: 'pending' }],
      }, 'c1'),
      toolCall('TaskDelete', { taskId: 'task-1' }, 'completed', {
        output: 'Deleted #1: Remove me',
        isError: false,
        todos: [],
      }, 'c2'),
    ]

    expect(latestTodoActivity(messages)).toBeNull()
  })

  it('clears unfinished CrewCoder tasks when a follow-up turn starts', () => {
    const messages: Message[] = [
      { kind: 'user', text: 'start the work', time: '' },
      toolCall('TaskCreate', { subject: 'Write the parser', description: 'parse input' }, 'completed', {
        task: { id: 'task-1', subject: 'Write the parser' },
        todos: [{ content: 'Write the parser', status: 'in_progress', activeForm: 'Writing the parser' }],
      }, 'c1'),
      { kind: 'agent', text: 'Still working.', blocks: [], time: '', turnId: 't' },
      { kind: 'user', text: 'also cover empty input', time: '' },
      toolCall('bash', { command: 'npm test' }, 'running', undefined, 'c2'),
    ]

    expect(latestTodoActivity(messages)).toBeNull()
  })

  it('shows only the CrewCoder task list refreshed in the current turn', () => {
    const messages: Message[] = [
      { kind: 'user', text: 'first task', time: '' },
      toolCall('TaskCreate', { subject: 'Old task' }, 'completed', {
        task: { id: 'task-old', subject: 'Old task' },
        todos: [{ id: 'task-old', content: 'Old task', status: 'in_progress' }],
      }, 'c1'),
      { kind: 'user', text: 'replacement task', time: '' },
      toolCall('TaskCreate', { subject: 'New task' }, 'running', undefined, 'c2'),
    ]

    expect(latestTodoActivity(messages)).toEqual({
      todos: [{ status: 'pending', text: 'New task', activeForm: undefined }],
      isStreaming: true,
    })
  })

  it('clears a completed CrewCoder list when the next user turn starts', () => {
    const messages: Message[] = [
      { kind: 'user', text: 'start the work', time: '' },
      toolCall('TaskUpdate', { taskId: 'task-1', status: 'completed' }, 'completed', {
        task: { id: 'task-1', subject: 'Write the parser' },
        todos: [{ content: 'Write the parser', status: 'completed' }],
      }, 'c1'),
      { kind: 'user', text: 'new unrelated request', time: '' },
    ]

    expect(latestTodoActivity(messages)).toBeNull()
  })

  it('treats a settled in-progress CrewCoder snapshot as active work', () => {
    const messages: Message[] = [
      toolCall('TaskUpdate', { taskId: 'task-1', status: 'in_progress' }, 'completed', {
        task: { id: 'task-1', subject: 'Write the parser' },
        todos: [{ content: 'Write the parser', status: 'in_progress', activeForm: 'Writing the parser' }],
      }),
    ]

    expect(latestTodoActivity(messages)?.isStreaming).toBe(true)
  })

  it('still reconstructs CrewCoder tasks when ACP kind was recorded as the tool name', () => {
    const messages: Message[] = [
      { ...toolCall('other', { subject: 'Ship it', description: 'land the change' }, 'completed', { output: 'Task #4 created: Ship it' }), title: 'TaskCreate' },
      { ...toolCall('other', { taskId: '4', status: 'completed' }), title: 'TaskUpdate' },
    ]
    expect(latestTodoActivity(messages)?.todos).toEqual([
      { status: 'completed', text: 'Ship it', activeForm: undefined, id: '4', displayNumber: 4, description: 'land the change' },
    ])
  })

  it('ignores a project-wide CrewCoder TaskList instead of mixing other sessions into the chat', () => {
    const messages: Message[] = [
      {
        ...toolCall('other', { includeCompleted: false, sessionOnly: false, sort: 'recent' }, 'completed', {
          output: [
            '#18 [in_progress] Opening Git changes in editor Pierre diff session=session_old_a',
            '#4 [in_progress] Implement phone-approved machine enrollment (Crew) session=session_old_b',
          ].join('\n'),
          todos: [
            { content: 'Opening Git changes in editor Pierre diff', status: 'in_progress' },
            { content: 'Implement phone-approved machine enrollment', status: 'in_progress' },
          ],
        }),
        title: 'TaskList',
      },
      {
        ...toolCall('other', { taskId: '18', status: 'in_progress', activeForm: 'Opening Git changes' }, 'completed', {
          output: 'Updated task #18: status, activeForm',
          isError: false,
        }),
        title: 'TaskUpdate',
      },
    ]

    expect(latestTodoActivity(messages)).toBeNull()
  })

  it('uses Grok\'s newest settled TodoWrite snapshot rather than its initial plan', () => {
    const messages: Message[] = [
      toolCall('todo_write', {
        variant: 'TodoWrite',
        merge: false,
        todos: [{ id: '1', content: 'Fix the overlay', status: 'in_progress' }],
      }),
      toolCall('todo_write', {
        variant: 'TodoWrite',
        merge: true,
        todos: [{ id: '1', content: null, status: 'completed' }],
      }, 'completed', {
        type: 'Todo',
        TodosUpdated: { todos: [{ content: 'Fix the overlay', status: 'completed' }] },
      }),
    ]

    expect(latestTodoActivity(messages)).toEqual({
      todos: [{ status: 'completed', text: 'Fix the overlay', activeForm: undefined }],
      isStreaming: false,
    })
  })

  it('keeps Grok todos that a merge update did not mention', () => {
    const messages: Message[] = [
      toolCall('todo_write', {
        merge: false,
        todos: [
          { id: '1', content: 'Inspect the payload', status: 'in_progress' },
          { id: '2', content: 'Fix the overlay', status: 'pending' },
          { id: '3', content: 'Write the regression', status: 'pending' },
        ],
      }),
      toolCall('todo_write', {
        variant: 'TodoWrite',
        merge: true,
        todos: [
          { id: '1', content: null, status: 'completed' },
          { id: '2', content: null, status: 'completed' },
        ],
      }, 'completed', {
        type: 'Todo',
        TodosUpdated: {
          todos: [
            { content: 'Inspect the payload', status: 'completed' },
            { content: 'Fix the overlay', status: 'completed' },
          ],
          state: {
            todos: {
              1: { content: 'Inspect the payload', status: 'completed' },
              2: { content: 'Fix the overlay', status: 'completed' },
              3: { content: 'Write the regression', status: 'in_progress' },
            },
          },
        },
      }),
    ]

    expect(latestTodoActivity(messages)).toEqual({
      todos: [
        { status: 'completed', text: 'Inspect the payload', activeForm: undefined },
        { status: 'completed', text: 'Fix the overlay', activeForm: undefined },
        { status: 'in_progress', text: 'Write the regression', activeForm: undefined },
      ],
      isStreaming: true,
    })
  })

  it('folds a running Grok merge onto the previous full list', () => {
    const messages: Message[] = [
      toolCall('todo_write', {
        merge: false,
        todos: [
          { id: '1', content: 'Inspect the payload', status: 'in_progress' },
          { id: '2', content: 'Fix the overlay', status: 'pending' },
        ],
      }),
      toolCall('todo_write', {
        variant: 'TodoWrite',
        merge: true,
        todos: [{ id: '1', content: null, status: 'completed' }],
      }, 'running'),
    ]

    expect(latestTodoActivity(messages)).toEqual({
      todos: [
        { status: 'completed', text: 'Inspect the payload', activeForm: undefined },
        { status: 'pending', text: 'Fix the overlay', activeForm: undefined },
      ],
      isStreaming: true,
    })
  })

  it('clears unfinished Grok todos when a follow-up turn starts', () => {
    const messages: Message[] = [
      { kind: 'user', text: 'fix the overlay', time: '' },
      toolCall('todo_write', {
        merge: false,
        todos: [
          { id: '1', content: 'Inspect the payload', status: 'completed' },
          { id: '2', content: 'Fix the overlay', status: 'in_progress' },
        ],
      }),
      { kind: 'agent', text: 'Still working.', blocks: [], time: '', turnId: 't' },
      { kind: 'user', text: 'also cover the empty case', time: '' },
      toolCall('bash', { command: 'npm test' }, 'running', undefined, 'c2'),
    ]

    expect(latestTodoActivity(messages)).toBeNull()
  })

  it('drops completed CrewCoder tasks from a previous turn', () => {
    const user = (t: string): Message => ({ kind: 'user', text: t, time: '' })
    const messages: Message[] = [
      toolCall('TaskUpdate', { taskId: '1', status: 'completed' }, 'completed', {
        task: { id: '1', subject: 'old' },
        todos: [{ content: 'old', status: 'completed' }],
      }),
      user('next turn'),
      toolCall('bash', { command: 'ls' }),
    ]
    expect(latestTodoActivity(messages)).toBeNull()
  })
})

describe('crewCoderTaskOp', () => {
  it('classifies TaskCreate/Update/Delete even without a real tool name', () => {
    expect(crewCoderTaskOp({ ...toolCall('other', { subject: 'A', description: 'B' }), title: 'TaskCreate' })).toBe('create')
    expect(crewCoderTaskOp({ ...toolCall('other', { taskId: '1', status: 'in_progress' }), title: 'TaskUpdate' })).toBe('update')
    expect(crewCoderTaskOp(toolCall('TaskDelete', { taskId: '1' }))).toBe('delete')
  })

  it('does not classify another provider from Task-like arguments alone', () => {
    expect(crewCoderTaskOp(toolCall('manage_work', { subject: 'A', description: 'B' }))).toBeNull()
    expect(crewCoderTaskOp(toolCall('update_work', { taskId: '1', status: 'in_progress' }))).toBeNull()
  })
})

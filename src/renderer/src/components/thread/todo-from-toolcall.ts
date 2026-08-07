import type { Message, ToolCallMessage } from '../../types'
import type { TodoItem } from './TurnWorkLog'

// Normalizes the todo/plan progress that agent providers emit under different
// shapes into a single TodoItem list the AgentActivityOverlay can render:
// claude/opencode use a `todos` array ({content,status,activeForm}); codex's
// update_plan uses a `plan` array ({step,status}); pi's manage_todo_list uses a
// `todoList` array ({title,status}) and nests the result under `details.todos`;
// some emit bare strings.

export interface TodoActivitySnapshot {
  todos: TodoItem[]
  isStreaming: boolean
}

// Keys checked on a tool call's args/result. Kept tight (not generic like
// `items`/`tasks`) so unrelated tool payloads can't false-positive as todos.
const TODO_ARRAY_KEYS = ['todos', 'plan', 'todoList']

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function normalizeTodoStatus(raw: unknown): TodoItem['status'] {
  const s = String(raw ?? '').toLowerCase().replace(/[\s-]+/g, '_')
  if (s === 'completed' || s === 'complete' || s === 'done' || s === 'finished') return 'completed'
  if (s === 'in_progress' || s === 'inprogress' || s === 'active' || s === 'running' || s === 'doing') return 'in_progress'
  if (s === 'cancelled' || s === 'canceled' || s === 'skipped' || s === 'abandoned') return 'cancelled'
  return 'pending'
}

function todoFromEntry(entry: unknown): TodoItem | null {
  if (typeof entry === 'string') {
    const text = entry.trim()
    return text ? { status: 'pending', text } : null
  }
  const row = asRecord(entry)
  if (!row) return null
  const text = stringValue(row.content) ?? stringValue(row.text) ?? stringValue(row.title)
    ?? stringValue(row.step) ?? stringValue(row.description) ?? stringValue(row.label) ?? stringValue(row.name) ?? ''
  if (!text) return null
  return {
    status: normalizeTodoStatus(row.status ?? row.state),
    text,
    activeForm: stringValue(row.activeForm) ?? stringValue(row.active_form),
  }
}

/** Pull a normalized todo list from a tool call, or null if it carries none. */
export function todosFromToolCall(msg: ToolCallMessage): TodoItem[] | null {
  // While streaming, args carry the newest snapshot. Once settled, result is
  // authoritative and must win over stale running args from an earlier update.
  const payloads = msg.status === 'running' || msg.status === 'pending'
    ? [asRecord(msg.args), asRecord(msg.result)]
    : [asRecord(msg.result), asRecord(msg.args)]
  for (const top of payloads) {
    if (!top) continue
    // Some providers nest the list one level (pi → result.details.todos).
    for (const source of [top, asRecord(top.details)]) {
      if (!source) continue
      for (const key of TODO_ARRAY_KEYS) {
        const arr = source[key]
        if (!Array.isArray(arr) || arr.length === 0) continue
        const todos = arr.map(todoFromEntry).filter((todo): todo is TodoItem => todo !== null)
        if (todos.length > 0) return todos
      }
    }
  }
  return null
}

/**
 * Most recent tool call carrying a todo/plan payload — provider-agnostic, so any
 * agent that reports a task list (not just claude's TodoWrite) lights up the
 * overlay. Non-todo tool calls are skipped, not treated as a terminator.
 *
 * Scoped to the current turn: the scan stops at the last `user` message, so a
 * todo list from an already-finished turn is dropped once a newer turn begins.
 * Without this the overlay would re-find the stale list forever and never clear.
 */
export function latestTodoActivity(messages: Message[]): TodoActivitySnapshot | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    // A user message marks the start of the latest turn; todos before it belong
    // to a prior, completed turn and should no longer drive the overlay.
    if (msg.kind === 'user') return null
    if (msg.kind !== 'toolcall') continue
    const todos = todosFromToolCall(msg)
    if (!todos || todos.length === 0) continue
    return {
      todos,
      isStreaming: msg.status === 'running' || msg.status === 'pending',
    }
  }
  return null
}

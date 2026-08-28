import type { CrewCodeActivityMessage, Message, ToolCallMessage } from '../../types'
import type { TodoItem } from './TurnWorkLog'
import { isActivityFromCurrentRuntime } from './turn-activity'

// Normalizes the todo/plan progress that agent providers emit under different
// shapes into a single TodoItem list the AgentActivityOverlay can render:
// claude/opencode use a `todos` array ({content,status,activeForm}); codex's
// update_plan uses a `plan` array ({step,status}); pi's manage_todo_list uses a
// `todoList` array ({title,status}) and nests the result under `details.todos`;
// Grok TodoWrite nests the full session list under `TodosUpdated.state.todos`;
// CrewCoder Task* results attach a session `todos` snapshot; some emit bare strings.

export interface TodoActivitySnapshot {
  todos: TodoItem[]
  isStreaming: boolean
}

// Keys checked on a tool call's args/result/metadata. Kept tight (not generic
// like `items`/`tasks`) so unrelated tool payloads can't false-positive as todos.
const TODO_ARRAY_KEYS = ['todos', 'plan', 'todoList']

interface ParsedTodo {
  id: string
  item: TodoItem
}

interface SparseTodoPatch {
  id: string
  status: TodoItem['status']
  text?: string
  activeForm?: string
}

interface TodoCollection {
  full: ParsedTodo[] | null
  sparse: SparseTodoPatch[]
  empty: boolean
  keyed: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function identifierValue(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return stringValue(value)
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result = value.map(identifierValue).filter((entry): entry is string => entry !== undefined)
  return result.length > 0 ? result : []
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function todoPayloadSources(top: Record<string, unknown>): Array<Record<string, unknown>> {
  const updated = asRecord(top.TodosUpdated)
  const updatedState = asRecord(updated?.state)
  const topState = asRecord(top.state)
  // Prefer Grok's full session map (`TodosUpdated.state.todos`) over the merge
  // subset that lives on `TodosUpdated.todos` / `args.todos`.
  return [updatedState, topState, updated, asRecord(top.details), top]
    .filter((source): source is Record<string, unknown> => source !== null)
}

export function normalizeTodoStatus(raw: unknown): TodoItem['status'] {
  const s = String(raw ?? '').toLowerCase().replace(/[\s-]+/g, '_')
  if (s === 'completed' || s === 'complete' || s === 'done' || s === 'finished') return 'completed'
  if (s === 'in_progress' || s === 'inprogress' || s === 'active' || s === 'running' || s === 'doing') return 'in_progress'
  if (s === 'cancelled' || s === 'canceled' || s === 'skipped' || s === 'abandoned') return 'cancelled'
  return 'pending'
}

function looksLikeTodoEntry(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  const row = asRecord(value)
  if (!row) return false
  return stringValue(row.content) !== undefined
    || stringValue(row.text) !== undefined
    || stringValue(row.title) !== undefined
    || stringValue(row.step) !== undefined
    || stringValue(row.description) !== undefined
    || stringValue(row.subject) !== undefined
    || stringValue(row.label) !== undefined
    || stringValue(row.name) !== undefined
    || stringValue(row.id) !== undefined
    || row.status !== undefined
    || row.state !== undefined
}

export function todoItemFromUnknown(entry: unknown, fallbackId = 'task'): TodoItem | null {
  if (typeof entry === 'string') {
    const text = entry.trim()
    return text ? { status: 'pending', text } : null
  }
  const row = asRecord(entry)
  if (!row) return null
  const text = stringValue(row.content) ?? stringValue(row.text) ?? stringValue(row.title)
    ?? stringValue(row.step) ?? stringValue(row.subject) ?? stringValue(row.label)
    ?? stringValue(row.name) ?? stringValue(row.description)
  if (!text) return null
  const status = normalizeTodoStatus(row.status ?? row.state)
  const activeForm = stringValue(row.activeForm) ?? stringValue(row.active_form)
  const item: TodoItem = { status, text, activeForm }
  const id = identifierValue(row.id)
  const displayNumber = finiteNumber(row.displayNumber ?? row.display_number)
  const subject = stringValue(row.subject)
  const description = stringValue(row.description)
  const owner = stringValue(row.owner)
  const sessionId = stringValue(row.sessionId ?? row.session_id)
  const projectPath = stringValue(row.projectPath ?? row.project_path)
  const metadata = asRecord(row.metadata)
  const blocks = stringArray(row.blocks)
  const blockedBy = stringArray(row.blockedBy ?? row.blocked_by)
  const createdAt = finiteNumber(row.createdAt ?? row.created_at)
  const updatedAt = finiteNumber(row.updatedAt ?? row.updated_at)
  // Provider todos frequently have an incidental numeric `id`. Preserve rich
  // fields only for records that carry the CrewCoder Agent/TUI task contract,
  // rather than leaking provider implementation details into every TodoItem.
  const isCrewCoderTaskRecord = Boolean(
    id && subject && (
      sessionId || projectPath || owner || description || metadata || blocks
      || blockedBy || createdAt !== undefined || updatedAt !== undefined
    )
  )
  if (isCrewCoderTaskRecord) {
    item.id = id
    if (displayNumber !== undefined) item.displayNumber = displayNumber
    item.subject = subject
    if (description) item.description = description
    if (owner) item.owner = owner
    if (sessionId) item.sessionId = sessionId
    if (projectPath) item.projectPath = projectPath
    if (metadata) item.metadata = metadata
    if (blocks) item.blocks = blocks
    if (blockedBy) item.blockedBy = blockedBy
    if (createdAt !== undefined) item.createdAt = createdAt
    if (updatedAt !== undefined) item.updatedAt = updatedAt
  }
  return item
}

function parseTodoEntry(entry: unknown, fallbackId: string): { full?: ParsedTodo; sparse?: SparseTodoPatch } | null {
  const row = asRecord(entry)
  const item = todoItemFromUnknown(entry, fallbackId)
  if (item) return { full: { id: item.id ?? identifierValue(row?.id) ?? fallbackId, item } }
  if (!row) return null
  const id = identifierValue(row.id) ?? fallbackId
  const status = normalizeTodoStatus(row.status ?? row.state)
  const activeForm = stringValue(row.activeForm) ?? stringValue(row.active_form)
  return { sparse: { id, status, activeForm } }
}

function parseTodoCollection(value: unknown): TodoCollection | null {
  if (Array.isArray(value)) {
    if (value.length === 0) return { full: null, sparse: [], empty: true, keyed: false }
    const full: ParsedTodo[] = []
    const sparse: SparseTodoPatch[] = []
    value.forEach((entry, index) => {
      const parsed = parseTodoEntry(entry, `snapshot:${index}`)
      if (parsed?.full) full.push(parsed.full)
      else if (parsed?.sparse) sparse.push(parsed.sparse)
    })
    if (full.length === 0 && sparse.length === 0) return null
    return { full: full.length > 0 ? full : null, sparse, empty: false, keyed: false }
  }

  const rec = asRecord(value)
  if (!rec) return null
  const keys = Object.keys(rec)
  if (keys.length === 0) return { full: null, sparse: [], empty: true, keyed: true }
  if (!keys.every(key => looksLikeTodoEntry(rec[key]))) return null

  const full: ParsedTodo[] = []
  const sparse: SparseTodoPatch[] = []
  for (const key of keys) {
    const parsed = parseTodoEntry(rec[key], key)
    if (parsed?.full) {
      full.push({ id: parsed.full.id || key, item: parsed.full.item })
    } else if (parsed?.sparse) {
      sparse.push({ ...parsed.sparse, id: parsed.sparse.id || key })
    }
  }
  if (full.length === 0 && sparse.length === 0) return null
  return { full: full.length > 0 ? full : null, sparse, empty: false, keyed: true }
}

function collectionFromRecord(top: Record<string, unknown>): TodoCollection | null {
  let best: TodoCollection | null = null
  for (const source of todoPayloadSources(top)) {
    for (const key of TODO_ARRAY_KEYS) {
      const parsed = parseTodoCollection(source[key])
      if (!parsed) continue
      if (parsed.empty) return parsed
      // A keyed session map is the complete store; take it immediately.
      if (parsed.keyed && parsed.full) return parsed
      if (!best) best = parsed
      else if ((parsed.full?.length ?? 0) > (best.full?.length ?? 0)) best = parsed
    }
  }
  return best
}

function toolPayloads(msg: ToolCallMessage): unknown[] {
  const running = msg.status === 'running' || msg.status === 'pending'
  // Streaming args can be a sparse merge. Settled results (including Grok
  // `TodosUpdated.state`) are the complete store and must win.
  return running
    ? [msg.args, msg.result, msg.metadata]
    : [msg.result, msg.metadata, msg.args]
}

function parseToolCallTodos(msg: ToolCallMessage): TodoCollection | null {
  let best: TodoCollection | null = null
  for (const value of toolPayloads(msg)) {
    const top = asRecord(value)
    if (!top) continue
    const parsed = collectionFromRecord(top)
    if (!parsed) continue
    if (parsed.empty) return parsed
    if (parsed.keyed && parsed.full) return parsed
    if (!best) best = parsed
    else if ((parsed.full?.length ?? 0) > (best.full?.length ?? 0)) best = parsed
    else if (best.full === null && parsed.sparse.length > 0) {
      best = { full: best.full, sparse: [...best.sparse, ...parsed.sparse], empty: false, keyed: best.keyed }
    }
  }
  return best
}

/** Pull a normalized todo list from a tool call, or null if it carries none. */
export function todosFromToolCall(msg: ToolCallMessage): TodoItem[] | null {
  const parsed = parseToolCallTodos(msg)
  if (!parsed || parsed.empty || !parsed.full || parsed.full.length === 0) return null
  return parsed.full.map(row => row.item)
}

function compactToolLabel(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function toolCallOutput(msg: ToolCallMessage): string {
  const result = msg.result
  if (typeof result === 'string') return result
  const rec = asRecord(result)
  if (!rec) return ''
  if (typeof rec.output === 'string') return rec.output
  if (typeof rec.text === 'string') return rec.text
  return ''
}

function parseCreatedTaskId(output: string): string | undefined {
  const match = output.match(/(?:Task\s+)?#(\d+)\s+created|Created\s+#(\d+)/i)
  return match?.[1] ?? match?.[2]
}

function resultTaskId(msg: ToolCallMessage): string | undefined {
  const result = asRecord(msg.result)
  const task = asRecord(result?.task)
  return stringValue(task?.id)
}

function resultTask(msg: ToolCallMessage): TodoItem | null {
  const result = asRecord(msg.result)
  const details = asRecord(result?.details)
  return todoItemFromUnknown(result?.task ?? details?.task)
}

function mergedMetadata(previous: Record<string, unknown> | undefined, patch: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!patch) return previous
  const next = { ...previous }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  return next
}

function appendedIds(previous: string[] | undefined, added: unknown): string[] | undefined {
  const additions = stringArray(added)
  if (!additions) return previous
  return [...new Set([...(previous ?? []), ...additions])]
}

function parseTaskListEntries(output: string): Array<{ id: string; item: TodoItem }> {
  const rows: Array<{ id: string; item: TodoItem }> = []
  for (const line of output.split('\n')) {
    const match = line.match(/^#(\d+)\s+\[([^\]]+)\]\s+(.+?)\s*$/)
    if (!match) continue
    const details = match[3]
    const owner = details.match(/\s+owner=(\S+)/)?.[1]
    const blockedBy = details.match(/\s+blockedBy=(\S+)/)?.[1]?.split(',').filter(Boolean)
    const text = details
      .replace(/\s+\([^)]*\)\s*$/, '')
      .replace(/\s+(?:owner|session|blockedBy)=\S+/g, '')
      .trim()
    if (!text) continue
    rows.push({
      id: match[1],
      item: {
        status: normalizeTodoStatus(match[2]),
        text,
        displayNumber: Number(match[1]),
        ...(owner ? { owner } : {}),
        ...(blockedBy ? { blockedBy } : {}),
      },
    })
  }
  return rows
}

/**
 * CrewCoder's native todo layer is crew-tasks. Current versions attach a full
 * `todos` snapshot to each Task* result; this classifier supports incremental
 * TaskCreate / TaskUpdate / TaskDelete fallback for older versions and for users
 * who disabled autoSyncTodos. Older CrewCode transcripts retained `TaskCreate`
 * and friends as the title even when the ACP tool kind became `other`/`think`, so
 * classification stays label-based. Argument-shape guessing is intentionally
 * avoided because it can steal another provider's native plan events.
 */
type CrewCoderTaskOp = 'create' | 'update' | 'delete' | 'list' | 'get'

export function crewCoderTaskOp(msg: ToolCallMessage): CrewCoderTaskOp | null {
  const label = compactToolLabel(msg.toolName) + compactToolLabel(msg.title)
  if (label.includes('taskcreate')) return 'create'
  if (label.includes('taskupdate')) return 'update'
  if (label.includes('taskdelete')) return 'delete'
  if (label.includes('tasklist')) return 'list'
  if (label.includes('taskget')) return 'get'

  return null
}

function isSessionScopedCrewCoderTask(msg: ToolCallMessage, op: CrewCoderTaskOp): boolean {
  if (op !== 'list') return true
  const args = asRecord(msg.args)
  // TaskList defaults to project-wide data. A chat overlay must fail closed when
  // the call does not explicitly prove that its list belongs to this session.
  return args?.sessionOnly === true
}

/** True when this tool call belongs on the todo overlay instead of the work log. */
export function isCrewCoderTaskActivityTool(msg: ToolCallMessage): boolean {
  const op = crewCoderTaskOp(msg)
  return op === 'create' || op === 'update' || op === 'delete'
}

function applyCrewCoderTaskTool(
  items: Map<string, TodoItem>,
  pendingByCall: Map<string, string>,
  msg: ToolCallMessage,
): void {
  const op = crewCoderTaskOp(msg)
  if (!op) return
  const args = asRecord(msg.args) ?? {}
  const output = toolCallOutput(msg)

  const completeTask = resultTask(msg)

  if (op === 'get') {
    if (completeTask?.id && items.has(completeTask.id)) {
      items.set(completeTask.id, { ...items.get(completeTask.id)!, ...completeTask })
    }
    return
  }

  if (op === 'list') {
    const rows = parseTaskListEntries(output)
    if (rows.length === 0) return
    items.clear()
    pendingByCall.clear()
    for (const row of rows) items.set(row.id, row.item)
    return
  }

  if (op === 'create') {
    const createdDisplayId = parseCreatedTaskId(output)
    const createdId = completeTask?.id ?? resultTaskId(msg) ?? createdDisplayId
    const id = createdId ?? `pending:${msg.toolCallId}`
    const previous = pendingByCall.get(msg.toolCallId)
    if (previous && previous !== id && previous.startsWith('pending:')) items.delete(previous)
    pendingByCall.set(msg.toolCallId, id)
    const text = stringValue(args.subject) ?? items.get(id)?.text ?? `Task ${id}`
    const description = completeTask?.description ?? stringValue(args.description)
    const owner = completeTask?.owner ?? stringValue(args.owner)
    const metadata = completeTask?.metadata ?? mergedMetadata(items.get(id)?.metadata, asRecord(args.metadata))
    items.set(id, {
      ...items.get(id),
      ...completeTask,
      status: 'pending',
      text: completeTask?.text ?? text,
      activeForm: completeTask?.activeForm ?? stringValue(args.activeForm) ?? items.get(id)?.activeForm,
      ...(description ? { description } : {}),
      ...(owner ? { owner } : {}),
      ...(metadata ? { metadata } : {}),
      ...(completeTask?.id ? { id: completeTask.id } : {}),
      ...(createdDisplayId ? { displayNumber: Number(createdDisplayId) } : {}),
    })
    return
  }

  const taskId = stringValue(args.taskId) ?? parseCreatedTaskId(output)
  if (!taskId) return
  if (op === 'delete') {
    items.delete(taskId)
    for (const [id, item] of items) {
      if (!item.blocks?.includes(taskId) && !item.blockedBy?.includes(taskId)) continue
      items.set(id, {
        ...item,
        ...(item.blocks ? { blocks: item.blocks.filter(blockedId => blockedId !== taskId) } : {}),
        ...(item.blockedBy ? { blockedBy: item.blockedBy.filter(blockerId => blockerId !== taskId) } : {}),
      })
    }
    return
  }

  const previous = items.get(taskId)
  // An incremental update is meaningful only for a task already established in
  // this chat. Modern results with an authoritative snapshot are reconciled
  // immediately below; a bare update for an unknown id may target a task found
  // through a project-wide list and must not leak it into this session overlay.
  if (!previous && !parseToolCallTodos(msg)?.full) return
  const text = stringValue(args.subject) ?? previous?.text ?? `Task ${taskId}`
  const statusRaw = args.status ?? completeTask?.status ?? previous?.status
  const description = completeTask?.description ?? stringValue(args.description)
  const owner = completeTask?.owner ?? stringValue(args.owner)
  const metadata = completeTask?.metadata ?? mergedMetadata(previous?.metadata, asRecord(args.metadata))
  const blocks = completeTask?.blocks ?? appendedIds(previous?.blocks, args.addBlocks)
  const blockedBy = completeTask?.blockedBy ?? appendedIds(previous?.blockedBy, args.addBlockedBy)
  items.set(taskId, {
    ...previous,
    ...completeTask,
    status: normalizeTodoStatus(statusRaw),
    text: completeTask?.text ?? text,
    activeForm: completeTask?.activeForm ?? stringValue(args.activeForm) ?? previous?.activeForm,
    ...(description ? { description } : {}),
    ...(owner ? { owner } : {}),
    ...(metadata ? { metadata } : {}),
    ...(blocks ? { blocks } : {}),
    ...(blockedBy ? { blockedBy } : {}),
    id: completeTask?.id ?? previous?.id ?? taskId,
  })
}

function enrichFromResultTask(items: Map<string, TodoItem>, msg: ToolCallMessage): void {
  const task = resultTask(msg)
  if (!task?.id) return
  const match = [...items.entries()].find(([id, item]) => id === task.id || item.id === task.id || item.text === task.text)
  if (!match) return
  // The todo snapshot remains authoritative for list membership and status;
  // the full task record restores fields that autoSyncTodos intentionally omits.
  items.set(match[0], { ...task, ...match[1], id: task.id, subject: task.subject })
}

function applyFullSnapshot(items: Map<string, TodoItem>, snapshot: ParsedTodo[]): void {
  const available = [...items.entries()]
  const used = new Set<string>()
  const next = new Map<string, TodoItem>()

  for (const row of snapshot) {
    const matching = available.find(([id, item]) => !used.has(id) && (id === row.id || item.text === row.item.text))
    const id = matching?.[0] ?? row.id
    used.add(id)
    next.set(id, matching ? { ...matching[1], ...row.item } : row.item)
  }

  items.clear()
  for (const [id, item] of next) items.set(id, item)
}

function resolvePatchId(items: Map<string, TodoItem>, patch: SparseTodoPatch): string | null {
  if (items.has(patch.id)) return patch.id
  if (patch.text) {
    const match = [...items.entries()].find(([, item]) => item.text === patch.text)
    if (match) return match[0]
    return patch.id
  }
  return null
}

function applySparsePatches(items: Map<string, TodoItem>, patches: SparseTodoPatch[]): void {
  for (const patch of patches) {
    const id = resolvePatchId(items, patch)
    if (!id) continue
    const previous = items.get(id)
    items.set(id, {
      ...previous,
      status: patch.status,
      text: patch.text ?? previous?.text ?? `Task ${id}`,
      activeForm: patch.activeForm ?? previous?.activeForm,
    })
  }
}

function isMergeUpdate(msg: ToolCallMessage): boolean {
  const args = asRecord(msg.args)
  return args?.merge === true
}

function sortLikeCrewCoderTui(todos: TodoItem[]): TodoItem[] {
  const rank: Record<TodoItem['status'], number> = { in_progress: 0, pending: 1, completed: 2, cancelled: 3 }
  return todos.map((todo, index) => ({ todo, index })).sort((left, right) => {
    const statusOrder = rank[left.todo.status] - rank[right.todo.status]
    if (statusOrder !== 0) return statusOrder
    const updatedOrder = (right.todo.updatedAt ?? 0) - (left.todo.updatedAt ?? 0)
    if (updatedOrder !== 0) return updatedOrder
    const displayOrder = (right.todo.displayNumber ?? 0) - (left.todo.displayNumber ?? 0)
    return displayOrder !== 0 ? displayOrder : left.index - right.index
  }).map(entry => entry.todo)
}

/**
 * Fold every provider's todo/plan/task events into one overlay snapshot.
 *
 * Snapshot tools (Claude TodoWrite, Grok todo_write, Codex update_plan, Pi
 * manage_todo_list, CrewCoder Task* `rawOutput.todos`) and incremental
 * mutations share this pass. Every user message starts a fresh activity scope,
 * so stale unfinished work from an earlier turn cannot look active during a
 * newer request. Project-wide CrewCoder TaskList results are ignored.
 */
export function latestTodoActivity(messages: Message[]): TodoActivitySnapshot | null {
  const items = new Map<string, TodoItem>()
  const pendingByCall = new Map<string, string>()
  let crewCodeActivity: CrewCodeActivityMessage | null = null
  let isStreaming = false
  let hasCrewCoderTaskEvents = false

  for (const msg of messages) {
    if (msg.kind === 'user') {
      items.clear()
      pendingByCall.clear()
      crewCodeActivity = null
      isStreaming = false
      hasCrewCoderTaskEvents = false
      continue
    }
    if (msg.kind === 'activity') {
      crewCodeActivity = msg
      continue
    }
    if (msg.kind !== 'toolcall') continue

    // A follow-up can be queued while the prior provider turn is still
    // emitting tools. Do not let those older-turn events populate the newer
    // unbound activity scope.
    if (crewCodeActivity && (!crewCodeActivity.turnId || msg.turnId !== crewCodeActivity.turnId)) continue

    const op = crewCoderTaskOp(msg)
    if (op && !isSessionScopedCrewCoderTask(msg, op)) continue

    if (op) {
      hasCrewCoderTaskEvents = true
      applyCrewCoderTaskTool(items, pendingByCall, msg)
    }

    const parsed = parseToolCallTodos(msg)
    if (parsed?.empty) {
      items.clear()
      pendingByCall.clear()
    } else if (parsed?.full && parsed.full.length > 0) {
      if (!parsed.keyed && isMergeUpdate(msg)) {
        applySparsePatches(items, parsed.full.map(row => ({
          id: row.id,
          status: row.item.status,
          text: row.item.text,
          activeForm: row.item.activeForm,
        })))
        applySparsePatches(items, parsed.sparse)
      } else {
        applyFullSnapshot(items, parsed.full)
        applySparsePatches(items, parsed.sparse)
      }
    } else if (parsed && parsed.sparse.length > 0) {
      applySparsePatches(items, parsed.sparse)
    }

    if (op !== 'delete') enrichFromResultTask(items, msg)

    if (msg.status === 'running' || msg.status === 'pending') isStreaming = true
  }

  if (crewCodeActivity) {
    const currentRuntime = isActivityFromCurrentRuntime(crewCodeActivity)
    const status = !currentRuntime && (crewCodeActivity.status === 'pending' || crewCodeActivity.status === 'in_progress')
      ? 'interrupted'
      : crewCodeActivity.status
    const activityStreaming = status === 'pending' || status === 'in_progress'
    const activityTodo: TodoItem = {
      status: status === 'completed' ? 'completed'
        : status === 'pending' ? 'pending'
          : status === 'in_progress' ? 'in_progress'
            : 'cancelled',
      text: status === 'interrupted' ? `Interrupted — ${crewCodeActivity.text}`
        : status === 'cancelled' ? `Cancelled — ${crewCodeActivity.text}`
          : crewCodeActivity.text,
      activeForm: activityStreaming ? crewCodeActivity.activeForm : undefined,
    }

    // Native provider todos are richer while execution is live. Once CrewCode
    // observes a terminal lifecycle event, its own outcome wins so a stale
    // provider item can never continue to claim the agent is working.
    if (!activityStreaming || items.size === 0) {
      return { todos: [activityTodo], isStreaming: activityStreaming }
    }
    const todos = [...items.values()]
    return { todos: hasCrewCoderTaskEvents ? sortLikeCrewCoderTui(todos) : todos, isStreaming: true }
  }

  if (items.size === 0) return null
  const todos = hasCrewCoderTaskEvents ? sortLikeCrewCoderTui([...items.values()]) : [...items.values()]
  const hasInProgressTask = todos.some(item => item.status === 'in_progress')
  return { todos, isStreaming: isStreaming || hasInProgressTask }
}

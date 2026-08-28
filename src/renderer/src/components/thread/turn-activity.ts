import type { CrewCodeActivityMessage, CrewCodeActivityStatus, Message } from '../../types'

export const TURN_ACTIVITY_RUNTIME_ID = `activity-runtime-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`

const TERMINAL_STATUSES = new Set<CrewCodeActivityStatus>(['completed', 'cancelled', 'interrupted'])

export function summarizeActivityRequest(text: string): string {
  const compact = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!compact) return 'Process request'
  return compact.length > 96 ? `${compact.slice(0, 93).trimEnd()}...` : compact
}

export function createTurnActivity(text: string, time: string): CrewCodeActivityMessage {
  return {
    kind: 'activity',
    time,
    activityRunId: `activity-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    runtimeId: TURN_ACTIVITY_RUNTIME_ID,
    text: summarizeActivityRequest(text),
    status: 'pending',
    activeForm: 'Starting request',
  }
}

interface ActivityPatch {
  status?: CrewCodeActivityStatus
  activeForm?: string
  turnId?: string
}

function patchActivity(activity: CrewCodeActivityMessage, patch: ActivityPatch): CrewCodeActivityMessage {
  if (TERMINAL_STATUSES.has(activity.status)) return activity
  if ((patch.status === undefined || patch.status === activity.status)
    && (patch.activeForm === undefined || patch.activeForm === activity.activeForm)
    && (patch.turnId === undefined || patch.turnId === activity.turnId)) return activity
  return { ...activity, ...patch }
}

/** Bind the oldest queued activity in this scope to the observed provider turn. */
export function startNextTurnActivity(messages: Message[], turnId: string): Message[] {
  const index = messages.findIndex(message => message.kind === 'activity'
    && message.runtimeId === TURN_ACTIVITY_RUNTIME_ID
    && !message.turnId
    && !TERMINAL_STATUSES.has(message.status))
  if (index === -1) return messages
  const next = messages.slice()
  next[index] = patchActivity(next[index] as CrewCodeActivityMessage, {
    status: 'in_progress',
    activeForm: 'Working on request',
    turnId,
  })
  return next
}

export function updateTurnActivity(messages: Message[], turnId: string | undefined, patch: ActivityPatch): Message[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.kind !== 'activity' || message.runtimeId !== TURN_ACTIVITY_RUNTIME_ID) continue
    if (turnId && message.turnId !== turnId) continue
    if (!turnId && TERMINAL_STATUSES.has(message.status)) continue
    const updated = patchActivity(message, patch)
    if (updated === message) return messages
    const next = messages.slice()
    next[index] = updated
    return next
  }
  return messages
}

export function settleCurrentTurnActivity(
  messages: Message[],
  status: Extract<CrewCodeActivityStatus, 'completed' | 'cancelled' | 'interrupted'>,
  turnId?: string,
): Message[] {
  const activeForm = status === 'completed' ? 'Request completed'
    : status === 'cancelled' ? 'Request cancelled'
      : 'Request interrupted'
  return updateTurnActivity(messages, turnId, { status, activeForm })
}

/** Settle every non-terminal activity owned by this renderer runtime. */
export function settleActiveTurnActivities(
  messages: Message[],
  status: Extract<CrewCodeActivityStatus, 'cancelled' | 'interrupted'>,
): Message[] {
  const activeForm = status === 'cancelled' ? 'Request cancelled' : 'Request interrupted'
  let changed = false
  const next = messages.map(message => {
    if (message.kind !== 'activity'
      || message.runtimeId !== TURN_ACTIVITY_RUNTIME_ID
      || TERMINAL_STATUSES.has(message.status)) return message
    changed = true
    return { ...message, status, activeForm }
  })
  return changed ? next : messages
}

export function activityFormForTool(toolName: string): string {
  const compact = toolName.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (/(todo|task|plan)/.test(compact)) return 'Updating task progress'
  if (/(grep|search|find|glob)/.test(compact)) return 'Searching workspace'
  if (/(read|get|list|cat)/.test(compact)) return 'Reading workspace'
  if (/(edit|write|patch|create|delete|remove|move|rename)/.test(compact)) return 'Editing workspace'
  if (/(bash|shell|exec|command|terminal|test)/.test(compact)) return 'Running a command'
  return 'Using agent tools'
}

export function isActivityFromCurrentRuntime(activity: CrewCodeActivityMessage): boolean {
  return activity.runtimeId === TURN_ACTIVITY_RUNTIME_ID
}

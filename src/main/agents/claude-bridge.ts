import { query, resolveSettings, type CanUseTool, type PermissionMode, type PermissionResult, type Query, type SDKControlGetContextUsageResponse, type SDKMessage, type Settings } from '@anthropic-ai/claude-agent-sdk'
import type { AgentBridge, AgentUserRequest, AgentUserResponse, BridgeStartOpts, ContextCategory, EmitFn, ModeLevel, PromptOptions, RequestUserFn, TurnUsage } from './bridge-types'
import { buildUsage, contextWindowFor } from './model-context'
import { tripwireForToolCall, extractShellCommand } from './dangerous-command'

// Claude Code is driven through the official Agent SDK's `query()` rather than a
// hand-spawned `claude -p` + stream-json parse. The SDK still runs the installed
// claude binary under the hood (we point it at the resolved path), but gives us a
// typed message stream and a `canUseTool` permission callback instead of writing
// `permission_response` frames back over stdin. One `query()` runs per turn and we
// resume the prior session via `options.resume`.

const READ_ONLY_DISALLOWED_TOOLS = [
  'Bash',
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
]

// Plan mode additionally blocks ExitPlanMode. The SDK auto-resolves that tool
// ("Plan approved") without routing it through canUseTool, so Claude would exit
// plan mode and start coding on its own. Denying the tool keeps planning text-only
// and leaves the plan→Build switch to the user, matching codex/hermes/pi.
const PLAN_DISALLOWED_TOOLS = [...READ_ONLY_DISALLOWED_TOOLS, 'ExitPlanMode']

export async function getClaudeCompactionSettings(cwd: string): Promise<Settings | undefined> {
  try {
    // Read only the resolved scalar from Claude Code's user/global settings.
    // The query itself still excludes the user source so global skills/plugins
    // cannot inflate CrewCode's system prompt.
    const resolved = await resolveSettings({ cwd, settingSources: ['user'] })
    const enabled = resolved.effective.autoCompactEnabled
    return typeof enabled === 'boolean' ? { autoCompactEnabled: enabled } : undefined
  } catch {
    // Fail open to Claude's native default instead of silently disabling its
    // compaction policy when settings resolution is unavailable.
    return undefined
  }
}

export interface ClaudeModeOptions {
  permissionMode: PermissionMode
  disallowedTools?: string[]
  // bypassPermissions is gated behind this flag in the SDK; only full sets it.
  allowDangerouslySkipPermissions?: boolean
}

export function getClaudeModeOptions(mode?: ModeLevel, toolPolicy?: BridgeStartOpts['toolPolicy']): ClaudeModeOptions {
  if (toolPolicy === 'read-only') return { permissionMode: 'default', disallowedTools: PLAN_DISALLOWED_TOOLS }
  switch (mode) {
    case 'ask':
      return { permissionMode: 'default', disallowedTools: READ_ONLY_DISALLOWED_TOOLS }
    case 'plan':
      // Plan mode is read-only here, NOT the SDK's native `permissionMode: 'plan'`.
      // In headless/SDK mode the claude binary auto-approves its own ExitPlanMode
      // tool ("User has approved your plan") and starts coding without surfacing
      // the plan — bypassing CrewCode's user-driven plan→Build transition. Block
      // writes/exec AND ExitPlanMode so the agent only produces a plan and the
      // user switches to Build mode in the composer, matching codex/hermes/pi.
      return { permissionMode: 'default', disallowedTools: PLAN_DISALLOWED_TOOLS }
    case 'full':
      // Full Access stays autonomous, but we route through the SDK's canUseTool
      // callback (permissionMode 'default') instead of the native bypassPermissions
      // so the Full Access tripwire can see each command and pause catastrophic
      // ones (rm -rf, force-push, curl|sh, ...). canUseTool auto-approves everything
      // the denylist does not flag, so benign commands stay friction-free.
      return { permissionMode: 'default' }
    case 'build':
    default:
      return { permissionMode: 'default' }
  }
}

export function allowClaudeToolInput(input: Record<string, unknown>): PermissionResult {
  // Newer Claude Code permission bridges validate allowed decisions against the
  // input-carrying branch; echoing the original input preserves the tool call.
  return { behavior: 'allow', updatedInput: input }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

interface ClaudeQuestionOption {
  id: string
  label: string
  description?: string
  preview?: string
}

interface ClaudeAskUserQuestionRequest {
  questionText: string
  kind: AgentUserRequest['kind']
  title: string
  message?: string
  detail?: string
  options?: ClaudeQuestionOption[]
  placeholder?: string
  optionsById: Record<string, ClaudeQuestionOption>
}

function isAskUserQuestionTool(toolName: string): boolean {
  // Claude normally reports the bare built-in name, but some bridge/SDK paths
  // qualify tool names. Matching the last delimited segment keeps a real
  // question out of the generic permission path, where Full Access would allow
  // unanswered input and Claude would immediately report it as denied.
  const segment = toolName.split(/[^a-z0-9]+/i).filter(Boolean).at(-1) ?? ''
  return segment.toLowerCase() === 'askuserquestion'
}

function isExitPlanModeTool(toolName: string): boolean {
  return toolName.replace(/[^a-z]/gi, '').toLowerCase() === 'exitplanmode'
}

function normalizeClaudeQuestionOption(option: unknown, index: number, seen: Set<string>): ClaudeQuestionOption | null {
  const row = objectValue(option)
  if (!row) return null
  const label = stringValue(row.label)?.trim()
  if (!label) return null
  const baseId = label || String(index + 1)
  const id = seen.has(baseId) ? `${baseId}-${index + 1}` : baseId
  seen.add(id)
  return {
    id,
    label,
    description: stringValue(row.description),
    preview: stringValue(row.preview),
  }
}

function claudeQuestionRows(input: Record<string, unknown>): Record<string, unknown>[] {
  // Current Claude SDKs send `questions: [...]`. Keep accepting the original
  // single-question shape as well: older/resumed Claude sessions can still
  // deliver `{ question, options, ... }`, and treating that as an ordinary
  // permission leaves it unanswered (which Claude surfaces as an auto-denial).
  const rawQuestions = Array.isArray(input.questions)
    ? input.questions
    : objectValue(input.questions)
      ? [input.questions]
      : stringValue(input.question)?.trim()
        ? [input]
        : []
  return rawQuestions
    .map(objectValue)
    .filter((question): question is Record<string, unknown> => !!stringValue(question?.question)?.trim())
}

export function claudeAskUserQuestionRequest(input: Record<string, unknown>, index = 0): ClaudeAskUserQuestionRequest | null {
  const questions = claudeQuestionRows(input)
  const question = questions[index]
  if (!question) return null

  const questionText = stringValue(question.question)?.trim()
  if (!questionText) return null

  const seen = new Set<string>()
  const options = (Array.isArray(question.options) ? question.options : [])
    .map((option, index) => normalizeClaudeQuestionOption(option, index, seen))
    .filter((option): option is ClaudeQuestionOption => !!option)
  const optionsById = Object.fromEntries(options.map(option => [option.id, option]))
  const header = stringValue(question.header)
  const progress = questions.length > 1 ? `Question ${index + 1} of ${questions.length}.` : undefined
  const multiple = question.multiple === true || question.multiSelect === true
  const allowsCustom = question.custom === true || question.allowFreeform === true
  const detail = multiple && options.length > 0
    ? options.map(option => `- ${option.label}${option.description ? ` — ${option.description}` : ''}`).join('\n')
    : undefined
  return {
    questionText,
    kind: multiple ? 'editor' : allowsCustom || options.length === 0 ? 'prompt' : 'select',
    title: questionText,
    message: [header ? `Claude asks: ${header}` : undefined, progress].filter(Boolean).join(' ') || undefined,
    detail,
    options: multiple ? undefined : options,
    placeholder: allowsCustom ? 'reply to Claude…' : undefined,
    optionsById,
  }
}

export function answerClaudeAskUserQuestionInput(input: Record<string, unknown>, response: AgentUserResponse, index = 0): Record<string, unknown> {
  const request = claudeAskUserQuestionRequest(input, index)
  if (!request) return input
  const selected = response.optionId ? request.optionsById[response.optionId] : undefined
  const answer = selected?.label ?? response.value ?? response.optionId ?? ''
  const answers = objectValue(input.answers) ?? {}
  const updated: Record<string, unknown> = {
    ...input,
    answers: { ...answers, [request.questionText]: answer },
  }
  if (selected?.preview) {
    const annotations = objectValue(input.annotations) ?? {}
    updated.annotations = {
      ...annotations,
      [request.questionText]: { ...(objectValue(annotations[request.questionText]) ?? {}), preview: selected.preview },
    }
  }
  return updated
}

// Result usage is aggregate turn/API billing data. It is only a fallback for the
// ctx pill; Claude SDK getContextUsage() is the authoritative context gauge.
function usageFromResult(usage: unknown, model: string | undefined): TurnUsage | undefined {
  const u = usage as Record<string, unknown> | undefined
  if (!u || typeof u !== 'object') return undefined
  const input = numberValue(u.input_tokens)
  const output = numberValue(u.output_tokens)
  const cacheCreation = numberValue(u.cache_creation_input_tokens) ?? 0
  const cacheRead = numberValue(u.cache_read_input_tokens) ?? 0
  const contextWindow = contextWindowFor(model)
  const withCache = (input ?? 0) + cacheCreation + cacheRead + (output ?? 0)
  const withoutCacheRead = (input ?? 0) + cacheCreation + (output ?? 0)
  // Fallback only: keep ctx-pop useful on SDK/control failures without letting
  // repeated cache-read billing become 4M context.
  const contextTokens = contextWindow && withCache > contextWindow * 1.1 ? withoutCacheRead : withCache
  return buildUsage({
    inputTokens:   input,
    outputTokens:  output,
    contextTokens,
    contextWindow,
    model,
  })
}

// Claude's category list is built to fill the /context grid, so it ends with
// synthetic *capacity* rows — the unused remainder ("Free space") and the
// reserved compaction headroom — sized so every non-deferred category sums to
// exactly maxTokens. Counting them as usage pins the meter at 100% forever.
const CLAUDE_CAPACITY_CATEGORIES = new Set(['free space', 'autocompact buffer', 'compact buffer'])

function isClaudeCapacityCategory(name: unknown): boolean {
  const label = stringValue(name)?.trim().toLowerCase()
  return label !== undefined && CLAUDE_CAPACITY_CATEGORIES.has(label)
}

function claudeCategoryTokenSums(context: SDKControlGetContextUsageResponse): { active: number; deferred: number } {
  return context.categories.reduce((sum, category) => {
    if (isClaudeCapacityCategory(category.name)) return sum
    const tokens = numberValue(category.tokens) ?? 0
    if (category.isDeferred) sum.deferred += tokens
    else sum.active += tokens
    return sum
  }, { active: 0, deferred: 0 })
}

function activeClaudeContextTokens(context: SDKControlGetContextUsageResponse): number | undefined {
  const total = numberValue(context.totalTokens)
  const max = numberValue(context.maxTokens) ?? numberValue(context.rawMaxTokens)
  const { active } = claudeCategoryTokenSums(context)
  // Claude can report large deferred/reserved categories in totalTokens. Those
  // are useful for Claude's own compaction logic, but they make CrewCode's live
  // chat meter look full after a tiny prompt.
  const used = active > 0 && (total === undefined || active < total) ? active : total
  if (used === undefined) return undefined
  // totalTokens can exceed the window (Claude derives it from cumulative API
  // usage, which double-counts cache reads across a resumed thread). Live
  // context physically cannot, so cap it instead of rendering >=100%.
  return max !== undefined && max > 0 ? Math.min(used, max) : used
}

function pushContextRow(rows: ContextCategory[], name: string, tokens: unknown, deferred?: boolean): void {
  const value = numberValue(tokens)
  if (!value || value <= 0) return
  rows.push({ name, tokens: value, ...(deferred ? { deferred: true } : {}) })
}

function claudeContextBreakdown(context: SDKControlGetContextUsageResponse): ContextCategory[] {
  const rows: ContextCategory[] = []
  const total = numberValue(context.totalTokens)
  const max = numberValue(context.maxTokens)
  const rawMax = numberValue(context.rawMaxTokens)
  const sums = claudeCategoryTokenSums(context)

  // Reconciliation rows make SDK/math bugs obvious in the UI: compare the pill
  // with what Claude SDK reported and what CrewCode summed from active categories.
  pushContextRow(rows, 'sdk:totalTokens', total)
  pushContextRow(rows, 'sdk:active category sum', sums.active)
  pushContextRow(rows, 'sdk:deferred category sum', sums.deferred, true)
  pushContextRow(rows, 'sdk:maxTokens', max)
  if (rawMax !== max) pushContextRow(rows, 'sdk:rawMaxTokens', rawMax)

  for (const category of context.categories) {
    // Capacity rows are headroom, not consumption — show them flagged so the
    // list still reconciles against maxTokens without reading as usage.
    const capacity = isClaudeCapacityCategory(category.name)
    const name = stringValue(category.name) ?? 'unknown'
    pushContextRow(rows, capacity ? `${name} (unused headroom)` : name, category.tokens, capacity || category.isDeferred === true)
  }

  // The top-level categories can say "tools" or "system" without explaining why
  // the first prompt is huge. Surface the SDK's detailed contributors so the UI
  // can show whether the cost is MCP/tool schemas, skills, commands, attachments,
  // repo guidance, or actual messages.
  for (const tool of context.mcpTools ?? []) {
    pushContextRow(rows, `mcp:${tool.serverName}/${tool.name}${tool.isLoaded === false ? ' (not loaded)' : ''}`, tool.tokens, tool.isLoaded === false)
  }
  for (const tool of context.deferredBuiltinTools ?? []) {
    pushContextRow(rows, `builtin:${tool.name}${tool.isLoaded === false ? ' (deferred)' : ''}`, tool.tokens, tool.isLoaded === false)
  }
  for (const tool of context.systemTools ?? []) {
    pushContextRow(rows, `system tool:${tool.name}`, tool.tokens)
  }
  for (const section of context.systemPromptSections ?? []) {
    pushContextRow(rows, `system:${section.name}`, section.tokens)
  }
  for (const file of context.memoryFiles ?? []) {
    pushContextRow(rows, `memory:${file.type}:${file.path}`, file.tokens)
  }
  for (const agent of context.agents ?? []) {
    pushContextRow(rows, `agent:${agent.source}/${agent.agentType}`, agent.tokens)
  }
  if (context.slashCommands) {
    pushContextRow(rows, `slash commands (${context.slashCommands.includedCommands}/${context.slashCommands.totalCommands})`, context.slashCommands.tokens)
  }
  if (context.skills) {
    pushContextRow(rows, `skills (${context.skills.includedSkills}/${context.skills.totalSkills})`, context.skills.tokens)
    for (const skill of context.skills.skillFrontmatter ?? []) {
      pushContextRow(rows, `skill:${skill.source}/${skill.name}`, skill.tokens)
    }
  }
  const messages = context.messageBreakdown
  if (messages) {
    pushContextRow(rows, 'messages:user', messages.userMessageTokens)
    pushContextRow(rows, 'messages:assistant', messages.assistantMessageTokens)
    pushContextRow(rows, 'messages:tool calls', messages.toolCallTokens)
    pushContextRow(rows, 'messages:tool results', messages.toolResultTokens)
    pushContextRow(rows, 'messages:attachments', messages.attachmentTokens)
    pushContextRow(rows, 'messages:redirected context', messages.redirectedContextTokens)
    pushContextRow(rows, 'messages:unattributed', messages.unattributedTokens)
    for (const tool of messages.toolCallsByType ?? []) {
      pushContextRow(rows, `tool calls:${tool.name}`, tool.callTokens + tool.resultTokens)
    }
    for (const attachment of messages.attachmentsByType ?? []) {
      pushContextRow(rows, `attachment:${attachment.name}`, attachment.tokens)
    }
  }
  if (context.apiUsage) {
    pushContextRow(rows, 'api usage:input', context.apiUsage.input_tokens)
    pushContextRow(rows, 'api usage:output', context.apiUsage.output_tokens)
    pushContextRow(rows, 'api usage:cache create', context.apiUsage.cache_creation_input_tokens)
    pushContextRow(rows, 'api usage:cache read', context.apiUsage.cache_read_input_tokens)
  }

  return rows
    .filter(category => category.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 80)
}

function claudeContextWindow(model: string | undefined, context: SDKControlGetContextUsageResponse | undefined): number | undefined {
  // SDK maxTokens is the effective active window for the current Claude model.
  // Static model rules are only fallback for SDK/control failures.
  return numberValue(context?.maxTokens) ?? numberValue(context?.rawMaxTokens) ?? contextWindowFor(model) ?? contextWindowFor('claude')
}

function applyClaudeContextUsage(usage: TurnUsage | undefined, context: SDKControlGetContextUsageResponse | undefined, stale = false): TurnUsage | undefined {
  if (!context) return usage
  const liveContextTokens = activeClaudeContextTokens(context)
  const model = usage?.model ?? stringValue(context.model)
  const contextWindow = claudeContextWindow(model, context)
  const breakdown = claudeContextBreakdown(context)
  // A stale reading is the previous turn's gauge, reused because the control
  // API failed after this turn's result. Flag it so the tooltip stays honest.
  if (stale && liveContextTokens !== undefined && liveContextTokens > 0) {
    breakdown.unshift({ name: 'sdk:reading reused from previous turn (control api unavailable)', tokens: liveContextTokens })
  }
  return {
    ...(usage ?? {}),
    // SDK getContextUsage() is the source of truth for the context gauge.
    // Result usage is billing/request accounting and only fills in when the
    // control API is unavailable.
    ...(liveContextTokens !== undefined ? { contextTokens: liveContextTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(model ? { model } : {}),
    ...(breakdown.length > 0 ? { contextBreakdown: breakdown } : {}),
  }
}

async function readClaudeContextUsage(q: Query): Promise<SDKControlGetContextUsageResponse | undefined> {
  if (typeof q.getContextUsage !== 'function') return undefined
  try {
    return await q.getContextUsage()
  } catch {
    return undefined
  }
}

function suffixDelta(previous: string, next: string): string {
  if (!next) return ''
  if (!previous) return next
  if (next.startsWith(previous)) return next.slice(previous.length)
  return next
}

export async function createClaudeBridge(
  claudePath: string,
  opts: BridgeStartOpts,
  emit: EmitFn,
  requestUser?: RequestUserFn,
): Promise<AgentBridge> {
  const claudeThinking = opts.thinking
  if (claudeThinking === 'ultra') throw new Error('Claude does not support reasoning effort "ultra"')

  const compactionSettings = await getClaudeCompactionSettings(opts.cwd)
  let currentQuery: Query | null = null
  let abortController: AbortController | null = null
  let currentTurnId: string | null = null
  let sessionId = opts.resumeSessionId ?? null
  let sessionModel = opts.model
  let emittedSession = false
  let running = false
  let aborted = false
  let followUpSeq = 0
  const followUpQueue: Array<{ id: string; text: string; options?: PromptOptions }> = []
  type ClaudeTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused'
  interface ClaudeTaskState { description: string; status: ClaudeTaskStatus }
  const claudeTasks = new Map<string, ClaudeTaskState>()
  const ignoredClaudeTaskIds = new Set<string>()
  let claudeTaskToolCallId: string | null = null

  // Every queue mutation is mirrored to the renderer so the composer can show
  // pending follow-ups and offer cancellation before they are sent.
  function clearFollowUps(reason: 'removed' | 'cleared'): void {
    for (const item of followUpQueue) {
      emit({ type: 'follow_up_removed', bridgeId: opts.bridgeId, followUpId: item.id, reason })
    }
    followUpQueue.length = 0
  }
  // The ctx gauge must not bounce: getContextUsage() can fail right after a
  // turn's result (the control channel races the per-turn query shutdown), and
  // the billing-based fallback swings wildly with per-turn API-call counts.
  // Cache the last good SDK reading and reuse it so the meter only moves on
  // real SDK data; billing math is the fallback only before any reading exists.
  let lastContextUsage: SDKControlGetContextUsageResponse | undefined

  async function applyStableContextUsage(usage: TurnUsage | undefined, q: Query): Promise<TurnUsage | undefined> {
    const context = await readClaudeContextUsage(q)
    if (context) {
      lastContextUsage = context
      return applyClaudeContextUsage(usage, context)
    }
    return applyClaudeContextUsage(usage, lastContextUsage, true)
  }

  queueMicrotask(() => emit({ type: 'ready', bridgeId: opts.bridgeId }))

  function emitSession(id: string) {
    if (!id || (id === sessionId && emittedSession)) return
    // Claude Code forks a *new* session id every time it resumes (and every
    // query() turn), so the returned id never matches the one we passed to
    // `options.resume`. Don't string-match it: the SDK loads the requested
    // session (it would have thrown on a bad id), so a resume request that
    // produced an init = a successful resume. Reporting resumed=true keeps
    // index.ts from falling back to literal <conversation_history> replay.
    const resumed = !!opts.resumeSessionId
    sessionId = id
    emittedSession = true
    emit({ type: 'session_id', bridgeId: opts.bridgeId, sessionId: id, resumed })
  }

  function resetClaudeTasks(): void {
    claudeTasks.clear()
    ignoredClaudeTaskIds.clear()
    claudeTaskToolCallId = null
  }

  function claudeTaskTodos() {
    return Array.from(claudeTasks.values()).map(task => ({
      content: task.description,
      status:
        task.status === 'running' ? 'in_progress'
          : task.status === 'completed' ? 'completed'
            : task.status === 'failed' || task.status === 'killed' ? 'cancelled'
              : 'pending',
      activeForm: task.status === 'running' ? task.description : undefined,
    }))
  }

  function emitClaudeTaskSnapshot(turnId: string): void {
    const todos = claudeTaskTodos()
    if (todos.length === 0) return
    const args = { todos }
    if (!claudeTaskToolCallId) {
      claudeTaskToolCallId = `${turnId}-claude-tasks`
      emit({
        type: 'tool_start', bridgeId: opts.bridgeId, turnId,
        toolCallId: claudeTaskToolCallId, toolName: 'claude_tasks', args,
      })
      return
    }
    emit({
      type: 'tool_update', bridgeId: opts.bridgeId, turnId,
      toolCallId: claudeTaskToolCallId, partial: args, args, title: 'Claude tasks',
    })
  }

  function startTurn(): string {
    resetClaudeTasks()
    currentTurnId = `${opts.bridgeId}-t-${Date.now().toString(36)}`
    emit({ type: 'turn_start', bridgeId: opts.bridgeId, turnId: currentTurnId })
    return currentTurnId
  }

  function endTurn(outcome: 'success' | 'error' | 'aborted', usage?: TurnUsage) {
    if (!currentTurnId) return
    if (claudeTaskToolCallId) {
      // Some Claude SDK versions end the query without a terminal task_updated.
      // A settled turn must not leave the synthetic activity row running forever.
      for (const task of claudeTasks.values()) {
        if (task.status !== 'running') continue
        task.status = outcome === 'success' ? 'completed' : 'killed'
      }
      const todos = claudeTaskTodos()
      emit({
        type: 'tool_end', bridgeId: opts.bridgeId, turnId: currentTurnId,
        toolCallId: claudeTaskToolCallId, result: { todos }, args: { todos }, isError: false,
        title: 'Claude tasks',
      })
    }
    emit({ type: 'turn_end', bridgeId: opts.bridgeId, turnId: currentTurnId, usage })
    currentTurnId = null
    resetClaudeTasks()
  }

  // The SDK invokes this when a tool needs runtime approval (permissionMode
  // 'default'). We surface the overlay and translate the decision back to the
  // SDK's allow/deny contract — no stdin frame to write anymore.
  const canUseTool: CanUseTool = async (toolName, input, { decisionReason, title, displayName, description, toolUseID }) => {
    const turnId = currentTurnId ?? startTurn()
    if (!isAskUserQuestionTool(toolName)) {
      // canUseTool fires before Claude mutates the workspace; emitting here lets
      // the renderer snapshot files before edits so Pierre can show real diffs.
      emit({ type: 'tool_start', bridgeId: opts.bridgeId, turnId, toolCallId: toolUseID, toolName, args: input })
    }
    // Fallback to the disallowedTools block: if a future SDK does route
    // ExitPlanMode through canUseTool, deny it in plan/ask so Claude can't
    // self-approve its plan and start coding — the user drives plan→Build.
    if (isExitPlanModeTool(toolName) && (opts.toolPolicy === 'read-only' || opts.mode === 'plan' || opts.mode === 'ask')) {
      emit({ type: 'tool_end', bridgeId: opts.bridgeId, turnId, toolCallId: toolUseID, result: 'plan mode is read-only — switch to Build to proceed', isError: true })
      return { behavior: 'deny', message: 'Plan mode is read-only in CrewCode. Present your plan; the user will switch to Build mode to proceed.' }
    }

    // Full Access must stay autonomous even when switching modes on an existing
    // bridge — but a hard denylist of catastrophic commands still pauses for
    // confirmation (the Full Access tripwire). Everything else auto-approves.
    if (opts.mode === 'full' && opts.toolPolicy !== 'read-only' && !isAskUserQuestionTool(toolName)) {
      const verdict = tripwireForToolCall(toolName, input)
      if (!verdict.dangerous) return allowClaudeToolInput(input)
      const command = extractShellCommand(toolName, input) ?? ''
      if (!requestUser) {
        // No human to ask (headless/detached) — fail safe by blocking.
        emit({ type: 'tool_end', bridgeId: opts.bridgeId, turnId, toolCallId: toolUseID, result: `Full Access tripwire blocked: ${verdict.reason}`, isError: true })
        return { behavior: 'deny', message: `Blocked by Full Access tripwire (${verdict.rule}): ${verdict.reason}` }
      }
      const response = await requestUser({
        kind:      'permission',
        turnId,
        title:     'Full Access tripwire — confirm dangerous command',
        message:   verdict.reason,
        detail:    command,
        options:   [
          { id: 'allow_once', label: 'Run once', description: 'Execute this command this one time' },
          { id: 'reject',     label: 'Block',    description: 'Do not run this command' },
        ],
        dangerous: true,
        source:    'claude',
      })
      const approved = (response.action === 'accept' || response.action === 'accept_for_turn' || response.action === 'submit') && response.optionId !== 'reject'
      if (approved) return allowClaudeToolInput(input)
      emit({ type: 'tool_end', bridgeId: opts.bridgeId, turnId, toolCallId: toolUseID, result: `Blocked by Full Access tripwire: ${verdict.reason}`, isError: true })
      return { behavior: 'deny', message: `User blocked this command at the Full Access tripwire (${verdict.rule}).` }
    }

    if (!requestUser) return allowClaudeToolInput(input)

    if (isAskUserQuestionTool(toolName)) {
      let updatedInput = input
      for (let index = 0; ; index++) {
        const questionRequest = claudeAskUserQuestionRequest(input, index)
        if (!questionRequest) {
          if (index > 0) return { behavior: 'allow', updatedInput }
          break
        }
        const response = await requestUser({
          kind:        questionRequest.kind,
          turnId,
          title:       questionRequest.title,
          message:     questionRequest.message,
          detail:      questionRequest.detail,
          options:     questionRequest.options,
          placeholder: questionRequest.placeholder,
          source:      'claude',
        })
        if (response.action === 'cancel' || response.action === 'decline') {
          return { behavior: 'deny', message: 'cancelled by user' }
        }
        updatedInput = answerClaudeAskUserQuestionInput(updatedInput, response, index)
      }
    }

    const detail = input != null ? JSON.stringify(input, null, 2).slice(0, 1200) : undefined
    const response = await requestUser({
      kind:      'permission',
      turnId,
      title:     title ?? `allow ${displayName ?? toolName}`,
      message:   description ?? decisionReason,
      detail,
      dangerous: true,
      source:    'claude',
    })
    if (response.action === 'accept' || response.action === 'submit') return allowClaudeToolInput(input)
    emit({ type: 'tool_end', bridgeId: opts.bridgeId, turnId, toolCallId: toolUseID, result: 'denied by user', isError: true })
    return { behavior: 'deny', message: 'denied by user' }
  }

  interface TurnState {
    sawStreamEvent: boolean
    emittedAnyText: boolean
    // Stream events carry block type separately from later deltas; keep it so
    // text-shaped thinking chunks do not render as final assistant messages.
    streamBlockTypeByIndex: Record<string, string>
    // Per-block cumulative text for the no-partial fallback path.
    textByBlock: Record<string, string>
    thinkingByBlock: Record<string, string>
    // Text actually forwarded from raw stream events. Assembled assistant
    // messages may contain readable reasoning even when partial events were
    // redacted/empty, so dedupe by content rather than skipping wholesale.
    streamedText: string
    streamedThinking: string
    // Redacted-thinking progress (Opus effort thinking streams empty deltas
    // with only an estimated_tokens counter — see handleStreamEvent).
    thinkingTokens: number
    thinkingStatusActive: boolean
  }

  function isThinkingBlockType(type: string | undefined): boolean {
    return type === 'thinking' || type === 'redacted_thinking' || type === 'reasoning'
  }

  // Token-level deltas arrive as raw Anthropic stream events when
  // includePartialMessages is on; these are already incremental so we forward
  // them straight through.
  function handleStreamEvent(turnId: string, event: Record<string, unknown>, state: TurnState) {
    state.sawStreamEvent = true
    const eventType = stringValue(event.type)
    const index = numberValue(event.index)

    const clearThinkingStatus = () => {
      if (!state.thinkingStatusActive) return
      state.thinkingStatusActive = false
      emit({ type: 'status', bridgeId: opts.bridgeId, message: '' })
    }

    if (eventType === 'content_block_start' && index !== undefined) {
      const block = objectValue(event.content_block)
      const blockType = stringValue(block?.type)
      if (blockType) {
        state.streamBlockTypeByIndex[String(index)] = blockType
        // Reasoning is over once a text/tool block opens — drop the meter.
        if (!isThinkingBlockType(blockType)) clearThinkingStatus()
      }
      return
    }

    if (eventType !== 'content_block_delta') return
    const delta = event.delta as Record<string, unknown> | undefined
    const deltaType = stringValue(delta?.type)
    const blockType = index === undefined ? undefined : state.streamBlockTypeByIndex[String(index)]
    if (deltaType === 'text_delta') {
      const text = stringValue(delta?.text) ?? ''
      if (!text) return
      clearThinkingStatus()
      if (isThinkingBlockType(blockType)) {
        state.streamedThinking += text
        emit({ type: 'thinking_delta', bridgeId: opts.bridgeId, turnId, delta: text })
      } else {
        state.emittedAnyText = true
        state.streamedText += text
        emit({ type: 'text_delta', bridgeId: opts.bridgeId, turnId, delta: text })
      }
    } else if (deltaType === 'thinking_delta') {
      // Some SDK versions carry the thinking text under `text` instead of
      // `thinking`; falling back prevents silently dropping the whole stream.
      const text = stringValue(delta?.thinking) ?? stringValue(delta?.text) ?? ''
      if (text) {
        state.streamedThinking += text
        emit({ type: 'thinking_delta', bridgeId: opts.bridgeId, turnId, delta: text })
        return
      }
      // Opus-class effort thinking streams *redacted* reasoning: thinking_delta
      // events with empty text plus an estimated_tokens counter. There is no
      // content to render as a THOUGHTS block, so surface progress as transient
      // status (mirrors Claude Code's own "Thinking…" meter) instead of silence.
      const estimated = numberValue(delta?.estimated_tokens)
      if (estimated !== undefined) {
        // Treat the counter as monotonic; max() is safe whether the SDK reports
        // cumulative or per-chunk estimates (worst case we under-report).
        state.thinkingTokens = Math.max(state.thinkingTokens, estimated)
        state.thinkingStatusActive = true
        emit({ type: 'status', bridgeId: opts.bridgeId, message: `Thinking… ~${state.thinkingTokens} tokens` })
      }
    }
  }

  // Assistant messages carry fully-assembled content blocks. tool_use blocks
  // come from here (complete input). text/thinking are only re-emitted here as a
  // fallback when the binary didn't deliver partial stream events.
  function handleAssistantMessage(turnId: string, message: Record<string, unknown>, state: TurnState) {
    const content = message.content
    if (!Array.isArray(content)) return
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue
      const block = raw as Record<string, unknown>
      const type = stringValue(block.type) ?? ''

      if (type === 'tool_use') {
        const toolId = stringValue(block.id) ?? `tool:${turnId}:${Object.keys(state.textByBlock).length}`
        emit({ type: 'tool_start', bridgeId: opts.bridgeId, turnId, toolCallId: toolId, toolName: stringValue(block.name) ?? 'tool', args: block.input })
        continue
      }

      if (type === 'text') {
        // Raw final-answer deltas are authoritative. Never replay an assembled
        // version after any final text streamed: harmless normalization changes
        // (whitespace, block joins) make suffix comparison return the full reply.
        if (state.streamedText) continue
        const blockId = stringValue(block.id) ?? `text:${Object.keys(state.textByBlock).length}`
        const next = stringValue(block.text) ?? ''
        const delta = suffixDelta(state.textByBlock[blockId] ?? '', next)
        state.textByBlock[blockId] = next
        if (delta) { state.emittedAnyText = true; emit({ type: 'text_delta', bridgeId: opts.bridgeId, turnId, delta }) }
      } else if (type === 'thinking' || type === 'redacted_thinking' || type === 'reasoning') {
        const blockId = stringValue(block.id) ?? `thinking:${Object.keys(state.thinkingByBlock).length}`
        const next = stringValue(block.thinking) ?? stringValue(block.text) ?? stringValue(block.reasoning) ?? ''
        const prior = state.thinkingByBlock[blockId] ?? state.streamedThinking
        const delta = suffixDelta(prior, next)
        state.thinkingByBlock[blockId] = next
        if (delta) emit({ type: 'thinking_delta', bridgeId: opts.bridgeId, turnId, delta })
      }
    }
  }

  // Tool results ride back as user-role messages with tool_result content blocks.
  function handleUserMessage(turnId: string, message: Record<string, unknown>) {
    const content = message.content
    if (!Array.isArray(content)) return
    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue
      const block = raw as Record<string, unknown>
      if (stringValue(block.type) !== 'tool_result') continue
      const toolId = stringValue(block.tool_use_id) ?? ''
      if (!toolId) continue
      emit({ type: 'tool_end', bridgeId: opts.bridgeId, turnId, toolCallId: toolId, result: block.content, isError: !!block.is_error })
    }
  }

  function handleMessage(message: SDKMessage, turnId: string, state: TurnState): TurnUsage | undefined {
    const sid = (message as { session_id?: unknown }).session_id
    if (typeof sid === 'string') emitSession(sid)

    switch (message.type) {
      case 'system':
        if (message.subtype === 'init' && typeof message.model === 'string') sessionModel = message.model
        if (message.subtype === 'task_started') {
          const task = message as unknown as {
            task_id?: string; description?: string; skip_transcript?: boolean
          }
          if (!task.task_id) return undefined
          if (task.skip_transcript) {
            ignoredClaudeTaskIds.add(task.task_id)
            return undefined
          }
          claudeTasks.set(task.task_id, {
            description: task.description?.trim() || `Task ${task.task_id}`,
            status: 'running',
          })
          emitClaudeTaskSnapshot(turnId)
          return undefined
        }
        if (message.subtype === 'task_updated') {
          const task = message as unknown as {
            task_id?: string
            patch?: { status?: ClaudeTaskStatus; description?: string }
          }
          if (!task.task_id || ignoredClaudeTaskIds.has(task.task_id)) return undefined
          const previous = claudeTasks.get(task.task_id)
          claudeTasks.set(task.task_id, {
            description: task.patch?.description?.trim() || previous?.description || `Task ${task.task_id}`,
            status: task.patch?.status ?? previous?.status ?? 'pending',
          })
          emitClaudeTaskSnapshot(turnId)
          return undefined
        }
        if (message.subtype === 'compact_boundary') {
          const metadata = (message as { compact_metadata?: Record<string, unknown> }).compact_metadata ?? {}
          const automatic = stringValue(metadata.trigger) === 'auto'
          emit({
            type: 'compaction_event',
            bridgeId: opts.bridgeId,
            turnId,
            status: 'completed',
            automatic,
            provider: 'claude',
            beforeTokens: numberValue(metadata.pre_tokens),
            afterTokens: numberValue(metadata.post_tokens),
            message: automatic
              ? 'Claude auto-compacted context. Continue the conversation normally.'
              : 'Claude compacted context. Continue the conversation normally.',
          })
        }
        return undefined
      case 'stream_event':
        handleStreamEvent(turnId, message.event as unknown as Record<string, unknown>, state)
        return undefined
      case 'assistant':
        handleAssistantMessage(turnId, message.message as unknown as Record<string, unknown>, state)
        return undefined
      case 'user':
        handleUserMessage(turnId, message.message as unknown as Record<string, unknown>)
        return undefined
      case 'result': {
        if (message.subtype === 'success' && !state.emittedAnyText && message.result) {
          emit({ type: 'text_delta', bridgeId: opts.bridgeId, turnId, delta: message.result })
        }
        if ('is_error' in message && message.is_error) {
          const text = 'result' in message && typeof message.result === 'string' ? message.result : `claude turn failed (${message.subtype})`
          emit({ type: 'error', bridgeId: opts.bridgeId, message: text })
        }
        return usageFromResult((message as { usage?: unknown }).usage, sessionModel)
      }
      default:
        return undefined
    }
  }

  function drainFollowUps(): void {
    if (running || followUpQueue.length === 0) return
    const next = followUpQueue.shift()
    if (!next) return
    emit({ type: 'follow_up_removed', bridgeId: opts.bridgeId, followUpId: next.id, reason: 'sent' })
    void bridge.prompt(next.text, next.options)
  }

  const bridge: AgentBridge = {
    bridgeId: opts.bridgeId,
    // The SDK owns the child process and doesn't surface its pid, so the system
    // monitor can't sample claude's per-process CPU/memory here.
    get pid() { return null },
    async prompt(text: string, options?: PromptOptions) {
      if (running) {
        if (options?.streamingBehavior === 'followUp') {
          followUpSeq += 1
          const id = `${opts.bridgeId}-fu-${followUpSeq}`
          followUpQueue.push({ id, text, options })
          // Truncated for display only; the queued entry keeps the full text.
          emit({ type: 'follow_up_queued', bridgeId: opts.bridgeId, followUpId: id, text: text.length > 300 ? `${text.slice(0, 300)}…` : text })
          return { ok: true }
        }
        return { ok: false, error: 'claude turn already running' }
      }
      aborted = false
      running = true
      const turnId = startTurn()
      const state: TurnState = { sawStreamEvent: false, emittedAnyText: false, streamBlockTypeByIndex: {}, textByBlock: {}, thinkingByBlock: {}, streamedText: '', streamedThinking: '', thinkingTokens: 0, thinkingStatusActive: false }
      let lastUsage: TurnUsage | undefined
      let turnSucceeded = false

      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
      Object.assign(env, opts.env ?? {})
      if (opts.apiKey) env.ANTHROPIC_API_KEY = opts.apiKey

      try {
        abortController = new AbortController()
        const mode = getClaudeModeOptions(opts.mode, opts.toolPolicy)
        const q = query({
          prompt: text,
          options: {
            cwd:        opts.cwd,
            additionalDirectories: opts.externalDirectories,
            model:      opts.model,
            resume:     sessionId ?? undefined,
            pathToClaudeCodeExecutable: claudePath,
            includePartialMessages: true,
            canUseTool,
            abortController,
            env,
            // Load only the repo's own settings/CLAUDE.md (`'project'`), never the
            // user's global ~/.claude. Without this the SDK pulls every discovered
            // global skill's name+description into the system prompt — tens of
            // thousands of tokens before the first message. `skills: []` enables
            // zero skills, so even project-level skills inject nothing; CrewCode
            // applies its own .crewcode skill bodies on demand instead.
            settingSources: ['project'],
            skills: [],
            // Preserve the user's Claude CLI auto-compaction preference without
            // loading global skills/plugins into this SDK query.
            ...(compactionSettings ? { settings: compactionSettings } : {}),
            // Claude defaults to adaptive thinking, so "off" must disable it
            // explicitly; named levels map directly to the SDK effort contract.
            ...(claudeThinking === 'off'
              ? { thinking: { type: 'disabled' as const } }
              : claudeThinking
                ? { effort: claudeThinking }
                : {}),
            permissionMode: mode.permissionMode,
            ...(mode.disallowedTools ? { disallowedTools: mode.disallowedTools } : {}),
            ...(mode.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
          },
        })
        currentQuery = q

        for await (const message of q) {
          const usage = handleMessage(message, turnId, state)
          if (message.type === 'result' && message.subtype === 'success' && !message.is_error) turnSucceeded = true
          if (usage) lastUsage = await applyStableContextUsage(usage, q)
        }

        if (!lastUsage?.contextTokens) lastUsage = await applyStableContextUsage(lastUsage, q)

        if (aborted) { endTurn('aborted', lastUsage); return { ok: false, error: 'aborted' } }
        endTurn(turnSucceeded ? 'success' : 'error', lastUsage)
        return { ok: true }
      } catch (err) {
        const message = (err as Error).message || String(err)
        if (aborted) { endTurn('aborted', lastUsage); return { ok: false, error: 'aborted' } }
        emit({ type: 'error', bridgeId: opts.bridgeId, message: `claude: ${message}` })
        endTurn('error', lastUsage)
        return { ok: false, error: message }
      } finally {
        currentQuery = null
        abortController = null
        running = false
        drainFollowUps()
      }
    },
    // Claude Code exposes no SDK control method for compaction; the `/compact`
    // slash command is the supported path and emits the compact_boundary event
    // handleMessage already listens for.
    async compact() {
      return bridge.prompt('/compact')
    },
    async removeFollowUp(followUpId: string) {
      const index = followUpQueue.findIndex(item => item.id === followUpId)
      if (index === -1) return { ok: false, error: 'follow-up not found (already sent or removed)' }
      followUpQueue.splice(index, 1)
      emit({ type: 'follow_up_removed', bridgeId: opts.bridgeId, followUpId, reason: 'removed' })
      return { ok: true }
    },
    async abort() {
      aborted = true
      clearFollowUps('cleared')
      abortController?.abort()
    },
    async stop() {
      aborted = true
      clearFollowUps('cleared')
      abortController?.abort()
      try { currentQuery?.close() } catch { /* already torn down */ }
      emit({ type: 'closed', bridgeId: opts.bridgeId, code: 0 })
    },
  }
  return bridge
}

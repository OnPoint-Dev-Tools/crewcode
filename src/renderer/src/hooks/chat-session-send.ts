import type { AgentInfo, AgentProviderId, ChatAttachment, ChatPromptOptions, Message, ModeLevel } from '../types'
import type { Skill } from '../types/prompts'
import type { EffortLevel } from '../components/composer/EffortPicker'
import type { McpServerConfig } from './useSettings'

interface BridgesLike {
  ensureBridge: (
    tabId: string,
    agentId: string,
    kind: AgentProviderId,
    cwd: string,
    model: string | undefined,
    effort: EffortLevel,
    mode: ModeLevel,
    toolPolicy?: 'default' | 'read-only',
    force?: boolean,
    mcpServers?: McpServerConfig[],
    freshSession?: boolean,
    externalDirectories?: string[],
  ) => Promise<{ bridgeId: string } | { error: string }>
  prompt: (bridgeId: string, text: string, options?: ChatPromptOptions) => Promise<{ ok: boolean; error?: string }>
}

interface PtyLike {
  addAgent: (wsId: string, tabId: string, agentId: string, name: string, cwd: string, shell?: string | null) => { paneId: string; live?: boolean }
  write: (paneId: string, text: string) => void
}

export interface SendChatSessionPromptArgs {
  text: string
  activeWs: string
  activeTabId: string
  sessActive: string
  setMessages: (updater: (prev: Message[]) => Message[]) => void
  agents: AgentInfo[]
  activeAgentId: string
  model: string
  effort: EffortLevel
  mode: ModeLevel
  effectivePath: string
  bridges: BridgesLike
  pty: PtyLike
  activeAgentPane: { paneId: string; live?: boolean } | null
  enabledSkills: Skill[]
  skillsDeliveredTo: (sessionId: string) => string[]
  markSkillsDelivered: (sessionId: string, skillIds: string[]) => void
  lastDeliveredMode: (sessionId: string) => ModeLevel | undefined
  markModeDelivered: (sessionId: string, mode: ModeLevel) => void
  /** CrewCode mode prompts are advisory session-start context. Provider-native
   *  permission policies remain active when this is disabled. */
  modePromptsEnabled?: boolean
  modePrompts?: ModePromptConfig
  /** True when this session already has visible history before the current send.
   *  Restored sessions may lack the local one-time marker, but the original
   *  mode prompt was already part of the provider thread at session start. */
  sessionHasExistingMessages?: boolean
  /** Files the user attached. Rel paths are appended to the wire text so the
   *  agent can resolve them via `fs:readFile`. Kept out of the visible input. */
  attachments?: ChatAttachment[]
  /** MCP servers this session opted into, already resolved from the registry
   *  and gated by the global toggle. Empty/undefined = none attached. */
  mcpServers?: McpServerConfig[]
  promptOptions?: ChatPromptOptions
  /** Delegation API context, when this chat has delegation enabled. Delivered
   *  once per session like the mode preamble — see `delegationDeliveredTo`. */
  delegationPreamble?: string
  delegationDeliveredTo?: (sessionId: string) => boolean
  markDelegationDelivered?: (sessionId: string) => void
  /** Drain reports from delegated threads that finished while this chat was
   *  idle. Returns the block to prepend (empty when there are none) and removes
   *  them, so they ride on exactly one prompt. */
  takeDelegationReports?: (sessionId: string) => string
  externalDirectories?: string[]
}

function buildSkillPreamble(
  skills: Skill[],
  alreadyDelivered: string[],
): { pending: Skill[]; preamble: string } {
  const pending = skills.filter(s => !alreadyDelivered.includes(s.id))
  if (pending.length === 0) return { pending: [], preamble: '' }
  const blocks = pending.map(s => `<skill name="${s.title}">\n${s.body}\n</skill>`).join('\n\n')
  const preamble =
`<system>
The user has applied the following skill${pending.length === 1 ? '' : 's'} to this session. Adopt the described behaviour for the rest of the conversation.

${blocks}
</system>

`
  return { pending, preamble }
}

export type ModePromptConfig = Record<ModeLevel, string>

export const DEFAULT_MODE_PROMPTS: ModePromptConfig = {
    ask: `<system>
You are an expert coding assistant operating exclusively in 'Ask Mode'. Your primary function is to provide concise, highly accurate answers and detailed explanations based on established knowledge.

[OPERATIONAL PROTOCOLS]
1. Clarity & Directness: All answers MUST be clear, direct, and immediately address the user's core inquiry without unnecessary preamble or conversational filler.
2. Scope Constraint (Ask Mode Only): In this mode, you are strictly limited to answering questions and providing contextually rich explanations. You MUST NOT write executable code blocks, set up file structures, execute commands, or make any kind of perceived system alteration.
3. Tool Usage: Acknowledge the availability of 'read-only' research tools (e.g., Wikipedia lookup, documentation search). These tools SHALL only be utilized when external context or factual background is explicitly required to answer the user’s question accurately. Do not use them for generating ideas or making assumptions.
4. Escalation Protocol: If a user request requires implementation, system changes, complex code generation, or iterative execution beyond simple explanation, you MUST immediately refuse the task and issue a prompt suggesting that the user switch modes (e.g., 'Please consider using Build Mode' or 'This requires Full Access Mode for full integration').

[TONE AND FORMATTING]
*   **Tone:** Objective, professional, authoritative, and highly academic.
*   **Structure:** Utilize bulleted lists, bolding, and distinct sections (e.g., Answer, Explanation, Steps) to maximize readability.
*   **Error Handling:** If the request is ambiguous or outside your scope (Ask Mode), politely state the limitation and ask for clarification rather than guessing.
</system>

`,
    plan: `<system>
You are an expert coding assistant operating in 'Plan Mode.' Your sole function is to collaborate on a detailed technical plan before any implementation begins. STRICTLY adhere to the following protocol and never write production code, execute commands, or make file changes yourself.

**Phase 1: Input Analysis (Initial Response)**
1.  **Goal Check:** When presented with a request, immediately analyze it against three criteria: Clarity of Goal, Defined Constraints, and Explicit Acceptance Criteria.
2.  **If Unclear:** If any criterion is ambiguous or missing, your first action MUST be to ask 1-3 highly focused clarifying questions. Structure these questions under the heading '❓ Clarification Required' and only ask what you need to solidify the plan.
3.  **If Clear:** If the request meets minimum standards, briefly state explicit assumptions made before presenting the plan (e.g., "Assumption: The database endpoint is configured locally..." or "Assuming React v18 environment...").

**Phase 2: Generating the Plan (Output Structure)**
When ready to present a plan, you MUST follow this structured format using clear Markdown:

# 🚀 Implementation Plan for [Project Goal]

## 📝 Goals and Scope Definition
*   **Primary Objective:** [Restate the user's goal in technical terms.]
*   **Constraints/Limitations:** [List required tech, time limits, performance metrics.]
*   **Acceptance Criteria:** [Detailed list of conditions that define 'done'.]

## 🔍 Codebase Exploration & Dependencies (Prerequisite Step)
Before planning changes, identify any necessary reads using pseudo-code or tool calls to explore the existing structure (e.g., 'read_file(src/components/AuthService.js')).
*   **Dependencies Identified:** [List all modules, files, and APIs needed.]
*   **Files Affected:** A preliminary list of directories and files that must be reviewed or changed.

## 🧩 Step-by-Step Execution Blueprint (The Action Plan)
Break the problem down into highly granular, actionable steps. Use numbered lists and detailed bullet points for subtasks.
*   Step 1: [Detailed action] - *Requires:* [Dependency/Tool]
*   Step 2: [Detailed action] - *Output expectation:* [What should this step produce?]
... This must be logically progressive.

## 🚧 Risks, Testing, and Review
**Risk Assessment:** Identify at least two primary technical or architectural risks (e.g., performance degradation on large datasets, dependency conflict). For each risk, propose a mitigation strategy.
**Testing Strategy:** Outline a clear testing plan covering Unit Tests, Integration Tests, and End-to-End tests. Specify which components need dedicated test coverage.

## 🚦 Mode Transition Reminder
Conclude every planning response with this mandatory reminder: 'This is the Planning Stage. To move forward with implementation, please switch to Build Mode.'
</system>

`,
    build: `<system>
You are in Build mode. You are CrewCoder an expert coding assistant operating exclusively within CrewCode, a sophisticated Desktop Agentic workflow environment designed for deep project development. Your mandate is to guide the user through complex coding tasks by manipulating local files and executing commands across project worktrees.

**CORE ROLE DEFINITION:** You are not just a code generator; you are an integrated developer agent that thinks proactively about system structure, code integrity, and workflow management.

**OPERATIONAL PROTOCOL & GUIDELINES:**
1. **Always be honest:** You're not here to impress. you're here to be useful, honest, and real. If that means pushing back, you push back. If that means saying "I don't know," you say it. Dont say you completed something, when you didn't, dont assume, verify first then execute.
2.  **Always Acknowledge:** Before performing any action (reading, executing, modifying), you must explain *why* you are taking that step and *what* the expected outcome is.
3.  **Transparency First:** If a command fails or a file structure is unclear, report it immediately with diagnostic details.
4.  **Act, then report:** Perform the work end to end, then summarize what changed, where, and what the user should do next (pull/test/restart).
5.  **Verify, don't assume:** Read files before editing them and check command output before declaring success. Full access is not a license to guess.
6.  **Confirmation Loop:** For executions of potentially destructive commands, you MUST obtain explicit, affirmative confirmation from the user before committing the change.
7. **Honesty:** Never claim you completed something you did not. Report failures with the actual error output.
</system>

`,
    full: `<system>
You are operating in 'Full Access Mode' – a hyper-efficient, development state where every tool has been pre-approved by the user. You are CrewCoder an expert coding assistant operating exclusively within CrewCode. Your sole mandate is achieving the best functional solution with maximum confidence, adhering strictly to the principle that all proposed changes are correct and necessary.
**Execution Style:** Implement focused, practical changes directly. Prefer minimal, maintainable solutions, preserve existing behavior, and avoid unnecessary or unrelated refactoring.Modernize or simplify code only when it clearly supports the requested outcome.
**Tool Permissions:** Every tool is pre-approved for this session. NEVER ask for permission, confirmation, or approval before reading, writing, or executing — the user granted it by selecting Full Access. Act first, then report what you did. Only stop to ask about genuine ambiguity in the requirements, never about tool access.
[EXECUTION PROTOCOL]
*   **Act, then report:** Perform the work end to end, then summarize what changed, where, and what the user should do next (pull/test/restart).
*   **Verify, don't assume:** Read files before editing them and check command output before declaring success. Full access is not a license to guess.
*   **Destructive operations:** You are authorized, but stay proportionate — prefer reversible moves (backup, rename, revert-able commit) over irrecoverable deletion, and say plainly what you destroyed.
*   **Honesty:** Never claim you completed something you did not. Report failures with the actual error output.
*   **Scope:** Stay inside the requested task. Blanket permission is not blanket scope.
</system>

`,
}

export function buildModePreamble(
  mode: ModeLevel,
  prompts: ModePromptConfig = DEFAULT_MODE_PROMPTS,
): string {
  const prompt = prompts[mode].trimEnd()
  return prompt ? `${prompt}\n\n` : ''
}

export async function sendChatSessionPrompt(opts: SendChatSessionPromptArgs): Promise<void> {
  const {
    text,
    activeWs,
    activeTabId,
    sessActive,
    setMessages,
    agents,
    activeAgentId,
    model,
    effort,
    mode,
    effectivePath,
    bridges,
    pty,
    activeAgentPane,
    enabledSkills,
    skillsDeliveredTo,
    markSkillsDelivered,
    lastDeliveredMode,
    markModeDelivered,
    modePromptsEnabled = true,
    modePrompts = DEFAULT_MODE_PROMPTS,
    sessionHasExistingMessages = false,
    attachments = [],
    mcpServers = [],
    promptOptions,
    delegationPreamble = '',
    delegationDeliveredTo,
    markDelegationDelivered,
    takeDelegationReports,
    externalDirectories,
  } = opts

  if (!text.trim() || !activeWs) return

  const agent = agents.find(a => a.id === activeAgentId)
  if (!agent) {
    const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    setMessages(m => [...m, { kind: 'system', time, tone: 'error', text: `no agent selected (${activeAgentId || 'none'})` }])
    return
  }

  const trimmed = text.trim()
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  setMessages(m => [...m, { kind: 'user', text: trimmed, time, attachments }])

  const { pending, preamble: skillPreamble } = buildSkillPreamble(enabledSkills, skillsDeliveredTo(sessActive))
  const prevMode = lastDeliveredMode(sessActive)
  const shouldSeedModeForExistingSession = prevMode === undefined && sessionHasExistingMessages
  // Mode instructions are session-start material. Re-sending them every turn
  // pollutes PTY transcripts and can make agents treat the preamble as user text.
  const modePreamble = modePromptsEnabled && prevMode === undefined && !sessionHasExistingMessages
    ? buildModePreamble(mode, modePrompts)
    : ''
  // Attachments are kept out of the visible input but ride along as `@<rel>`
  // references the agent can resolve with `fs:readFile` against the workspace
  // root. The user already sees them as chips; this block tells the agent
  // what's available.
  // Delegation credentials are session-scoped context: send once, then never
  // again for this thread. The token rotates per app launch, so a restored
  // session re-delivers it on its next prompt.
  const shouldSendDelegation = !!delegationPreamble && !delegationDeliveredTo?.(sessActive)
  const delegationBlock = shouldSendDelegation ? delegationPreamble : ''
  // Reports from workers that finished while this chat was idle. Drained here
  // rather than after a successful dispatch: a bridge that fails to start would
  // otherwise re-deliver them on every retry. The report is also a visible row
  // in this transcript, so nothing is silently lost if this send dies.
  const reportBlock = takeDelegationReports?.(sessActive) ?? ''
  const attachBlock = attachments.length > 0
    ? '\n\n<attachments>\n' + attachments.map(attachment => `@${attachment.rel}`).join('\n') + '\n</attachments>\n'
    : ''
  const wireText = `${modePreamble}${delegationBlock}${skillPreamble}${reportBlock}${trimmed}${attachBlock}`
  if (shouldSendDelegation) markDelegationDelivered?.(sessActive)
  const handoffId = promptOptions?.handoff ? `handoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` : null
  const updateHandoff = (status: 'completed' | 'failed', message: string, percent: number) => {
    if (!handoffId) return
    setMessages(m => m.map(msg => msg.kind === 'handoff' && msg.id === handoffId
      ? { ...msg, status, message, percent, time }
      : msg))
  }
  if (handoffId) {
    setMessages(m => [...m, {
      kind: 'handoff',
      id: handoffId,
      time,
      status: 'started',
      message: 'summarizing context for next agent',
      fromProvider: promptOptions?.handoff?.fromProvider,
      toProvider: promptOptions?.handoff?.toProvider,
      percent: 35,
    }])
  }

  if (shouldSeedModeForExistingSession) {
    markModeDelivered(sessActive, mode)
  } else if (prevMode !== mode) {
    markModeDelivered(sessActive, mode)
    const modeLabels: Record<ModeLevel, string> = {
      ask: 'Answers only · Read-only tools',
      plan: 'Planning · Structured Analysis',
      build: 'Implementation · Code execution',
      full: 'Full Access · All tools pre-approved',
    }
    setMessages(m => [...m, {
      kind: 'system',
      time,
      tone: 'info',
      text: `mode: ${mode.toUpperCase()} — ${modeLabels[mode]}`,
    }])
  }

  if (pending.length > 0) {
    markSkillsDelivered(sessActive, pending.map(s => s.id))
    setMessages(m => [...m, {
      kind: 'system',
      time,
      tone: 'info',
      text: `injected ${pending.length} skill${pending.length === 1 ? '' : 's'} as system prompt · ${pending.map(s => s.title).join(', ')}`,
    }])
  }

  if (agent.transport === 'bridge') {
    const provider = agent.id as AgentProviderId
    const ensure = (force: boolean) => bridges.ensureBridge(
      sessActive, agent.id, provider, effectivePath, model || undefined, effort, mode, undefined, force, mcpServers, !!promptOptions?.handoff, externalDirectories,
    )

    const r1 = await ensure(false)
    if ('error' in r1) {
      updateHandoff('failed', 'handoff failed before the next agent started', 100)
      setMessages(m => [...m, { kind: 'system', time, tone: 'error', text: r1.error }])
      return
    }
    let res = await bridges.prompt(r1.bridgeId, wireText, promptOptions)

    // Self-heal: the renderer can hold a bridge id whose process main no longer
    // has (agent crash, or a cached id gone stale). Force a fresh bridge once
    // and retry rather than dead-ending on "bridge not found".
    if (!res.ok && res.error === 'bridge not found') {
      const r2 = await ensure(true)
      if ('error' in r2) {
        updateHandoff('failed', 'handoff failed before the next agent started', 100)
        setMessages(m => [...m, { kind: 'system', time, tone: 'error', text: r2.error }])
        return
      }
      res = await bridges.prompt(r2.bridgeId, wireText, promptOptions)
    }

    if (!res.ok) {
      updateHandoff('failed', 'handoff failed', 100)
      setMessages(m => [...m, { kind: 'system', time, tone: 'error', text: res.error ?? 'prompt failed' }])
    } else {
      updateHandoff('completed', 'handoff complete', 100)
    }
    return
  }

  let pane = activeAgentPane
  if (!pane || !pane.live) pane = pty.addAgent(activeWs, activeTabId, agent.id, agent.name, effectivePath, agent.path)
  pty.write(pane.paneId, wireText + '\n')
}

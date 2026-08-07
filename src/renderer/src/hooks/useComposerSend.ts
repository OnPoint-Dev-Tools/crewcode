import { useCallback, useEffect, useRef } from 'react'

import type { AgentInfo, AgentProviderId, ChatAttachment, ChatPromptOptions, Message, ModeLevel } from '../types'
import type { Skill } from '../types/prompts'
import type { EffortLevel } from '../components/composer/EffortPicker'
import type { McpServerConfig } from './useSettings'
import { DEFAULT_MODE_PROMPTS, sendChatSessionPrompt, type ModePromptConfig } from './chat-session-send'
import { buildReportsBlock } from './delegation-report'
import { delegationInbox } from '../stores/delegation-inbox-store'

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
  compact?: (bridgeId: string) => Promise<{ ok: boolean; error?: string; unsupported?: boolean }>
  dropBridge: (tabId: string, agentId: string) => void
}

interface PtyLike {
  addAgent: (wsId: string, tabId: string, agentId: string, name: string, cwd: string, shell?: string | null) => { paneId: string; live?: boolean }
  write: (paneId: string, text: string) => void
}

export interface UseComposerSendOpts {
  activeWs: string
  activeTabId: string
  sessActive: string
  composer: string
  setComposer: (v: string) => void
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

  /** Skills currently enabled in the library (any kind, all agents). */
  enabledSkills: Skill[]
  /** Returns the skill IDs already delivered to this session. */
  skillsDeliveredTo: (sessionId: string) => string[]
  /** Mark these skill IDs as delivered to this session. */
  markSkillsDelivered: (sessionId: string, skillIds: string[]) => void
  /** Returns the last mode recorded for this session's one-time prompt/notice gates. */
  lastDeliveredMode: (sessionId: string) => ModeLevel | undefined
  /** Mark the mode as recorded to this session (for change notifications). */
  markModeDelivered: (sessionId: string, mode: ModeLevel) => void
  modePromptsEnabled?: boolean
  modePrompts?: ModePromptConfig
  /** True when the active session had messages before this send. */
  sessionHasExistingMessages?: boolean

  /** Delegation API context for this chat, empty when delegation is off. Sent once
   *  per session, like the mode preamble. */
  delegationPreamble?: string
  delegationDeliveredTo?: (sessionId: string) => boolean
  markDelegationDelivered?: (sessionId: string) => void

  /** Reads the latest composer attachments at send time. */
  getAttachments: () => ChatAttachment[]
  /** Reads the MCP servers this session opted into at send time, already
   *  resolved from the registry and gated by the global enable toggle. */
  getMcpServers?: () => McpServerConfig[]
  workspaceName?: string
  workspaceBranch?: string
  externalDirectories?: string[]
}

export function useComposerSend(opts: UseComposerSendOpts) {
  const {
    activeWs, activeTabId, sessActive, composer, setComposer, setMessages,
    agents, activeAgentId, model, effort, mode, effectivePath, bridges, pty, activeAgentPane,
    enabledSkills, skillsDeliveredTo, markSkillsDelivered, lastDeliveredMode, markModeDelivered,
    modePromptsEnabled = true, modePrompts = DEFAULT_MODE_PROMPTS,
    sessionHasExistingMessages = false,
    delegationPreamble = '',
    delegationDeliveredTo,
    markDelegationDelivered,
    getAttachments, getMcpServers,
    workspaceName, workspaceBranch, externalDirectories,
  } = opts

  const pendingHandoffRef = useRef<Record<string, { fromProvider: string; toProvider: string }>>({})

  // Delegated-worker reports are held in a module store, not per-pane state, so
  // this reads it directly instead of drilling another prop through ChatPane. A
  // chat with no pending reports drains nothing.
  // This runs only for a message the USER typed, which is exactly the event that
  // opens a new cohort and refills the autonomous budget — an auto-wake goes
  // straight to the bridge and never reaches this path, so it cannot refill its
  // own budget or fold its spawns into the previous request's group.
  const takeDelegationReports = useCallback((sessionId: string) => {
    delegationInbox.startUserGeneration(sessionId)
    return buildReportsBlock(delegationInbox.take(sessionId))
  }, [])

  // Picker changes are launch flags, not "new chat" actions. Drop only the
  // live process so the next prompt resumes the existing thread history.
  const prevModelRef = useRef({ sessActive, activeAgentId, model })
  useEffect(() => {
    const prev = prevModelRef.current
    const sameRuntime = prev.sessActive === sessActive && prev.activeAgentId === activeAgentId
    prevModelRef.current = { sessActive, activeAgentId, model }
    if (sessActive && sameRuntime && prev.model !== model) bridges.dropBridge(sessActive, activeAgentId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, sessActive, activeAgentId])

  const prevAgentRef = useRef({ sessActive, activeAgentId })
  useEffect(() => {
    const prev = prevAgentRef.current
    const sameSession = prev.sessActive === sessActive
    prevAgentRef.current = { sessActive, activeAgentId }
    if (!sessActive || !sameSession || prev.activeAgentId === activeAgentId || !sessionHasExistingMessages) return
    pendingHandoffRef.current[sessActive] = { fromProvider: prev.activeAgentId, toProvider: activeAgentId }
  }, [sessActive, activeAgentId, sessionHasExistingMessages])

  // Mode is per-turn behavior. Do not respawn the bridge here: the next send
  // updates the live bridge's mode and injects a mode-change instruction.

  // Effort is just a launch flag; respawn the bridge but keep provider context.
  const prevEffortRef = useRef({ sessActive, activeAgentId, effort })
  useEffect(() => {
    const prev = prevEffortRef.current
    const sameRuntime = prev.sessActive === sessActive && prev.activeAgentId === activeAgentId
    prevEffortRef.current = { sessActive, activeAgentId, effort }
    if (sessActive && sameRuntime && prev.effort !== effort) bridges.dropBridge(sessActive, activeAgentId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effort, sessActive, activeAgentId])

  const sendText = useCallback(async (
    text: string,
    attachments: ChatAttachment[],
    promptOptions?: ChatPromptOptions,
  ) => {
    const mcpServers = getMcpServers?.() ?? []
    const pendingHandoff = pendingHandoffRef.current[sessActive]
    const handoff = pendingHandoff && pendingHandoff.toProvider === activeAgentId
      ? {
          fromProvider: pendingHandoff.fromProvider,
          toProvider: activeAgentId,
          model: model || undefined,
          mode,
          workspace: { name: workspaceName, path: effectivePath, branch: workspaceBranch },
        }
      : undefined
    await sendChatSessionPrompt({
      text,
      attachments,
      mcpServers,
      promptOptions: handoff ? { ...promptOptions, handoff } : promptOptions,
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
      modePromptsEnabled,
      modePrompts,
      sessionHasExistingMessages,
      delegationPreamble,
      delegationDeliveredTo,
      markDelegationDelivered,
      takeDelegationReports,
      externalDirectories,
    })
    if (handoff) delete pendingHandoffRef.current[sessActive]
  }, [
    activeWs, activeTabId, sessActive, setMessages, agents, activeAgentId,
    model, effort, mode, effectivePath, bridges, pty, activeAgentPane,
    enabledSkills, skillsDeliveredTo, markSkillsDelivered, lastDeliveredMode, markModeDelivered,
    modePromptsEnabled, modePrompts, sessionHasExistingMessages,
    delegationPreamble, delegationDeliveredTo, markDelegationDelivered,
    getMcpServers,
    workspaceName, workspaceBranch,
  ])

  const send = useCallback(async () => {
    if (!composer.trim() || !activeWs) return
    const text = composer.trim()
    const attachments = getAttachments()
    const mcpServers = getMcpServers?.() ?? []
    setComposer('')

    if (text === '/compact') {
      const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      const agent = agents.find(a => a.id === activeAgentId)
      if (!agent) {
        setMessages(m => [...m, { kind: 'system', time, tone: 'error', text: `no agent selected (${activeAgentId || 'none'})` }])
        return
      }
      if (agent.transport === 'bridge') {
        const ensure = (force: boolean) => bridges.ensureBridge(
          sessActive, agent.id, agent.id as AgentProviderId, effectivePath, model || undefined, effort, mode, undefined, force, mcpServers,
        )
        const r1 = await ensure(false)
        if ('error' in r1) {
          setMessages(m => [...m, { kind: 'system', time, tone: 'error', text: r1.error }])
          return
        }
        let res = await (bridges.compact?.(r1.bridgeId) ?? { ok: false, error: 'compact unavailable' })
        if (!res.ok && res.error === 'bridge not found') {
          const r2 = await ensure(true)
          if ('error' in r2) {
            setMessages(m => [...m, { kind: 'system', time, tone: 'error', text: r2.error }])
            return
          }
          res = await (bridges.compact?.(r2.bridgeId) ?? { ok: false, error: 'compact unavailable' })
        }
        if (!res.ok) {
          const unsupported = 'unsupported' in res && res.unsupported
          setMessages(m => [...m, {
            kind: 'system',
            time,
            tone: unsupported ? 'info' : 'error',
            text: unsupported ? `${agent.name} doesn't support /compact yet.` : (res.error ?? 'compaction failed'),
          }])
        }
        return
      }
      let pane = activeAgentPane
      if (!pane || !pane.live) pane = pty.addAgent(activeWs, activeTabId, agent.id, agent.name, effectivePath, agent.path)
      setMessages(m => [...m, { kind: 'system', time, tone: 'info', text: `${agent.name} compaction requested. Continue after the provider reports completion.` }])
      pty.write(pane.paneId, '/compact\n')
      return
    }

    await sendText(text, attachments)
  }, [
    composer, activeWs, activeTabId, sessActive, agents, activeAgentId,
    model, effort, mode, effectivePath, bridges, pty, activeAgentPane,
    setComposer, setMessages, sendText,
    getAttachments, getMcpServers,
  ])

  return { send, sendText }
}

import type { AgentMessage, ChatPromptOptions, Message } from '../types'
import { useMessagesStore } from '../stores/chat-messages-store'
import { useVoiceSessionStore, voiceSession } from '../stores/voice-session-store'
import { spokenAgentMessage } from './spoken-agent-reply'
import type { VoiceTransport, VoiceTransportEvent } from './voice-agent-contract'
import { voiceAgentActivityPresentation } from './voice-agent-activity'

interface VoiceRuntimeTarget {
  scopeId: string
  agentLabel: string
  agentRunning: boolean
  sendText: (text: string, attachments: [], options?: ChatPromptOptions) => Promise<void>
}

interface PendingVoiceTask {
  callId: string
  baseline: number
}

interface PendingVoiceConfirmation {
  callId: string
  text: string
}

interface ActiveVoiceRuntime extends VoiceRuntimeTarget {
  transport: VoiceTransport
  pending: PendingVoiceTask | null
  confirmation: PendingVoiceConfirmation | null
  unsubscribeTransport: () => void
  unsubscribeMessages: () => void
}

let runtime: ActiveVoiceRuntime | null = null

function messagesFor(scopeId: string): Message[] {
  return useMessagesStore.getState().messagesByTab[scopeId] ?? []
}

function disposeRuntime(stopTransport: boolean): ActiveVoiceRuntime | null {
  const current = runtime
  runtime = null
  if (!current) return null
  current.unsubscribeTransport()
  current.unsubscribeMessages()
  if (stopTransport) void current.transport.stop()
  return current
}

function handleMessages(): void {
  const current = runtime
  if (!current?.pending) return
  const { baseline } = current.pending
  const messages = messagesFor(current.scopeId)
  const turnMessages = messages.slice(baseline)
  const live = turnMessages.some(message =>
    (message.kind === 'agent' && message.streaming)
    || (message.kind === 'thinking' && message.streaming)
    || (message.kind === 'toolcall' && (message.status === 'pending' || message.status === 'running')))
  current.agentRunning = live

  const activity = voiceAgentActivityPresentation(messages, baseline, live, current.agentLabel)
  if (activity) voiceSession.setPhase(current.scopeId, activity.phase, activity.status)
  if (live) return

  const completed = turnMessages
    .filter((message): message is AgentMessage => message.kind === 'agent' && !message.streaming)
    .at(-1)
  if (!completed) return
  current.pending = null
  current.transport.sendAgentResult(spokenAgentMessage(completed))
}

function dispatchConfirmedPrompt(current: ActiveVoiceRuntime, callId: string, text: string): void {
  current.confirmation = null
  current.pending = { callId, baseline: messagesFor(current.scopeId).length }
  voiceSession.setPhase(current.scopeId, 'waiting', `${current.agentLabel} is working`)
  current.transport.sendToolResult(callId, { status: 'started', agent: current.agentLabel })
  const options = current.agentRunning ? { streamingBehavior: 'followUp' as const } : undefined
  void current.sendText(text, [], options).catch(error => {
    if (runtime !== current) return
    current.pending = null
    current.transport.sendAgentResult(
      `The request could not be sent. ${error instanceof Error ? error.message : String(error)}`,
    )
  })
}

function handleEvent(event: VoiceTransportEvent): void {
  const current = runtime
  if (!current) return
  if (event.type === 'phase') {
    // Provider phase noise must not replace review or live coding activity.
    if ((current.confirmation || current.pending) && event.phase !== 'error') return
    voiceSession.setPhase(current.scopeId, event.phase, event.status ?? event.phase)
    return
  }
  if (event.type === 'transcript') {
    if (!current.confirmation) voiceSession.setTranscript(current.scopeId, event.text)
    return
  }
  if (event.type === 'error') {
    voiceSession.fail(current.scopeId, event.message)
    return
  }
  if (event.type === 'result_complete') {
    voiceRuntime.stop()
    return
  }

  const { call } = event
  if (call.name === 'get_agent_status') {
    current.transport.sendToolResult(call.callId, {
      status: current.agentRunning || current.pending ? 'working' : 'idle',
      agent: current.agentLabel,
    })
    return
  }
  const text = typeof call.arguments.text === 'string' ? call.arguments.text.trim() : ''
  if (!text) {
    current.transport.sendToolResult(call.callId, {
      status: 'rejected',
      error: 'A non-empty text request is required.',
    })
    return
  }
  if (current.confirmation || current.pending) {
    current.transport.sendToolResult(call.callId, {
      status: 'rejected',
      error: 'A voice-started coding task is already active.',
    })
    return
  }

  current.transport.setInputEnabled(false)
  current.confirmation = { callId: call.callId, text }
  voiceSession.requestConfirmation(current.scopeId, text)
}

export const voiceRuntime = {
  begin(target: VoiceRuntimeTarget, transport: VoiceTransport): void {
    this.stop()
    voiceSession.claim(target.scopeId)
    const next = {
      ...target,
      transport,
      pending: null,
      confirmation: null,
      unsubscribeTransport: () => {},
      unsubscribeMessages: () => {},
    } satisfies ActiveVoiceRuntime
    runtime = next
    next.unsubscribeTransport = transport.subscribe(handleEvent)
    next.unsubscribeMessages = useMessagesStore.subscribe(handleMessages)
  },

  updateTarget(target: VoiceRuntimeTarget): void {
    if (!runtime || runtime.scopeId !== target.scopeId) return
    runtime.agentLabel = target.agentLabel
    runtime.agentRunning = target.agentRunning
    runtime.sendText = target.sendText
  },

  failStart(transport: VoiceTransport, message: string): void {
    if (runtime?.transport !== transport) {
      void transport.stop()
      return
    }
    const current = disposeRuntime(true)
    if (current) voiceSession.fail(current.scopeId, message)
  },

  stop(): void {
    disposeRuntime(true)
    const state = useVoiceSessionStore.getState()
    if (state.activeScopeId && state.ownerKind === 'voice') voiceSession.release(state.activeScopeId)
  },

  setConfirmationText(text: string): void {
    if (!runtime?.confirmation) return
    runtime.confirmation = { ...runtime.confirmation, text }
    voiceSession.setTranscript(runtime.scopeId, text)
  },

  confirmPrompt(): void {
    const current = runtime
    if (!current?.confirmation) return
    const text = current.confirmation.text.trim()
    if (!text) {
      voiceSession.setPhase(current.scopeId, 'confirming', 'Enter a request before sending')
      return
    }
    dispatchConfirmedPrompt(current, current.confirmation.callId, text)
  },

  cancelPrompt(): void {
    if (runtime?.confirmation) this.stop()
  },

  /** Test-only visibility into whether navigation preserved the runtime. */
  activeScopeId(): string | null {
    return runtime?.scopeId ?? null
  },
}

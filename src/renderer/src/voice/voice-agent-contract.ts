import type { LocalVoiceDevice, VoiceSessionPhase, VoiceToolCall } from '../../../shared/voice-types'

export interface VoiceTransportContext {
  agentLabel: string
  model: string
  voice: string
  pythonPath?: string
  localDevice?: LocalVoiceDevice
  localSpeechSpeed?: number
}

export type VoiceTransportEvent =
  | { type: 'phase'; phase: VoiceSessionPhase; status?: string }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'tool_call'; call: VoiceToolCall }
  | { type: 'result_complete' }
  | { type: 'error'; message: string }

export type VoiceTransportListener = (event: VoiceTransportEvent) => void

export interface VoiceTransport {
  readonly id: string
  start(context: VoiceTransportContext): Promise<void>
  stop(): Promise<void>
  setInputEnabled(enabled: boolean): void
  interrupt(): void
  sendToolResult(callId: string, result: Record<string, unknown>): void
  sendAgentResult(spokenText: string): void
  subscribe(listener: VoiceTransportListener): () => void
}

export const VOICE_TOOLS = [
  {
    type: 'function',
    name: 'send_prompt_to_agent',
    description: 'Send a development request to the active CrewCode coding agent.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The complete request for the coding agent.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_agent_status',
    description: 'Check whether the active CrewCode coding agent is currently working.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
] as const

export function voiceSessionInstructions(agentLabel: string): string {
  return [
    'You are CrewCode Voice, a concise spoken controller for a coding environment.',
    `The active coding agent is ${agentLabel}.`,
    'For any request that asks for coding work, investigation, repository changes, tests, or agent follow-up, call send_prompt_to_agent.',
    'Never claim that work completed until CrewCode returns the coding agent result.',
    'You do not have filesystem, shell, Git, or permission authority.',
    'When a task starts, acknowledge it in one short sentence and remain available for conversation.',
    'When CrewCode supplies an agent result, read all supplied prose naturally and in order without summarizing or omitting sentences.',
    'Never read code blocks, diffs, tables, logs, Markdown syntax, URLs, hashes, or long file paths aloud.',
    'Mention filenames only when they are necessary to understand the outcome.',
  ].join(' ')
}

export abstract class BaseVoiceTransport implements VoiceTransport {
  abstract readonly id: string
  private readonly listeners = new Set<VoiceTransportListener>()

  abstract start(context: VoiceTransportContext): Promise<void>
  abstract stop(): Promise<void>
  abstract setInputEnabled(enabled: boolean): void
  abstract interrupt(): void
  abstract sendToolResult(callId: string, result: Record<string, unknown>): void
  abstract sendAgentResult(spokenText: string): void

  subscribe(listener: VoiceTransportListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected emit(event: VoiceTransportEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

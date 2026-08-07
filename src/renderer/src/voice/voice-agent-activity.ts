import type { Message } from '../types'
import type { VoiceSessionPhase } from '../../../shared/voice-types'

export interface VoiceAgentActivityPresentation {
  phase: VoiceSessionPhase
  status: string
}

export function voiceAgentActivityPresentation(
  messages: Message[],
  baseline: number | null,
  agentRunning: boolean,
  agentLabel: string,
): VoiceAgentActivityPresentation | null {
  if (baseline === null || !agentRunning) return null
  const runningTools = messages
    .slice(baseline)
    .some(message =>
      message.kind === 'toolcall' &&
      (message.status === 'pending' || message.status === 'running'))

  return {
    phase: 'waiting',
    status: runningTools ? 'Running tools' : `${agentLabel} is working`,
  }
}

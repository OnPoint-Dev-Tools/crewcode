import type { VoiceToolCall } from '../../../shared/voice-types'
import {
  BaseVoiceTransport,
  type VoiceTransportContext,
} from './voice-agent-contract'

export class FakeVoiceTransport extends BaseVoiceTransport {
  readonly id = 'fake'
  context: VoiceTransportContext | null = null
  toolResults: Array<{ callId: string; result: Record<string, unknown> }> = []
  agentResults: string[] = []
  inputEnabled = true

  async start(context: VoiceTransportContext): Promise<void> {
    this.context = context
    this.inputEnabled = true
    this.emit({ type: 'phase', phase: 'connecting', status: 'connecting test voice' })
    await Promise.resolve()
    this.emit({ type: 'phase', phase: 'listening', status: 'test voice ready' })
  }

  async stop(): Promise<void> {
    this.context = null
    this.inputEnabled = false
    this.emit({ type: 'phase', phase: 'idle', status: 'voice off' })
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled
  }

  interrupt(): void {
    this.emit({ type: 'phase', phase: 'listening', status: 'test voice ready' })
  }

  sendToolResult(callId: string, result: Record<string, unknown>): void {
    this.toolResults.push({ callId, result })
  }

  sendAgentResult(spokenText: string): void {
    this.agentResults.push(spokenText)
    this.emit({ type: 'phase', phase: 'speaking', status: 'speaking result' })
    queueMicrotask(() => this.emit({ type: 'result_complete' }))
  }

  injectToolCall(call: VoiceToolCall): void {
    this.emit({ type: 'tool_call', call })
  }
}

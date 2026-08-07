import { describe, expect, it, vi } from 'vitest'

import { FakeVoiceTransport } from './fake-voice-transport'
import type { VoiceTransportEvent } from './voice-agent-contract'

describe('FakeVoiceTransport', () => {
  it('runs the complete local lifecycle without media or network access', async () => {
    const transport = new FakeVoiceTransport()
    const events: VoiceTransportEvent[] = []
    transport.subscribe(event => events.push(event))

    await transport.start({ agentLabel: 'Codex', model: 'fake-model', voice: 'fake-voice' })
    transport.injectToolCall({
      callId: 'call-1',
      name: 'send_prompt_to_agent',
      arguments: { text: 'Run the tests' },
    })
    transport.setInputEnabled(false)
    transport.sendToolResult('call-1', { accepted: true })
    transport.sendAgentResult('The tests pass.')
    await new Promise<void>(resolve => queueMicrotask(() => resolve()))

    expect(transport.context?.agentLabel).toBe('Codex')
    expect(transport.inputEnabled).toBe(false)
    expect(transport.toolResults).toEqual([{ callId: 'call-1', result: { accepted: true } }])
    expect(transport.agentResults).toEqual(['The tests pass.'])
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_call' }))
    expect(events.at(-1)).toEqual({ type: 'result_complete' })

    await transport.stop()
    expect(transport.context).toBeNull()
    expect(transport.inputEnabled).toBe(false)
    expect(events.at(-1)).toEqual({ type: 'phase', phase: 'idle', status: 'voice off' })
  })

  it('allows listeners to unsubscribe', async () => {
    const transport = new FakeVoiceTransport()
    const listener = vi.fn()
    const unsubscribe = transport.subscribe(listener)
    unsubscribe()

    await transport.start({ agentLabel: 'Claude', model: 'fake-model', voice: 'fake-voice' })
    expect(listener).not.toHaveBeenCalled()
  })
})

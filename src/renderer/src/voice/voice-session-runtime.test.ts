import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useMessagesStore } from '../stores/chat-messages-store'
import { useVoiceSessionStore, voiceSession } from '../stores/voice-session-store'
import { FakeVoiceTransport } from './fake-voice-transport'
import { voiceRuntime } from './voice-session-runtime'

describe('voice session runtime', () => {
  beforeEach(() => {
    voiceRuntime.stop()
    voiceSession.reset()
    useMessagesStore.setState({ messagesByTab: {} })
  })

  afterEach(() => voiceRuntime.stop())

  it('survives presenter navigation and speaks the original session result', async () => {
    const transport = new FakeVoiceTransport()
    const sendText = vi.fn().mockResolvedValue(undefined)
    voiceRuntime.begin({
      scopeId: 'origin-session',
      agentLabel: 'Codex',
      agentRunning: false,
      sendText,
    }, transport)
    await transport.start({ agentLabel: 'Codex', model: 'fake', voice: 'fake' })

    voiceSession.detachPresenter('origin-session')
    voiceSession.attachPresenter('visible-session')

    expect(voiceRuntime.activeScopeId()).toBe('origin-session')
    expect(transport.context).not.toBeNull()
    expect(useVoiceSessionStore.getState().presenterScopeId).toBe('visible-session')

    transport.injectToolCall({
      callId: 'voice-call',
      name: 'send_prompt_to_agent',
      arguments: { text: 'Run the voice tests' },
    })
    voiceRuntime.confirmPrompt()
    expect(sendText).toHaveBeenCalledWith('Run the voice tests', [], undefined)

    useMessagesStore.getState().setMessagesForTab('origin-session', () => [{
      kind: 'agent',
      time: 'now',
      blocks: [['t', 'The voice tests pass.']],
      streaming: false,
    }])

    expect(transport.agentResults).toEqual(['The voice tests pass.'])
    await new Promise<void>(resolve => queueMicrotask(resolve))
    expect(voiceRuntime.activeScopeId()).toBeNull()
  })
})

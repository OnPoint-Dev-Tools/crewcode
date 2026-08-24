import { beforeEach, describe, expect, it } from 'vitest'
import type { Message } from '../types'
import { useMessagesStore } from '../stores/chat-messages-store'
import { restoreRecoveredAssistant } from './recovered-agent-history'

const scope = 'workspace-chat-session'
const prompt: Message = { kind: 'user', text: 'create the folder', time: '8:45 PM' }

beforeEach(() => {
  useMessagesStore.setState({ messagesByTab: { [scope]: [prompt] } })
})

describe('detached agent history recovery', () => {
  it('adds the Brain reply missing after the matching persisted browser prompt', () => {
    restoreRecoveredAssistant(scope, 'bridge', { index: 3, userText: 'create the folder', text: 'Created the requested folder.' })

    expect(useMessagesStore.getState().messagesByTab[scope]).toEqual([
      prompt,
      expect.objectContaining({ kind: 'agent', text: 'Created the requested folder.', streaming: false }),
    ])
  })

  it('does not duplicate a reply already restored by hydration or relay replay', () => {
    const recovered = { index: 3, userText: 'create the folder', text: 'Created the requested folder.' }
    restoreRecoveredAssistant(scope, 'bridge', recovered)
    restoreRecoveredAssistant(scope, 'bridge', recovered)

    expect(useMessagesStore.getState().messagesByTab[scope].filter(message => message.kind === 'agent')).toHaveLength(1)
  })
})

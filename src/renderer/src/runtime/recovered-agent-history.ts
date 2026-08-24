import { useMessagesStore } from '../stores/chat-messages-store'

export interface RecoveredAssistant {
  index: number
  text: string
  userText?: string
}

/** Merge a Brain-local completed reply after the browser transcript has hydrated. */
export function restoreRecoveredAssistant(scopeId: string, bridgeId: string, recovered: RecoveredAssistant | null): void {
  if (!recovered?.text.trim()) return
  useMessagesStore.getState().setMessagesForTab(scopeId, messages => {
    let userIndex = -1
    if (recovered.userText !== undefined) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!
        if (message.kind === 'user' && message.text === recovered.userText) { userIndex = index; break }
      }
    }
    // A hydrated or previously recovered copy after the matching prompt wins.
    // Do not duplicate it when replayHistory and recoverHistory both report the
    // same Brain-local conversation.
    const alreadyPresent = messages.some((message, index) => index > userIndex
      && message.kind === 'agent' && message.text === recovered.text)
    if (alreadyPresent) return messages
    return [...messages, {
      kind: 'agent',
      time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      blocks: [],
      text: recovered.text,
      chunks: [recovered.text],
      turnId: `recovered-${bridgeId}-${recovered.index}`,
      processId: `recovered-${bridgeId}-${recovered.index}-agent-history`,
      streaming: false,
    }]
  })
}

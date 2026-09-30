import { useMessagesStore } from '../stores/chat-messages-store'
import type { Message } from '../types'

export interface RecoveredAssistant {
  index: number
  text: string
  userText?: string
}

// Brain relay recovery (`bridge.replayHistory` / `bridge.recoverHistory`) labels
// its synthetic turns with this prefix; they never match a live turn id.
const RECOVERED_TURN_PREFIX = 'recovered-'

export function isRecoveredTurnId(turnId: string): boolean {
  return turnId.startsWith(RECOVERED_TURN_PREFIX)
}

function normalizedReplyText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * True when the recovered Brain reply is already rendered after its prompt,
 * either as one bubble or split across the live turn's text segments. Without
 * `userText`, the latest user message anchors the search.
 */
export function hasObservedAssistantReply(messages: Message[], text: string, userText?: string): boolean {
  const target = normalizedReplyText(text)
  if (!target) return true
  let userIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.kind === 'user' && (userText === undefined || message.text === userText)) { userIndex = index; break }
  }
  const replies = messages.slice(userIndex + 1)
    .filter((message): message is Extract<Message, { kind: 'agent' }> => message.kind === 'agent')
    .map(message => normalizedReplyText(message.text ?? ''))
  return replies.includes(target) || normalizedReplyText(replies.join(' ')) === target
}

/** Merge a Brain-local completed reply after the browser transcript has hydrated. */
export function restoreRecoveredAssistant(scopeId: string, bridgeId: string, recovered: RecoveredAssistant | null): void {
  if (!recovered?.text.trim()) return
  useMessagesStore.getState().setMessagesForTab(scopeId, messages => {
    // A hydrated or previously recovered copy after the matching prompt wins.
    // Do not duplicate it when replayHistory and recoverHistory both report the
    // same Brain-local conversation.
    if (hasObservedAssistantReply(messages, recovered.text, recovered.userText)) return messages
    return [...messages, {
      kind: 'agent',
      time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      blocks: [],
      text: recovered.text,
      chunks: [recovered.text],
      turnId: `${RECOVERED_TURN_PREFIX}${bridgeId}-${recovered.index}`,
      processId: `${RECOVERED_TURN_PREFIX}${bridgeId}-${recovered.index}-agent-history`,
      streaming: false,
    }]
  })
}

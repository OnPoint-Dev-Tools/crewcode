import { describe, it, expect } from 'vitest'
import {
  childrenOf,
  detailThread,
  summarizeThread,
  DETAIL_MESSAGE_LIMIT,
  SUMMARY_REPLY_CHARS,
} from './delegated-thread-projection'
import type { Message, Session } from '../types'

const session = (over: Partial<Session> & { id: string }): Session => ({
  tabId: 'ws1-chat',
  label: over.id,
  agentId: 'claude',
  model: 'sonnet',
  mode: 'plan',
  effort: 'medium',
  mcpServerIds: [],
  enabledSkillIds: [],
  ...over,
})

const agent = (text: string): Message => ({ kind: 'agent', time: '3:42 PM', blocks: [['t', text]] })
const user = (text: string): Message => ({ kind: 'user', time: '3:41 PM', text })

describe('childrenOf', () => {
  it('returns only delegated threads belonging to the caller', () => {
    const all = [
      session({ id: 'parent' }),
      session({ id: 'mine', origin: 'delegated', delegatedBy: 'parent' }),
      session({ id: 'someone-elses', origin: 'delegated', delegatedBy: 'other-parent' }),
      // A normal session that happens to carry a stale delegatedBy must not leak.
      session({ id: 'not-delegated', delegatedBy: 'parent' }),
    ]
    expect(childrenOf('parent', all).map(s => s.id)).toEqual(['mine'])
  })
})

describe('summarizeThread', () => {
  it('carries the last agent reply, not the last message', () => {
    const result = summarizeThread(
      session({ id: 'c1', origin: 'delegated' }),
      [agent('suite passed, 0 failures'), user('thanks')],
      false,
    )
    expect(result.lastReply).toBe('suite passed, 0 failures')
  })

  it('truncates a long reply so polling stays cheap', () => {
    const result = summarizeThread(session({ id: 'c1' }), [agent('x'.repeat(5_000))], false)
    expect(result.lastReply!.length).toBeLessThan(SUMMARY_REPLY_CHARS + 20)
    expect(result.lastReply).toContain('[truncated]')
  })

  // Chat messages carry a display string ("3:42 PM"), never a parseable
  // timestamp — the real clock comes from the completed-turn store.
  it('reports completedAt only when the caller supplies one', () => {
    expect(summarizeThread(session({ id: 'c1' }), [agent('done')], false).completedAt).toBeUndefined()
    expect(summarizeThread(session({ id: 'c1' }), [agent('done')], false, 1234).completedAt).toBe(1234)
  })

  it('derives isolation from the presence of a worktree', () => {
    expect(summarizeThread(session({ id: 'c1' }), [], false).isolation).toBe('shared')
    expect(summarizeThread(session({ id: 'c2', delegatedWorktreePath: '/wt' }), [], false))
      .toMatchObject({ isolation: 'worktree', worktreePath: '/wt' })
  })

  it('reports archived threads as closed', () => {
    expect(summarizeThread(session({ id: 'c1', archived: true }), [], false).closed).toBe(true)
  })

  // `closed` is what frees a concurrency slot, so an agent that marked its work
  // done must see it as closed even though the chat is still open in the UI.
  it('reports agent-closed threads as closed without them being archived', () => {
    const done = session({ id: 'c1', delegationClosedAt: 1_700_000_000_000 })
    expect(summarizeThread(done, [], false).closed).toBe(true)
    expect(done.archived).toBeUndefined()
  })

  it('reports a live thread as open', () => {
    expect(summarizeThread(session({ id: 'c1' }), [], false).closed).toBe(false)
  })

  it('omits lastReply entirely when the thread has not answered yet', () => {
    expect(summarizeThread(session({ id: 'c1' }), [user('go')], true).lastReply).toBeUndefined()
  })
})

describe('detailThread', () => {
  // A delegating agent needs the conversation, not the other agent's telemetry.
  it('drops thinking, tool calls, and work logs', () => {
    const messages: Message[] = [
      user('run the suite'),
      { kind: 'thinking', time: '1', turnId: 't', text: 'hmm', streaming: false },
      { kind: 'toolcall', time: '1', turnId: 't', toolCallId: 'x', toolName: 'Bash', args: {}, status: 'completed' },
      { kind: 'worklog', time: '1', count: 3, command: 'npm test' },
      agent('all green'),
    ]
    expect(detailThread(session({ id: 'c1' }), messages, false).messages)
      .toEqual([{ role: 'user', text: 'run the suite' }, { role: 'agent', text: 'all green' }])
  })

  it('returns the most recent window, oldest first', () => {
    const messages = Array.from({ length: DETAIL_MESSAGE_LIMIT + 10 }, (_, i) => agent(`m${i}`))
    const result = detailThread(session({ id: 'c1' }), messages, false).messages
    expect(result).toHaveLength(DETAIL_MESSAGE_LIMIT)
    expect(result[result.length - 1].text).toBe(`m${messages.length - 1}`)
    expect(result[0].text).toBe(`m${messages.length - DETAIL_MESSAGE_LIMIT}`)
  })

  it('skips empty messages rather than emitting blank rows', () => {
    expect(detailThread(session({ id: 'c1' }), [agent('   '), agent('real')], false).messages)
      .toEqual([{ role: 'agent', text: 'real' }])
  })

  it('falls back to the streaming buffer when blocks are absent', () => {
    const streaming: Message = { kind: 'agent', time: '1', blocks: [], text: 'partial output' }
    expect(detailThread(session({ id: 'c1' }), [streaming], true).messages)
      .toEqual([{ role: 'agent', text: 'partial output' }])
  })
})

import { describe, expect, it } from 'vitest'
import {
  buildDelegationReport,
  buildReportsBlock,
  finalReplyOf,
  reportNoticeText,
  REPORT_REPLY_CHARS,
  type DelegationReport,
} from './delegation-report'
import type { Message } from '../types'

const agent = (text: string): Message =>
  ({ kind: 'agent', text, time: '3:42 PM' } as Message)
const blocks = (parts: string[]): Message =>
  ({ kind: 'agent', text: '', blocks: parts.map(p => ['t', p]), time: '3:42 PM' } as unknown as Message)
const user = (text: string): Message => ({ kind: 'user', text, time: '3:42 PM' } as Message)
const errorRow = (text: string): Message =>
  ({ kind: 'system', tone: 'error', text, time: '3:42 PM' } as Message)
const thinking = (text: string): Message =>
  ({ kind: 'thinking', text, time: '3:42 PM' } as unknown as Message)

const source = (messages: Message[]) => ({
  threadId: 'ws-chat::s2',
  parentSessionId: 'ws-chat',
  title: 'regression sweep',
  messages,
  at: 1_700_000_000_000,
})

describe('finalReplyOf', () => {
  it('takes the last agent reply', () => {
    const result = finalReplyOf([agent('first'), user('more'), agent('second')])
    expect(result).toEqual({ reply: 'second', failed: false })
  })

  it('prefers assembled blocks over the raw streaming buffer', () => {
    expect(finalReplyOf([blocks(['all ', 'green'])]).reply).toBe('all green')
  })

  // A thread that dies at bridge start has no agent message at all. Reporting
  // nothing would leave the parent believing the work is still in flight.
  it('falls back to the last error row when no agent replied', () => {
    const result = finalReplyOf([user('go'), errorRow('agent exited (1)')])
    expect(result).toEqual({ reply: 'agent exited (1)', failed: true })
  })

  it('prefers a real reply over an earlier error', () => {
    const result = finalReplyOf([errorRow('transient'), agent('recovered, done')])
    expect(result).toEqual({ reply: 'recovered, done', failed: false })
  })

  it('ignores thinking and user rows', () => {
    expect(finalReplyOf([agent('done'), thinking('hmm'), user('?')]).reply).toBe('done')
  })

  it('returns nothing for an empty or silent thread', () => {
    expect(finalReplyOf([]).reply).toBe('')
    expect(finalReplyOf([user('go')]).reply).toBe('')
  })
})

describe('buildDelegationReport', () => {
  it('carries the thread identity, branch, and outcome', () => {
    const report = buildDelegationReport({ ...source([agent('7 failures')]), branch: 'crew/sweep-1' })
    expect(report).toMatchObject({
      threadId: 'ws-chat::s2',
      parentSessionId: 'ws-chat',
      title: 'regression sweep',
      branch: 'crew/sweep-1',
      reply: '7 failures',
      failed: false,
    })
  })

  it('omits branch for shared-worktree threads', () => {
    expect(buildDelegationReport(source([agent('ok')]))).not.toHaveProperty('branch')
  })

  it('is null when the thread said nothing — no empty report reaches the parent', () => {
    expect(buildDelegationReport(source([user('go')]))).toBeNull()
  })

  // The reply is injected into the parent's context, so its size is a token bill.
  it('clamps a huge reply', () => {
    const report = buildDelegationReport(source([agent('x'.repeat(50_000))]))
    expect(report!.reply.length).toBeLessThan(REPORT_REPLY_CHARS + 100)
    expect(report!.reply).toContain('[truncated')
  })

  it('marks an errored thread as failed', () => {
    expect(buildDelegationReport(source([errorRow('worktree add failed')]))!.failed).toBe(true)
  })
})

describe('buildReportsBlock', () => {
  const report = (over: Partial<DelegationReport> = {}): DelegationReport => ({
    threadId: 't1',
    parentSessionId: 'p',
    title: 'sweep',
    reply: 'all green',
    failed: false,
    at: 1,
    ...over,
  })

  it('is empty with no reports, so a normal send is byte-identical', () => {
    expect(buildReportsBlock([])).toBe('')
  })

  // Framed as <system>, not as user text: the agent must not answer the worker's
  // words as though the user had typed them.
  it('wraps reports in a system block', () => {
    const text = buildReportsBlock([report()])
    expect(text.startsWith('<system>')).toBe(true)
    expect(text).toContain('</system>')
    expect(text).toContain('all green')
    expect(text).toContain('thread="t1"')
    expect(text).toContain('outcome="finished"')
  })

  it('states that nothing was archived, so the agent does not report a cleanup', () => {
    expect(buildReportsBlock([report()])).toContain('nothing was archived')
  })

  it('marks a failed thread', () => {
    expect(buildReportsBlock([report({ failed: true })])).toContain('outcome="failed"')
  })

  it('carries the branch only when there is one', () => {
    expect(buildReportsBlock([report({ branch: 'crew/x' })])).toContain('branch="crew/x"')
    expect(buildReportsBlock([report()])).not.toContain('branch=')
  })

  // A title is agent-supplied, so it must not be able to break out of the attribute.
  it('neutralizes quotes in a title', () => {
    expect(buildReportsBlock([report({ title: 'say "hi"' })])).toContain(`title="say 'hi'"`)
  })

  // A mid-turn agent told it "was idle" narrates a gap that never happened.
  it('does not claim the chat was idle when delivering into a running turn', () => {
    expect(buildReportsBlock([report()], 'live')).toContain('just finished')
    expect(buildReportsBlock([report()], 'live')).not.toContain('while this chat was idle')
    expect(buildReportsBlock([report()], 'buffered')).toContain('while this chat was idle')
    expect(buildReportsBlock([report()])).toContain('while this chat was idle')
  })

  it('pluralizes and includes every report', () => {
    const text = buildReportsBlock([report({ threadId: 'a' }), report({ threadId: 'b' })])
    expect(text).toContain('2 delegated threads')
    expect(text).toContain('thread="a"')
    expect(text).toContain('thread="b"')
    expect(buildReportsBlock([report()])).toContain('1 delegated thread ')
  })
})

describe('reportNoticeText', () => {
  const report: DelegationReport = {
    threadId: 't1', parentSessionId: 'p', title: 'sweep', reply: 'done', failed: false, at: 1,
  }

  it('distinguishes live delivery from a held report', () => {
    expect(reportNoticeText([report], 'live')).toContain('delivered into the running turn')
    expect(reportNoticeText([report], 'buffered')).toContain('held for your next message')
  })

  it('names the thread and its outcome', () => {
    expect(reportNoticeText([{ ...report, failed: true }], 'buffered')).toContain('"sweep" failed')
  })

  // A coalesced fan-out is one event and must read as one row, not N.
  it('summarizes a batch instead of naming every thread', () => {
    const batch = [report, { ...report, threadId: 't2', title: 'other' }]
    expect(reportNoticeText(batch, 'woke')).toContain('2 delegated threads finished')
    expect(reportNoticeText(batch, 'woke')).toContain('woke this chat')
  })

  it('surfaces partial failure in a batch', () => {
    const batch = [report, { ...report, threadId: 't2', failed: true }]
    expect(reportNoticeText(batch, 'buffered')).toContain('(1 failed)')
    expect(reportNoticeText([{ ...report, failed: true }, { ...report, threadId: 't2', failed: true }], 'buffered'))
      .toContain('2 delegated threads failed')
  })
})

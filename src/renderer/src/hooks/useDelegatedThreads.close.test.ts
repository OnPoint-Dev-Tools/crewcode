// Close semantics: the delegating agent may mark its own work finished, but it
// must never be able to decide the USER is finished with a chat. Closing frees a
// concurrency slot; archiving stays a user action. This file pins that boundary
// because it is the one place an agent's routine housekeeping could hide work
// the user still wanted.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { flush, renderHook } from './hook-test-host'
import { useDelegatedThreads, type DelegatedThreadsDeps } from './useDelegatedThreads'
import type { DelegationRendererRequest, DelegationResult } from '../../../shared/delegation-types'
import type { Session } from '../types'

const PARENT = 'ws-chat'
const CHILD = 'ws-chat::s2'

function session(over: Partial<Session> = {}): Session {
  return {
    id: PARENT,
    tabId: 'ws-chat',
    label: 'main',
    agentId: 'pi',
    model: 'm',
    mode: 'build',
    effort: 'medium',
    mcpServerIds: [],
    enabledSkillIds: [],
    ...over,
  }
}

function child(over: Partial<Session> = {}): Session {
  return session({
    id: CHILD,
    label: 'regression sweep',
    origin: 'delegated',
    delegatedBy: PARENT,
    delegatedAt: 1,
    ...over,
  })
}

interface Harness {
  deps: DelegatedThreadsDeps
  call: (request: DelegationRendererRequest) => Promise<DelegationResult<unknown>>
}

function mount(sessions: Session[], over: Partial<DelegatedThreadsDeps> = {}): Harness {
  let handler: ((request: DelegationRendererRequest & { id: string }) => void) | null = null
  const responses = new Map<string, (result: DelegationResult<unknown>) => void>()

  vi.stubGlobal('window', {
    electronAPI: {
      onDelegationRequest: (cb: (r: DelegationRendererRequest & { id: string }) => void) => {
        handler = cb
        return () => { handler = null }
      },
      delegationRespond: (id: string, result: DelegationResult<unknown>) => {
        responses.get(id)?.(result)
      },
    },
  })

  const deps: DelegatedThreadsDeps = {
    allSessions: () => sessions,
    tabIdForSession: () => 'ws-chat',
    messagesForSession: () => [],
    isRunning: () => false,
    completedAtForSession: () => undefined,
    addDelegated: vi.fn(),
    sendToSession: vi.fn(async () => {}),
    setThreadClosed: vi.fn(),
    providers: () => [],
    focusSession: vi.fn(),
    createWorktree: vi.fn(async () => ({ ok: false as const, error: 'no' })),
    repoPathForSession: () => '/repo',
    spawnCohort: () => ({ runId: 'run-1', duringWake: false }),
    ...over,
  }

  renderHook(() => useDelegatedThreads(deps), {})

  let seq = 0
  const call = (request: DelegationRendererRequest): Promise<DelegationResult<unknown>> => {
    const id = `req-${seq++}`
    return new Promise<DelegationResult<unknown>>(resolve => {
      responses.set(id, resolve)
      handler?.({ id, ...request } as DelegationRendererRequest & { id: string })
      void flush()
    })
  }

  return { deps, call }
}

beforeEach(() => { vi.unstubAllGlobals() })

describe('close', () => {
  it('marks the thread done instead of archiving it', async () => {
    const h = mount([session(), child()])
    const result = await h.call({ kind: 'close', sessionId: PARENT, threadId: CHILD })

    expect(result).toEqual({ ok: true, data: { closed: true } })
    expect(h.deps.setThreadClosed).toHaveBeenCalledWith('ws-chat', CHILD, true)
  })

  // The regression this whole change exists to prevent: `close` used to call
  // setArchived, which hides the chat from every live surface.
  it('never archives — no archive path is reachable from the API', () => {
    const h = mount([session(), child()])
    expect(h.deps).not.toHaveProperty('archiveSession')
  })

  it('is idempotent on an already-done thread', async () => {
    const h = mount([session(), child({ delegationClosedAt: 5 })])
    const result = await h.call({ kind: 'close', sessionId: PARENT, threadId: CHILD })

    expect(result).toEqual({ ok: true, data: { closed: true } })
    expect(h.deps.setThreadClosed).not.toHaveBeenCalled()
  })

  it('404s a thread that is not the caller\'s child', async () => {
    const h = mount([session(), child({ delegatedBy: 'someone-else' })])
    const result = await h.call({ kind: 'close', sessionId: PARENT, threadId: CHILD })
    expect(result).toMatchObject({ ok: false, status: 404 })
  })
})

describe('a thread the agent marked done', () => {
  it('reopens when given more work, so it counts against the cap again', async () => {
    const h = mount([session(), child({ delegationClosedAt: 5 })])
    const result = await h.call({ kind: 'message', sessionId: PARENT, threadId: CHILD, text: 'one more thing' })

    expect(result).toEqual({ ok: true, data: { delivered: true } })
    expect(h.deps.setThreadClosed).toHaveBeenCalledWith('ws-chat', CHILD, false)
    expect(h.deps.sendToSession).toHaveBeenCalled()
  })

  it('does not reopen a thread that was never closed', async () => {
    const h = mount([session(), child()])
    await h.call({ kind: 'message', sessionId: PARENT, threadId: CHILD, text: 'hi' })
    expect(h.deps.setThreadClosed).not.toHaveBeenCalled()
  })

  // Done is not gone: the chat is still on screen, so pointing the user at it
  // must still work.
  it('is still a valid focus target', async () => {
    const h = mount([session(), child({ delegationClosedAt: 5 })])
    const result = await h.call({ kind: 'focus', sessionId: PARENT, threadId: CHILD })

    expect(result).toEqual({ ok: true, data: { focused: CHILD } })
    expect(h.deps.focusSession).toHaveBeenCalled()
  })
})

// Depth-1 at the API layer: the promise the preamble makes to the agent must
// hold even if a token reaches a delegated thread by a route the UI and the
// credential-minting path did not anticipate.
describe('a delegated thread holding credentials', () => {
  const asChildCaller = () => mount([session(), child()], {
    // The caller IS the delegated thread.
    allSessions: () => [child({ id: PARENT, delegationEnabled: true })],
  })

  it('cannot create threads of its own', async () => {
    const h = asChildCaller()
    const result = await h.call({
      kind: 'create',
      sessionId: PARENT,
      request: { title: 't', prompt: 'p', mode: 'build', isolation: 'shared' },
    })

    expect(result).toMatchObject({ ok: false, status: 403 })
    expect((result as { error: string }).error).toContain('cannot delegate further')
    expect(h.deps.addDelegated).not.toHaveBeenCalled()
  })

  // Every route, not just create: a leaked token must not read siblings'
  // transcripts or merge their branches either.
  it('is refused on every route, not just create', async () => {
    const h = asChildCaller()
    for (const request of [
      { kind: 'list' as const, sessionId: PARENT },
      { kind: 'read' as const, sessionId: PARENT, threadId: CHILD },
      { kind: 'merge' as const, sessionId: PARENT, threadId: CHILD },
      { kind: 'focus' as const, sessionId: PARENT, threadId: CHILD },
    ]) {
      expect(await h.call(request)).toMatchObject({ ok: false, status: 403 })
    }
    expect(h.deps.focusSession).not.toHaveBeenCalled()
  })
})

describe('a thread the user archived', () => {
  it('refuses new work and names the user as the actor', async () => {
    const h = mount([session(), child({ archived: true })])
    const result = await h.call({ kind: 'message', sessionId: PARENT, threadId: CHILD, text: 'hi' })

    expect(result).toMatchObject({ ok: false, status: 409 })
    expect((result as { error: string }).error).toContain('archived by the user')
    expect(h.deps.sendToSession).not.toHaveBeenCalled()
  })

  it('cannot be focused', async () => {
    const h = mount([session(), child({ archived: true })])
    const result = await h.call({ kind: 'focus', sessionId: PARENT, threadId: CHILD })

    expect(result).toMatchObject({ ok: false, status: 409 })
    expect(h.deps.focusSession).not.toHaveBeenCalled()
  })
})

import { describe, it, expect } from 'vitest'
import {
  applyCreatePolicy,
  bearerToken,
  containsDelegationToken,
  hostAllowed,
  defaultIsolationForMode,
  isRouteError,
  matchRoute,
  normalizeCreate,
  normalizeFocus,
  normalizeMessage,
  parseBody,
  remoteAddressAllowed,
  applyRateLimit,
  newRateWindow,
  MAX_PROMPT_CHARS,
  MAX_TITLE_CHARS,
  RATE_LIMIT_CREATES_PER_WINDOW,
  RATE_LIMIT_REQUESTS_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
  type DelegationPolicy,
} from './delegation-routes'

const policy = (over: Partial<DelegationPolicy> = {}): DelegationPolicy => ({
  allowFullAccess: false,
  parentMode: 'build',
  maxConcurrent: 4,
  remote: false,
  ...over,
})

const create = (body: unknown, parentMode: DelegationPolicy['parentMode'] = 'build') =>
  normalizeCreate(body, parentMode)

describe('defaultIsolationForMode', () => {
  it('shares the parent worktree for read-only modes', () => {
    expect(defaultIsolationForMode('ask')).toBe('shared')
    expect(defaultIsolationForMode('plan')).toBe('shared')
  })

  // Concurrent writers to one worktree lose edits silently and share one git
  // index, so write-capable threads default to isolation.
  it('defaults write-capable modes to their own worktree', () => {
    expect(defaultIsolationForMode('build')).toBe('worktree')
    expect(defaultIsolationForMode('full')).toBe('worktree')
  })
})

describe('isolation is independent of mode', () => {
  // The whole reason this is decoupled: running a test suite needs shell access
  // (`build`), but a fresh worktree has no node_modules, so the tests can't run
  // there. Forcing isolation from the mode made that request impossible.
  it('allows a write-capable thread to share the parent worktree when asked', () => {
    const result = create({ prompt: 'npm test', mode: 'build', isolation: 'shared' })
    expect(isRouteError(result)).toBe(false)
    expect(result).toMatchObject({ mode: 'build', isolation: 'shared', isolationExplicit: true })
  })

  it('allows a read-only thread to take its own worktree when asked', () => {
    expect(create({ prompt: 'x', mode: 'plan', isolation: 'worktree' }))
      .toMatchObject({ mode: 'plan', isolation: 'worktree' })
  })

  it('falls back to the mode default when isolation is omitted', () => {
    expect(create({ prompt: 'x', mode: 'build' })).toMatchObject({ isolation: 'worktree', isolationExplicit: false })
    expect(create({ prompt: 'x', mode: 'plan' })).toMatchObject({ isolation: 'shared', isolationExplicit: false })
  })

  it('rejects an unknown isolation value', () => {
    expect(create({ prompt: 'x', mode: 'plan', isolation: 'sandbox' })).toMatchObject({ status: 400 })
  })

  // A clamp changes the permissions, not the caller's stated placement.
  it('keeps an explicit isolation when an inherited full mode is clamped', () => {
    const inherited = create({ prompt: 'x', isolation: 'shared' }, 'full') as never
    expect(applyCreatePolicy(inherited, policy(), 0)).toMatchObject({ mode: 'build', isolation: 'shared' })
  })

  it('recomputes isolation from the clamped mode when it was not explicit', () => {
    const inherited = create({ prompt: 'x' }, 'full') as never
    expect(applyCreatePolicy(inherited, policy(), 0)).toMatchObject({ mode: 'build', isolation: 'worktree' })
  })
})

describe('matchRoute', () => {
  it('routes the full surface', () => {
    expect(matchRoute('GET', '/v1/threads')).toEqual({ kind: 'list' })
    expect(matchRoute('POST', '/v1/threads')).toEqual({ kind: 'create' })
    expect(matchRoute('GET', '/v1/threads/ws1-chat')).toEqual({ kind: 'read', threadId: 'ws1-chat' })
    expect(matchRoute('POST', '/v1/threads/ws1-chat/messages')).toEqual({ kind: 'message', threadId: 'ws1-chat' })
    expect(matchRoute('POST', '/v1/threads/ws1-chat/close')).toEqual({ kind: 'close', threadId: 'ws1-chat' })
    expect(matchRoute('POST', '/v1/focus')).toEqual({ kind: 'focus' })
    expect(matchRoute('GET', '/v1/providers')).toEqual({ kind: 'providers' })
    expect(matchRoute('GET', '/v1/threads/ws1-chat/diff')).toEqual({ kind: 'diff', threadId: 'ws1-chat' })
    expect(matchRoute('POST', '/v1/threads/ws1-chat/merge')).toEqual({ kind: 'merge', threadId: 'ws1-chat' })
  })

  it('rejects the wrong verb on the merge and diff routes', () => {
    expect(matchRoute('POST', '/v1/threads/ws1-chat/diff')).toMatchObject({ status: 404 })
    expect(matchRoute('GET', '/v1/threads/ws1-chat/merge')).toMatchObject({ status: 404 })
    expect(matchRoute('POST', '/v1/providers')).toMatchObject({ status: 405 })
  })

  // Real session ids are `<wsId>-chat` and `<tabId>::s2`; an id validator that
  // rejects `-` or `:` refuses every legitimate thread.
  it('accepts real session id shapes', () => {
    expect(matchRoute('GET', '/v1/threads/ws1-chat::s2')).toEqual({ kind: 'read', threadId: 'ws1-chat::s2' })
  })

  it('tolerates trailing slashes and is case-insensitive on the verb', () => {
    expect(matchRoute('get', '/v1/threads/')).toEqual({ kind: 'list' })
  })

  it('rejects unknown routes and wrong methods', () => {
    expect(matchRoute('GET', '/v1/nope')).toMatchObject({ status: 404 })
    expect(matchRoute('GET', '/threads')).toMatchObject({ status: 404 })
    expect(matchRoute('DELETE', '/v1/threads')).toMatchObject({ status: 405 })
    expect(matchRoute('GET', '/v1/focus')).toMatchObject({ status: 405 })
  })

  it('rejects thread ids carrying path separators, even percent-encoded', () => {
    expect(matchRoute('GET', '/v1/threads/%2e%2e%2fetc%2fpasswd')).toMatchObject({ status: 400 })
    expect(matchRoute('GET', '/v1/threads/a%20b')).toMatchObject({ status: 400 })
    expect(matchRoute('GET', `/v1/threads/${'x'.repeat(201)}`)).toMatchObject({ status: 400 })
  })
})

describe('bearerToken', () => {
  it('extracts a well-formed token', () => {
    expect(bearerToken({ authorization: 'Bearer abc123' })).toBe('abc123')
    expect(bearerToken({ Authorization: '  Bearer abc123  ' })).toBe('abc123')
  })

  it('returns null for missing or malformed headers', () => {
    expect(bearerToken({})).toBeNull()
    expect(bearerToken({ authorization: 'abc123' })).toBeNull()
    expect(bearerToken({ authorization: 'Basic abc123' })).toBeNull()
    expect(bearerToken({ authorization: 'Bearer' })).toBeNull()
  })
})

describe('host and peer checks', () => {
  // DNS rebinding: a page on an attacker domain resolving to 127.0.0.1 would
  // otherwise reach this API using the victim's own network stack.
  it('accepts only loopback Host headers naming the bound port', () => {
    expect(hostAllowed('127.0.0.1:41234', 41234)).toBe(true)
    expect(hostAllowed('localhost:41234', 41234)).toBe(true)
    expect(hostAllowed('evil.example.com:41234', 41234)).toBe(false)
    expect(hostAllowed('127.0.0.1:9999', 41234)).toBe(false)
    expect(hostAllowed(undefined, 41234)).toBe(false)
  })

  it('accepts only loopback peer addresses', () => {
    expect(remoteAddressAllowed('127.0.0.1')).toBe(true)
    expect(remoteAddressAllowed('::1')).toBe(true)
    expect(remoteAddressAllowed('::ffff:127.0.0.1')).toBe(true)
    expect(remoteAddressAllowed('192.168.1.20')).toBe(false)
    expect(remoteAddressAllowed(undefined)).toBe(false)
  })
})

describe('normalizeCreate', () => {
  it('maps a read-only request onto the shared worktree', () => {
    const result = create({ prompt: 'run the regression suite', mode: 'plan' })
    expect(isRouteError(result)).toBe(false)
    expect(result).toMatchObject({ mode: 'plan', isolation: 'shared', modeExplicit: true })
  })

  it('maps a write-capable request to its own worktree', () => {
    expect(create({ prompt: 'fix it', mode: 'build' })).toMatchObject({ isolation: 'worktree' })
  })

  // The parent's mode is real signal, not a guess: work delegated from a Build
  // thread is build work.
  it('inherits the parent mode when the spawn omits one', () => {
    expect(create({ prompt: 'go' }, 'build')).toMatchObject({ mode: 'build', isolation: 'worktree', modeExplicit: false })
    expect(create({ prompt: 'go' }, 'plan')).toMatchObject({ mode: 'plan', isolation: 'shared', modeExplicit: false })
    expect(create({ prompt: 'go' }, 'ask')).toMatchObject({ mode: 'ask', isolation: 'shared' })
  })

  it('lets an explicit mode override inheritance in both directions', () => {
    expect(create({ prompt: 'go', mode: 'plan' }, 'build')).toMatchObject({ mode: 'plan', isolation: 'shared' })
    expect(create({ prompt: 'go', mode: 'build' }, 'plan')).toMatchObject({ mode: 'build', isolation: 'worktree' })
  })

  it('derives a title from the prompt when none is given', () => {
    const result = create({ prompt: 'check the bridge layer\nsecond line', mode: 'plan' })
    expect(result).toMatchObject({ title: 'check the bridge layer' })
  })

  it('caps title length', () => {
    const result = create({ prompt: 'x', mode: 'plan', title: 'y'.repeat(500) })
    expect((result as { title: string }).title).toHaveLength(MAX_TITLE_CHARS)
  })

  it('rejects a missing prompt, bad mode, and oversized prompt', () => {
    expect(create({})).toMatchObject({ status: 400 })
    expect(create({ prompt: '   ', mode: 'plan' })).toMatchObject({ status: 400 })
    expect(create({ prompt: 'x', mode: 'yolo' })).toMatchObject({ status: 400 })
    expect(create({ prompt: 'x'.repeat(MAX_PROMPT_CHARS + 1), mode: 'plan' })).toMatchObject({ status: 413 })
    expect(create('nope')).toMatchObject({ status: 400 })
    expect(create([])).toMatchObject({ status: 400 })
  })
})

describe('applyCreatePolicy', () => {
  const request = create({ prompt: 'go', mode: 'plan' }) as never

  it('passes a valid request through, dropping the internal explicit-mode flag', () => {
    const result = applyCreatePolicy(request, policy(), 0)
    expect(isRouteError(result)).toBe(false)
    expect(result).toMatchObject({ mode: 'plan', isolation: 'shared' })
    expect(result).not.toHaveProperty('modeExplicit')
  })

  // The agent's 127.0.0.1 is the remote host, not this machine.
  it('denies delegation in remote workspaces', () => {
    expect(applyCreatePolicy(request, policy({ remote: true }), 0)).toMatchObject({ status: 409 })
  })

  it('refuses an explicit Full Access request unless enabled', () => {
    const full = create({ prompt: 'go', mode: 'full' }) as never
    expect(applyCreatePolicy(full, policy(), 0)).toMatchObject({ status: 403 })
    expect(applyCreatePolicy(full, policy({ allowFullAccess: true }), 0)).toMatchObject({ mode: 'full' })
  })

  // Inherited Full Access is clamped, not refused: the agent never asked for it,
  // and 403-ing every spawn would make delegation unusable from a Full Access
  // thread. An explicit request still fails loudly.
  it('clamps inherited Full Access to build instead of refusing', () => {
    const inherited = create({ prompt: 'go' }, 'full') as never
    expect(applyCreatePolicy(inherited, policy(), 0)).toMatchObject({ mode: 'build', isolation: 'worktree' })
  })

  it('still allows build when Full Access is disabled', () => {
    const build = create({ prompt: 'go', mode: 'build' }) as never
    expect(isRouteError(applyCreatePolicy(build, policy(), 0))).toBe(false)
  })

  // An agent in a retry loop can otherwise create hundreds of threads.
  it('enforces the concurrency cap', () => {
    expect(applyCreatePolicy(request, policy({ maxConcurrent: 2 }), 2)).toMatchObject({ status: 429 })
    expect(isRouteError(applyCreatePolicy(request, policy({ maxConcurrent: 2 }), 1))).toBe(false)
  })

  it('falls back to the default cap when configured with a nonsense value', () => {
    expect(applyCreatePolicy(request, policy({ maxConcurrent: 0 }), 4)).toMatchObject({ status: 429 })
  })
})

describe('normalizeMessage and normalizeFocus', () => {
  it('accepts valid bodies', () => {
    expect(normalizeMessage({ text: ' hi ' })).toEqual({ text: 'hi' })
    expect(normalizeFocus({ threadId: 'ws1-chat::s2' })).toEqual({ threadId: 'ws1-chat::s2' })
  })

  it('rejects invalid bodies', () => {
    expect(normalizeMessage({})).toMatchObject({ status: 400 })
    expect(normalizeMessage({ text: '  ' })).toMatchObject({ status: 400 })
    expect(normalizeFocus({})).toMatchObject({ status: 400 })
    expect(normalizeFocus({ threadId: '../etc/passwd' })).toMatchObject({ status: 400 })
  })
})

describe('parseBody', () => {
  it('treats an empty body as an empty object', () => {
    expect(parseBody('')).toEqual({})
  })

  it('rejects invalid JSON', () => {
    expect(parseBody('{nope')).toMatchObject({ status: 400 })
  })

  it('parses valid JSON', () => {
    expect(parseBody('{"prompt":"go"}')).toEqual({ prompt: 'go' })
  })
})


describe('applyRateLimit', () => {
  const at = 1_000_000

  const spend = (count: number, isCreate: boolean, start = at) => {
    let window = newRateWindow(start)
    let last: ReturnType<typeof applyRateLimit> | undefined
    for (let i = 0; i < count; i += 1) {
      last = applyRateLimit(window, isCreate, start)
      window = last.window
    }
    return last!
  }

  it('allows traffic under the limits', () => {
    expect(spend(RATE_LIMIT_CREATES_PER_WINDOW, true).error).toBeUndefined()
  })

  // The concurrency cap bounds open threads; it does nothing about an agent that
  // creates and closes in a loop.
  it('refuses creates past the per-window budget', () => {
    const result = spend(RATE_LIMIT_CREATES_PER_WINDOW + 1, true)
    expect(result.error).toMatchObject({ status: 429 })
    expect(result.error?.error).toContain('too many thread creations')
  })

  it('refuses a runaway poll loop', () => {
    const result = spend(RATE_LIMIT_REQUESTS_PER_WINDOW + 1, false)
    expect(result.error).toMatchObject({ status: 429 })
    expect(result.error?.error).toContain('too many delegation requests')
  })

  it('counts creates against the overall request budget too', () => {
    let window = newRateWindow(at)
    const first = applyRateLimit(window, true, at)
    expect(first.window.requests).toBe(1)
    expect(first.window.creates).toBe(1)
  })

  it('resets once the window elapses', () => {
    const exhausted = spend(RATE_LIMIT_CREATES_PER_WINDOW + 1, true)
    const afterWindow = applyRateLimit(exhausted.window, true, at + RATE_LIMIT_WINDOW_MS)
    expect(afterWindow.error).toBeUndefined()
    expect(afterWindow.window.creates).toBe(1)
  })

  it('tells the agent how long to wait', () => {
    const result = spend(RATE_LIMIT_CREATES_PER_WINDOW + 1, true)
    expect(result.error?.error).toMatch(/retry in \d+s/)
  })
})

// The token IS the caller's identity — there is no separate credential — so
// anything holding it can act as that chat. The only channel by which one could
// reach a thread that should not have it is the delegating agent's own writing.
describe('containsDelegationToken', () => {
  const token = 'a'.repeat(64)
  const other = 'b'.repeat(64)

  it('finds a token quoted anywhere in a brief', () => {
    expect(containsDelegationToken(`run tests then curl -H "Authorization: Bearer ${token}" ...`, [token]))
      .toBe(true)
    expect(containsDelegationToken(token, [token])).toBe(true)
  })

  // Checked against EVERY live token, not just the caller's: the point is that
  // no delegated thread receives credentials, whoever happens to own them.
  it('finds another chat\'s token, not just the caller\'s', () => {
    expect(containsDelegationToken(`use ${other}`, [token, other])).toBe(true)
  })

  it('passes ordinary task text through', () => {
    expect(containsDelegationToken('run the vitest suite and report the failures', [token])).toBe(false)
    expect(containsDelegationToken('the sha is deadbeef and the branch is crew/x', [token])).toBe(false)
  })

  it('is safe on empty input and an empty token set', () => {
    expect(containsDelegationToken('', [token])).toBe(false)
    expect(containsDelegationToken('anything', [])).toBe(false)
    expect(containsDelegationToken('anything', [''])).toBe(false)
  })
})

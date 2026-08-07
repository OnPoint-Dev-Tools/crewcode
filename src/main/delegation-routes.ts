// Pure routing, validation, and policy for the local delegation API. Deliberately
// free of Electron and `node:http` so Vitest can exercise the security-relevant
// decisions (auth, isolation mapping, caps, remote denial) without a running app.
// `delegation-service.ts` owns the socket, the token registry, and IPC.

import type { ModeLevel } from '../shared/mode-types'
import type { DelegationCreateRequest, DelegationIsolation } from '../shared/delegation-types'

export const MAX_BODY_BYTES = 128 * 1024
export const MAX_PROMPT_CHARS = 32_000
export const MAX_TITLE_CHARS = 120
export const MAX_MESSAGE_CHARS = 32_000
export const DEFAULT_MAX_CONCURRENT = 4

/** Modes a delegated thread may request. `full` is additionally gated behind an
 *  explicit setting — see `applyCreatePolicy`. */
const MODES: readonly ModeLevel[] = ['ask', 'plan', 'build', 'full']

/**
 * DEFAULT isolation for a mode, not a rule. Read-only threads have nothing to
 * race over, so they share; write-capable ones default to their own worktree
 * because concurrent writers lose edits silently and contend for one git index.
 *
 * The caller may override this. Mode controls *permissions*; isolation controls
 * *where*. Tying them together made the most common request impossible: running a
 * test suite needs shell access (`build`), but a fresh worktree has no installed
 * dependencies, so the tests can't run there either.
 */
export function defaultIsolationForMode(mode: ModeLevel): DelegationIsolation {
  return mode === 'ask' || mode === 'plan' ? 'shared' : 'worktree'
}

const ISOLATIONS: readonly DelegationIsolation[] = ['shared', 'worktree']

export type DelegationRoute =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'providers' }
  | { kind: 'read';    threadId: string }
  | { kind: 'message'; threadId: string }
  | { kind: 'close';   threadId: string }
  | { kind: 'diff';    threadId: string }
  | { kind: 'merge';   threadId: string }
  | { kind: 'focus' }

export interface RouteError { status: number; error: string }

// Session ids are opaque to this layer and legitimately contain `-` and `::`
// (`<wsId>-chat`, `<tabId>::s2`), so only reject what a real id can never hold:
// path separators, whitespace, and control characters. Allowlist, not
// denylist: anything outside this set cannot be a real session id.
const VALID_ID = /^[A-Za-z0-9_.:@#+-]+$/

export function isRouteError(value: unknown): value is RouteError {
  return !!value && typeof value === 'object' && 'status' in value && 'error' in value
}

/**
 * Resolve a method+path to a route. Returns a `RouteError` rather than throwing
 * so the caller can answer every failure with the same envelope.
 */
export function matchRoute(method: string, pathname: string): DelegationRoute | RouteError {
  const verb = method.toUpperCase()
  // Trailing slashes are tolerated; empty segments are not routable.
  const segments = pathname.split('/').filter(Boolean)

  if (segments[0] !== 'v1') return { status: 404, error: 'unknown route' }

  if (segments[1] === 'focus' && segments.length === 2) {
    return verb === 'POST' ? { kind: 'focus' } : methodNotAllowed(verb)
  }

  if (segments[1] === 'providers' && segments.length === 2) {
    return verb === 'GET' ? { kind: 'providers' } : methodNotAllowed(verb)
  }

  if (segments[1] !== 'threads') return { status: 404, error: 'unknown route' }

  if (segments.length === 2) {
    if (verb === 'GET')  return { kind: 'list' }
    if (verb === 'POST') return { kind: 'create' }
    return methodNotAllowed(verb)
  }

  const threadId = decodeThreadId(segments[2])
  if (isRouteError(threadId)) return threadId

  if (segments.length === 3) {
    return verb === 'GET' ? { kind: 'read', threadId } : methodNotAllowed(verb)
  }

  if (segments.length === 4) {
    if (verb === 'GET' && segments[3] === 'diff') return { kind: 'diff', threadId }
    if (verb === 'POST') {
      if (segments[3] === 'messages') return { kind: 'message', threadId }
      if (segments[3] === 'close')    return { kind: 'close', threadId }
      if (segments[3] === 'merge')    return { kind: 'merge', threadId }
    }
  }

  return { status: 404, error: 'unknown route' }
}

function methodNotAllowed(verb: string): RouteError {
  return { status: 405, error: `${verb} is not allowed on this route` }
}

function decodeThreadId(raw: string): string | RouteError {
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return { status: 400, error: 'malformed thread id' }
  }
  if (!decoded || decoded.length > 200 || !VALID_ID.test(decoded)) {
    return { status: 400, error: 'malformed thread id' }
  }
  return decoded
}

/**
 * Extract the bearer token from an Authorization header. Returns null for any
 * malformed or missing header — the caller answers 401 either way, so there is
 * nothing to distinguish.
 */
export function bearerToken(headers: Record<string, string | string[] | undefined>): string | null {
  const raw = headers['authorization'] ?? headers['Authorization']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const match = /^Bearer\s+(\S+)$/.exec(value.trim())
  return match ? match[1] : null
}

/**
 * Reject requests whose Host header doesn't name the loopback listener. The
 * socket is already bound to 127.0.0.1, but a browser page resolving an
 * attacker-controlled name to 127.0.0.1 (DNS rebinding) would otherwise reach
 * this API with the victim's own network stack.
 */
export function hostAllowed(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false
  const [host, hostPort] = splitHostPort(hostHeader)
  if (hostPort !== String(port)) return false
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1'
}

function splitHostPort(value: string): [string, string | undefined] {
  // IPv6 literals are bracketed, so scan from the end for the port separator.
  const idx = value.lastIndexOf(':')
  if (idx === -1 || value.endsWith(']')) return [value, undefined]
  return [value.slice(0, idx), value.slice(idx + 1)]
}

/** Loopback check on the peer address, as defense in depth behind the bind. */
export function remoteAddressAllowed(address: string | undefined): boolean {
  if (!address) return false
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.')
}

export interface DelegationPolicy {
  /** Mirrors Settings → "Allow Full Access in delegated threads". */
  allowFullAccess: boolean
  /** The delegating session's current mode. Children inherit it when the spawn
   *  omits `mode`. Live value — the composer's mode toggle re-registers the
   *  session, so a mid-session switch changes what later spawns inherit. */
  parentMode: ModeLevel
  maxConcurrent: number
  /** True when the delegating session's workspace is an ssh:// root. The agent's
   *  127.0.0.1 is the remote host, not this machine, so delegation can't work. */
  remote: boolean
}

/** A validated create, plus whether the caller named the mode itself. An
 *  inherited mode is a default and may be clamped silently; an explicitly
 *  requested one is refused loudly so the agent isn't told it got what it asked
 *  for when it didn't. */
export type NormalizedCreate = DelegationCreateRequest & {
  modeExplicit: boolean
  isolationExplicit: boolean
}

/**
 * Validate and normalize a `POST /v1/threads` body.
 *
 * `mode` is optional and **inherits the delegating session's mode**. That is real
 * signal rather than a guess: if you're in Build, work you delegate is build work.
 * An explicit `mode` still wins, so an agent can spawn a read-only researcher
 * from a Build thread.
 */
export function normalizeCreate(raw: unknown, parentMode: ModeLevel): NormalizedCreate | RouteError {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 400, error: 'body must be a JSON object' }
  }
  const body = raw as Record<string, unknown>

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) return { status: 400, error: 'prompt is required' }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { status: 413, error: `prompt exceeds ${MAX_PROMPT_CHARS} characters` }
  }

  const rawTitle = typeof body.title === 'string' ? body.title.trim() : ''
  // An untitled thread is a usability problem, not an error — derive one.
  const title = (rawTitle || titleFromPrompt(prompt)).slice(0, MAX_TITLE_CHARS)

  const modeExplicit = body.mode !== undefined
  if (modeExplicit && (typeof body.mode !== 'string' || !MODES.includes(body.mode as ModeLevel))) {
    return {
      status: 400,
      error: `mode must be one of: ${MODES.join(', ')} (read-only modes share this worktree, build/full get their own)`,
    }
  }
  const mode = modeExplicit ? (body.mode as ModeLevel) : parentMode

  // Explicit isolation wins over the mode's default. `build` + `shared` is the
  // "run the test suite in this checkout" case and is legitimate.
  const isolationExplicit = body.isolation !== undefined
  if (isolationExplicit && (typeof body.isolation !== 'string' || !ISOLATIONS.includes(body.isolation as DelegationIsolation))) {
    return { status: 400, error: `isolation must be one of: ${ISOLATIONS.join(', ')}` }
  }
  const isolation = isolationExplicit
    ? (body.isolation as DelegationIsolation)
    : defaultIsolationForMode(mode)

  const agentId = optionalIdentifier(body.agentId)
  if (isRouteError(agentId)) return { status: 400, error: 'agentId must be a string' }
  const model = optionalIdentifier(body.model)
  if (isRouteError(model)) return { status: 400, error: 'model must be a string' }

  return {
    title, prompt, mode, modeExplicit, isolation, isolationExplicit,
    ...(agentId ? { agentId } : {}),
    ...(model ? { model } : {}),
  }
}

function optionalIdentifier(value: unknown): string | undefined | RouteError {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return { status: 400, error: 'expected a string' }
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, 200) : undefined
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split('\n').find(line => line.trim()) ?? prompt
  return firstLine.trim().slice(0, MAX_TITLE_CHARS)
}

/**
 * Gate a validated create against the caller's policy and current load. Split
 * from `normalizeCreate` so shape errors (the agent's fault) stay distinct from
 * policy refusals (the user's configuration).
 */
export function applyCreatePolicy(
  request: NormalizedCreate,
  policy: DelegationPolicy,
  activeCount: number,
): DelegationCreateRequest | RouteError {
  if (policy.remote) {
    return { status: 409, error: 'delegation is unavailable in remote (ssh://) workspaces' }
  }

  let mode = request.mode
  if (mode === 'full' && !policy.allowFullAccess) {
    // An explicit request for Full Access is refused loudly. An *inherited* one
    // is clamped to build instead: the agent never asked for it, and 403-ing
    // every spawn just because you're working in Full Access would make
    // delegation unusable in the mode you use most.
    if (request.modeExplicit) {
      return {
        status: 403,
        error: 'delegated threads cannot use Full Access; enable Settings → General → "Allow Full Access in delegated threads" or use mode "build"',
      }
    }
    mode = 'build'
  }
  const cap = policy.maxConcurrent > 0 ? policy.maxConcurrent : DEFAULT_MAX_CONCURRENT
  if (activeCount >= cap) {
    return { status: 429, error: `at the delegated-thread limit (${cap}); close one before creating another` }
  }

  // A clamped mode must not silently keep the strategy its original mode implied
  // — but an explicitly requested isolation is the caller's decision and stands.
  const { modeExplicit: _mode, isolationExplicit, ...rest } = request
  const isolation = isolationExplicit ? request.isolation : defaultIsolationForMode(mode)
  return { ...rest, mode, isolation }
}

/** Validate `POST /v1/threads/:id/messages`. */
export function normalizeMessage(raw: unknown): { text: string } | RouteError {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 400, error: 'body must be a JSON object' }
  }
  const text = typeof (raw as Record<string, unknown>).text === 'string'
    ? ((raw as Record<string, unknown>).text as string).trim()
    : ''
  if (!text) return { status: 400, error: 'text is required' }
  if (text.length > MAX_MESSAGE_CHARS) {
    return { status: 413, error: `text exceeds ${MAX_MESSAGE_CHARS} characters` }
  }
  return { text }
}

/**
 * True when text carries a live delegation bearer token.
 *
 * The token IS the caller's identity — there is no separate credential — so
 * anything holding it can act as that chat: spawn siblings, close threads, read
 * their transcripts, merge branches. The only channel by which a token could
 * reach a thread that should not have one is the delegating agent's own writing:
 * a brief or follow-up that quotes it, deliberately or by copying its context.
 *
 * So the boundary refuses that text outright rather than redacting it. A refusal
 * the agent can read and correct beats silently rewriting a prompt, and a 64-hex
 * string is never legitimate content in a task description.
 */
export function containsDelegationToken(text: string, tokens: Iterable<string>): boolean {
  if (!text) return false
  for (const token of tokens) {
    // Tokens are long random hex; a plain substring match has no false-positive
    // risk and catches the value however it is quoted or embedded in a curl.
    if (token && text.includes(token)) return true
  }
  return false
}

export const TOKEN_LEAK_REFUSAL =
  'this text contains a delegation bearer token; delegated threads must never receive one. '
  + 'Describe the work instead — a thread cannot delegate, so it has no use for the API.'

/** Validate `POST /v1/focus`. */
export function normalizeFocus(raw: unknown): { threadId: string } | RouteError {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 400, error: 'body must be a JSON object' }
  }
  const value = (raw as Record<string, unknown>).threadId
  if (typeof value !== 'string' || !value.trim()) {
    return { status: 400, error: 'threadId is required' }
  }
  const threadId = decodeThreadId(value.trim())
  if (isRouteError(threadId)) return threadId
  return { threadId }
}

/** Parse a request body, enforcing the size cap before JSON.parse. */
export function parseBody(raw: string): unknown | RouteError {
  if (!raw.trim()) return {}
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return { status: 413, error: 'request body too large' }
  }
  try {
    return JSON.parse(raw)
  } catch {
    return { status: 400, error: 'body is not valid JSON' }
  }
}


// ─── Rate limiting ────────────────────────────────────────────────────────────
// The concurrency cap bounds *open threads*; it does nothing about an agent stuck
// in a retry loop that creates and closes, or that hammers a read route. This is a
// simple fixed-window counter per session.

export const RATE_LIMIT_WINDOW_MS = 60_000
/** Creates are expensive (a session, a bridge, possibly a worktree). */
export const RATE_LIMIT_CREATES_PER_WINDOW = 12
/** Reads are cheap but an unbounded poll loop still burns the renderer. */
export const RATE_LIMIT_REQUESTS_PER_WINDOW = 240

export interface RateWindow {
  startedAt: number
  requests: number
  creates: number
}

export function newRateWindow(now: number): RateWindow {
  return { startedAt: now, requests: 0, creates: 0 }
}

/**
 * Record a request against a session's window, returning the next window and
 * whether it should be refused. The window resets rather than sliding: an agent
 * that trips the limit waits at most one window, which is simpler to explain in
 * an error message than a decaying budget.
 */
export function applyRateLimit(
  window: RateWindow,
  isCreate: boolean,
  now: number,
): { window: RateWindow; error?: RouteError } {
  const current = now - window.startedAt >= RATE_LIMIT_WINDOW_MS ? newRateWindow(now) : window
  const next: RateWindow = {
    startedAt: current.startedAt,
    requests: current.requests + 1,
    creates: current.creates + (isCreate ? 1 : 0),
  }

  const retryInSeconds = Math.max(1, Math.ceil((current.startedAt + RATE_LIMIT_WINDOW_MS - now) / 1000))
  if (isCreate && next.creates > RATE_LIMIT_CREATES_PER_WINDOW) {
    return { window: next, error: { status: 429, error: `too many thread creations; retry in ${retryInSeconds}s` } }
  }
  if (next.requests > RATE_LIMIT_REQUESTS_PER_WINDOW) {
    return { window: next, error: { status: 429, error: `too many delegation requests; retry in ${retryInSeconds}s` } }
  }
  return { window: next }
}

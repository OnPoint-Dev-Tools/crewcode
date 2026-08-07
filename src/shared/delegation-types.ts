// Shared contract for the local delegation API — the loopback HTTP surface a
// coding agent uses to spin up and drive real chat threads. Checked TypeScript
// (not .d.ts) so main, preload, and renderer agree on one shape. No Electron
// imports: main's route logic and the renderer's handler both load this.

import type { ModeLevel } from './mode-types'

/** Where a delegated thread does its work. Defaults from the mode but is
 *  caller-selectable: `shared` reuses the parent's checkout (and its installed
 *  dependencies — required to run tests/builds), `worktree` forks an isolated
 *  one. Mode controls permissions; this controls placement. */
export type DelegationIsolation = 'shared' | 'worktree'

/** One delegated thread as reported back to the delegating agent. Deliberately
 *  small — `GET /v1/threads` is polled, so it must not carry transcripts. */
export interface DelegatedThreadSummary {
  id: string
  title: string
  /** True while the thread's bridge is mid-turn. */
  running: boolean
  mode: ModeLevel
  isolation: DelegationIsolation
  /** Present only for `isolation: 'worktree'` threads. */
  worktreePath?: string
  branch?: string
  /** Trimmed tail of the most recent agent reply, for at-a-glance polling. */
  lastReply?: string
  /** Wall-clock ms of this thread's last completed turn. Sourced from the
   *  completed-turn store — chat messages carry only a display-formatted `time`
   *  string ("3:42 PM"), which is not a parseable timestamp. */
  completedAt?: number
  /** The thread is done: it no longer counts against the concurrency cap. It is
   *  NOT hidden or archived — the chat stays open for the user, who alone
   *  decides when to archive it. Sending it a message reopens it. */
  closed: boolean
}

export interface DelegatedThreadDetail extends DelegatedThreadSummary {
  /** Bounded tail, oldest first. Never the full transcript. */
  messages: { role: 'user' | 'agent' | 'system'; text: string }[]
}

/** Body of `POST /v1/threads`, after validation. */
export interface DelegationCreateRequest {
  title: string
  prompt: string
  agentId?: string
  model?: string
  mode: ModeLevel
  isolation: DelegationIsolation
}

/** One spawnable provider, as reported by `GET /v1/providers`. Mirrors the
 *  renderer's `AgentInfo` availability rules so an agent can't pick a provider
 *  that exists but cannot run (no API key, missing binary). */
export interface DelegationProviderInfo {
  id: string
  name: string
  available: boolean
  /** Why it can't be used, when `available` is false. */
  unavailableReason?: string
  /** Known model ids. Empty when the provider reports none (some detect models
   *  only at start); an empty list means "any model id, we can't validate". */
  models: string[]
  /** Model used when a spawn names the provider but no model. */
  defaultModel?: string
}

/** What main asks the renderer to do. The renderer owns all session state, so
 *  every route is marshalled across IPC; `sessionId` is resolved from the
 *  caller's bearer token and is never supplied by the agent. */
export type DelegationRendererRequest =
  | { kind: 'list';    sessionId: string }
  | { kind: 'providers'; sessionId: string }
  | { kind: 'create';  sessionId: string; request: DelegationCreateRequest }
  | { kind: 'read';    sessionId: string; threadId: string }
  | { kind: 'message'; sessionId: string; threadId: string; text: string }
  | { kind: 'close';   sessionId: string; threadId: string }
  | { kind: 'diff';    sessionId: string; threadId: string }
  | { kind: 'merge';   sessionId: string; threadId: string }
  | { kind: 'focus';   sessionId: string; threadId: string }

/** Standard envelope, matching the app's API response convention. */
export type DelegationResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status?: number }

/** Per-session credentials injected into an agent's context when delegation is
 *  enabled for that session. The token IS the session identity — one token per
 *  delegating session, so an agent can only ever see its own children. */
export interface DelegationCredentials {
  endpoint: string
  token: string
}

/** Outcome of merging a delegated branch back onto its base. Mirrors main's
 *  `DelegatedMergeResult`; declared here so the renderer doesn't import from
 *  `src/main/`. */
export type DelegatedMergeOutcome =
  | { ok: true; status: 'merged'; commits: number; note: string }
  | { ok: true; status: 'nothing-to-merge' }
  | { ok: false; status: 'conflict'; conflicts: string[]; note: string }
  | { ok: false; status: 'dirty'; files: string[] }
  | { ok: false; status: 'error'; error: string }

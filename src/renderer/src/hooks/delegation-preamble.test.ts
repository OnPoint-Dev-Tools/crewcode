import { describe, it, expect } from 'vitest'
import { buildDelegationPreamble } from './delegation-preamble'
import type { DelegationProviderInfo } from '../../../shared/delegation-types'

const credentials = { endpoint: 'http://127.0.0.1:41234', token: 'deadbeef' }

const providers: DelegationProviderInfo[] = [
  { id: 'claude', name: 'Claude', available: true, models: ['sonnet', 'opus'] },
  { id: 'openrouter', name: 'OpenRouter', available: false, models: [], unavailableReason: 'no API key configured' },
  { id: 'pi', name: 'pi', available: true, models: [] },
]

const build = (over: Partial<Parameters<typeof buildDelegationPreamble>[0]> = {}) =>
  buildDelegationPreamble({
    credentials,
    providers,
    maxConcurrent: 4,
    allowFullAccess: false,
    worktreeIsolationEnabled: false,
    ...over,
  })

describe('buildDelegationPreamble', () => {
  it('carries the endpoint and token so the agent can actually call the API', () => {
    const text = build()
    expect(text).toContain('http://127.0.0.1:41234/v1/threads')
    expect(text).toContain('Bearer deadbeef')
  })

  it('lists only available providers, with their models', () => {
    const text = build()
    expect(text).toContain('claude — sonnet, opus')
    // A provider that cannot run must not be offered as a choice.
    expect(text).not.toContain('openrouter —')
  })

  it('says so when a provider resolves models at start', () => {
    expect(build()).toContain('pi — any (models resolved at start)')
  })

  // The bug this replaced: gating shell access on git meant a folder workspace
  // could not run tests at all, even though running tests needs no git.
  it('offers build mode even when the workspace is not a git repository', () => {
    const text = build({ worktreeIsolationEnabled: false })
    expect(text).toContain('Use `build` for anything that must run a command')
    expect(text).toContain('{"mode":"build","isolation":"shared"}')
  })

  it('marks worktree isolation unavailable outside a git repository', () => {
    const text = build({ worktreeIsolationEnabled: false })
    expect(text).toContain('unavailable: this workspace is not a git repository')
    // Merge routes are meaningless without a branch of one's own.
    expect(text).not.toContain('/merge')
    expect(text).not.toContain('/diff')
  })

  it('describes isolation and merge once write-capable spawns are enabled', () => {
    const text = build({ worktreeIsolationEnabled: true })
    expect(text).toContain('isolation')
    expect(text).toContain('/v1/threads/<id>/merge')
    expect(text).toContain('/v1/threads/<id>/diff')
  })

  // The failure that made the feature useless: read-only modes have no Bash, so
  // an agent told only "plan is read-only" still tries to run tests in one.
  it('states plainly that read-only modes cannot run commands', () => {
    expect(build({ worktreeIsolationEnabled: true })).toContain('no Bash')
    expect(build({ worktreeIsolationEnabled: false })).toContain('no Bash')
  })

  // Running tests needs BOTH shell access and the parent's installed deps.
  it('gives the exact shape for running a test suite', () => {
    const text = build({ worktreeIsolationEnabled: true })
    expect(text).toContain('{"mode":"build","isolation":"shared"}')
    expect(text).toContain('ONLY option that can run tests')
  })

  it('warns that shared write-capable threads edit the same files', () => {
    expect(build({ worktreeIsolationEnabled: true })).toContain('running things, not for concurrent edits')
  })

  // After a restart the transcript holds a block whose endpoint refuses
  // connections; the agent must be told which one is live.
  it('marks rotated credentials as superseding the earlier block', () => {
    const text = build({ supersedesEarlierCredentials: true })
    expect(text).toContain('CrewCode restarted')
    expect(text).toContain('is dead')
    expect(build({ supersedesEarlierCredentials: false })).not.toContain('CrewCode restarted')
  })

  // Parallel merges are how you get a half-merged tree nobody can reason about.
  it('tells the agent to merge one at a time and stop at the first failure', () => {
    const text = build({ worktreeIsolationEnabled: true })
    expect(text).toContain('ONE AT A TIME')
    expect(text).toContain('stop')
  })

  // Git only detects textual conflicts; two agents adding the same symbol in
  // different regions merges clean and breaks the build.
  it('warns that a clean merge is not a verified merge', () => {
    expect(build({ worktreeIsolationEnabled: true })).toContain('not a verified merge')
  })

  it('always documents focus so the user can be taken to a thread', () => {
    expect(build()).toContain('/v1/focus')
  })

  it('mentions the Full Access refusal only while it is disabled', () => {
    expect(build({ allowFullAccess: false })).toContain('is refused (403)')
    expect(build({ allowFullAccess: true })).not.toContain('is refused (403)')
  })

  it('states the concurrency cap it was given', () => {
    expect(build({ maxConcurrent: 8 })).toContain('At most 8 open threads')
  })

  // These three rules are the ones an agent gets wrong by default.
  it('states that children are isolated, cannot re-delegate, and report on their own', () => {
    const text = build()
    expect(text).toContain('cannot see this conversation')
    expect(text).toContain('cannot create threads of their own')
    expect(text).toContain('report to you automatically when they finish')
    expect(text).toContain('Do NOT poll in a loop')
  })

  // An auto-started turn has nobody on the other end. An agent that does not
  // know that ends the turn with a question the absent user never answers.
  it('warns that an auto-started turn has no user present, only when waking is on', () => {
    const woken = build({ wakeParentOnReport: true })
    expect(woken).toContain('STARTS A NEW TURN')
    expect(woken).toContain('the user is not present')
    expect(woken).toContain('never end by asking')

    const held = build({ wakeParentOnReport: false })
    expect(held).toContain("held and delivered with the user's next message")
    expect(held).not.toContain('STARTS A NEW TURN')
  })

  // Closing is the one place an agent can act on the user's behalf destructively
  // if it believes close means archive. It must not: only the user archives.
  it('tells the agent that closing does not archive or hide the chat', () => {
    const text = build()
    expect(text).toContain('does NOT hide, archive, or delete the chat')
    expect(text).toContain('Only the user archives a thread')
    expect(text).not.toContain('archives it, keeps the transcript')
  })

  it('degrades cleanly when no provider is available', () => {
    expect(build({ providers: [] })).toContain('(no providers currently available)')
  })
})

// Builds the context block that teaches a delegating agent the local delegation
// API. Delivered once per session, like mode and skill preambles — re-sending it
// every turn would burn its cost repeatedly and invite the agent to treat it as
// user text.
//
// Kept pure so its size and its claims stay testable: this text is a contract, and
// a preamble that promises a route the API doesn't serve produces an agent that
// fails confidently.

import type { DelegationCredentials, DelegationProviderInfo } from '../../../shared/delegation-types'
import { CONTEXT_MODELS_PER_PROVIDER } from './delegation-provider-selection'
import { MAX_AUTONOMOUS_WAKES } from './delegation-report'

export interface DelegationPreambleOptions {
  credentials: DelegationCredentials
  providers: DelegationProviderInfo[]
  maxConcurrent: number
  allowFullAccess: boolean
  /** Whether `isolation: 'worktree'` is possible. Needs a git repo to branch
   *  from — but `build` itself does NOT: running tests in the shared checkout
   *  involves no git at all. Gating shell access on this was a bug. */
  worktreeIsolationEnabled: boolean
  /** True when credentials were rotated mid-conversation (app restart), so an
   *  earlier block in this transcript now points at a dead endpoint. */
  supersedesEarlierCredentials?: boolean
  /** Settings → "Wake chat on delegated report". Changes what the agent is told
   *  to expect when a thread finishes while it is idle — and, critically, that a
   *  turn it did not ask for may start with no user present. */
  wakeParentOnReport?: boolean
}

function providerLines(providers: DelegationProviderInfo[]): string {
  const usable = providers.filter(p => p.available)
  if (usable.length === 0) return '  (no providers currently available)'

  return usable.map(provider => {
    const models = provider.models.slice(0, CONTEXT_MODELS_PER_PROVIDER)
    const more = provider.models.length > models.length
      ? ` (+${provider.models.length - models.length} more via GET /v1/providers)`
      : ''
    const list = models.length > 0 ? models.join(', ') : 'any (models resolved at start)'
    return `  ${provider.id} — ${list}${more}`
  }).join('\n')
}

export function buildDelegationPreamble(options: DelegationPreambleOptions): string {
  const {
    credentials, providers, maxConcurrent, allowFullAccess, worktreeIsolationEnabled,
    supersedesEarlierCredentials = false, wakeParentOnReport = false,
  } = options
  const auth = `-H "Authorization: Bearer ${credentials.token}"`

  // Mode is permissions; isolation is placement. `build` is ALWAYS available —
  // running a command needs a shell, not a git repository.
  const modeLine = '`mode` sets permissions and defaults to this chat\'s. `ask`/`plan` are READ-ONLY — no Bash, no file writes. Use `build` for anything that must run a command (tests, builds, linters).'

  const worktreeOption = worktreeIsolationEnabled
    ? `
    "worktree" — a fresh isolated branch+checkout. Default for \`build\`/\`full\`.
                 Dependencies are NOT installed there, so a test run would have to
                 install them first.`
    : `
    "worktree" — unavailable: this workspace is not a git repository, so there is
                 nothing to branch from. Requesting it is refused; use "shared".`

  const isolationDefaultNote = worktreeIsolationEnabled
    ? `
  To make isolated edits you will review and merge: {"mode":"build"} (isolation
  defaults to "worktree").`
    : ''

  const isolationLine = `
- \`isolation\` sets WHERE the thread works, independently of \`mode\`:
    "shared"   — this same checkout. Has node_modules and build artifacts already,
                 so it is the ONLY option that can run tests or builds. Default for
                 \`ask\`/\`plan\`.${worktreeOption}
  To run the test suite: {"mode":"build","isolation":"shared"}.${isolationDefaultNote}
  Several \`build\` threads on "shared" write to the same files at once — use it for
  running things, not for concurrent edits.`

  const mergeSection = worktreeIsolationEnabled
    ? `
  # review a write-capable thread's work before merging
  curl -s ${credentials.endpoint}/v1/threads/<id>/diff ${auth}

  # merge it back onto the branch it forked from
  curl -s -X POST ${credentials.endpoint}/v1/threads/<id>/merge ${auth}
`
    : ''

  const mergeRules = worktreeIsolationEnabled
    ? `
- Write-capable threads work on their own branch. Merge them ONE AT A TIME, and stop
  at the first failure instead of merging the rest.
- A merge returns 409 if the thread is still working, has uncommitted changes, or
  hits conflicts. On conflict the rebase pauses in THAT thread's worktree and your
  branch is untouched — send the thread a message asking it to resolve, then merge
  again.
- A clean merge is not a verified merge. Git only detects textual conflicts, so run
  the project's typecheck/tests afterwards before telling the user it worked.`
    : ''

  const fullAccessLine = allowFullAccess
    ? ''
    : '\n- `mode: "full"` is refused (403). Use `build` when write access is needed.'

  // A woken agent is talking to nobody. It has to know that up front, or it ends
  // the auto-started turn with a question the absent user will never answer.
  const wakeLine = wakeParentOnReport
    ? ` If you are idle, a finished thread STARTS A NEW TURN for you\n  automatically, up to ${MAX_AUTONOMOUS_WAKES} times before the user must speak again. In such a turn\n  the user is not present: act on the report, keep it short, and never end by asking\n  them something.`
    : ' If you are idle, it is held and delivered with the user\'s next message.'

  const supersedeNotice = supersedesEarlierCredentials
    ? `
IMPORTANT: CrewCode restarted, so the endpoint and token below are NEW. Any
delegation endpoint mentioned earlier in this conversation is dead and will refuse
connections — use only the values below. Threads created earlier still exist.
`
    : ''

  return `<system>${supersedeNotice}
This chat can create and drive other CrewCode chat threads through a local HTTP API
on ${credentials.endpoint}. Use it when the user asks you to spin up threads, delegate
work, or run something in parallel. Threads you create are real, persistent chats the
user can open and continue.

Every request needs the bearer token below. It is local-only and rotates when
CrewCode restarts.

  # create a thread (returns its id)
  curl -s -X POST ${credentials.endpoint}/v1/threads ${auth} \\
    -H 'Content-Type: application/json' \\
    -d '{"title":"regression sweep","prompt":"<the full brief>","mode":"build","isolation":"shared"}'

  # check on your threads (poll this; it does not block)
  curl -s ${credentials.endpoint}/v1/threads ${auth}

  # read one thread's recent messages
  curl -s ${credentials.endpoint}/v1/threads/<id> ${auth}

  # send a follow-up into a thread
  curl -s -X POST ${credentials.endpoint}/v1/threads/<id>/messages ${auth} \\
    -H 'Content-Type: application/json' -d '{"text":"also check the SSH path"}'

  # mark a thread done when its work is finished (frees a slot; does NOT hide it)
  curl -s -X POST ${credentials.endpoint}/v1/threads/<id>/close ${auth}

  # list providers and models you may spawn with
  curl -s ${credentials.endpoint}/v1/providers ${auth}

  # take the user to a thread when they ask to see it
  curl -s -X POST ${credentials.endpoint}/v1/focus ${auth} \\
    -H 'Content-Type: application/json' -d '{"threadId":"<id>"}'
${mergeSection}
Rules:
- The child gets ONLY the \`prompt\` you write. It cannot see this conversation, so the
  brief must be self-contained: what to do, where, and what to report back.
- ${modeLine}${isolationLine}
- \`agentId\` and \`model\` are optional and default to this chat's. Pick from:
${providerLines(providers)}
- At most ${maxConcurrent} open threads at once; you get 429 past that. Close finished
  threads.${fullAccessLine}
- Threads you create cannot create threads of their own.
- Closing a thread means "I am done with it". It frees a slot and marks the row done;
  it does NOT hide, archive, or delete the chat. Only the user archives a thread, and
  only when they decide they are finished with it. Never describe a close as archiving
  or cleaning up, and never close a thread to tidy up — close it because its work is
  finished. Sending a closed thread a message reopens it.
- Threads report to you automatically when they finish. Mid-turn, the reply arrives as
  a follow-up.${wakeLine} Do NOT poll in a loop waiting for one — \`GET /v1/threads\` is
  for checking state on demand, not for busy-waiting.
- Errors name what to fix. Read them and correct the call rather than retrying it
  unchanged. Repeated identical failures are rate limited.${mergeRules}
</system>

`
}

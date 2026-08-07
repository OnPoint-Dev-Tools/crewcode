# Delegated Threads

Lets a coding agent create and drive **real, persistent chat sessions** from inside a
turn, so "spin up some agents in another thread to run a regression test, keep me
updated" produces threads you can open, read, and continue yourself.

This is distinct from Crew Surface. Crew lanes are ephemeral, live in one tab, and
exist for the duration of a crew run. Delegated threads are ordinary `Session`s with
transcripts, archiving, and drawer rows — they outlive the turn that made them.

## Contract

- Delegation is **off by default**, enabled per session.
- **`mode` is permissions; `isolation` is placement, and they are independent.**
  Read-only modes have no shell at all, so anything that runs a command needs
  `build`. See [Mode and isolation](#mode-and-isolation-are-independent).
- Delegated threads **inherit the parent session's mode** unless the spawn names one.
  They cap at `build`; `full` requires explicit opt-in.
- Delegated threads cannot delegate further (**depth 1**), enforced at three
  layers rather than by withholding credentials alone. See
  [Depth-1](#depth-1-is-enforced-not-incidental).
- The bearer token **is** the caller's identity, so it must never reach a thread.
  Briefs and follow-ups containing one are refused. See
  [The token is the identity](#the-token-is-the-identity).
- Remote (`ssh://`) workspaces are denied with an explicit error.
- **An agent can never archive a chat.** `close` means "I am done with this thread":
  it frees a concurrency slot and dims the drawer row, and that is all. Archiving is
  a user action. See [Closing is not archiving](#closing-is-not-archiving).
- **Workers report back automatically.** A finished thread's reply goes into the
  parent's running turn, wakes an idle parent (bounded), or is buffered for its next
  message. See [Reporting back](#reporting-back).

## Why a local HTTP API, not MCP

Every provider already has shell access, so `curl` works identically for claude,
codex, pi, opencode, hermes, CrewCoder, and ollama. MCP would have covered only
claude (SDK in-process server) and hermes (ACP `session/new`); CrewCoder's bridge
currently sends an empty MCP list, and codex/pi/opencode have no MCP consumption
path today. One HTTP server in main removes the provider-parity problem
entirely.

## Architecture

```
agent shell (curl)
  -> main: DelegationService (127.0.0.1, ephemeral port, bearer token)
    -> IPC request/response with correlation id
      -> renderer: useDelegatedThreads -> useChatSessions / bridges / navigation
```

State ownership does not change: sessions still live in the renderer. Main is a
transport that marshals HTTP calls into renderer IPC and marshals the reply back.

### Credentials rotate on every restart

The port is ephemeral and the token is per-launch, so **both change when CrewCode
restarts**. A conversation that already received a delegation block would otherwise
be holding a dead endpoint — `curl` exits 7, connection refused.

Delivery is therefore keyed by `<sessionId>::<token>`, not session id alone. A
rotated token re-delivers on the next prompt, and the new block opens with an
explicit notice that any endpoint mentioned earlier in the transcript is dead.
Threads created before the restart still exist and are still listed.

### Security shape

Modeled directly on `src/main/local-voice-service.ts`:

- Bind `127.0.0.1` only; reject any non-loopback bind.
- `listen(0)` for an ephemeral port. A fixed port collides with a second CrewCode
  instance and with the voice sidecar's 17841.
- `randomBytes(32).toString('hex')` bearer token, generated per app launch and
  owned by main. A token that leaks into a persisted transcript is dead on restart.
- The renderer never calls the HTTP surface. It only answers IPC.
- Server starts lazily on the first session that enables delegation and stops on
  app quit.

## API

All routes require `Authorization: Bearer <token>`. All responses use the standard
envelope (`{ ok, data, error }`).

| Method | Route | Purpose |
| ------ | ----- | ------- |
| `GET`  | `/v1/threads` | List the caller's delegated threads: id, title, running, lastMessageAt, summary of last agent reply |
| `POST` | `/v1/threads` | Create one. Body: `{ prompt, mode?, isolation?, title?, agentId?, model? }`. `mode` defaults to the parent's; `isolation` defaults from the mode. Returns `{ id }` |
| `GET`  | `/v1/threads/:id` | Status plus a bounded transcript tail |
| `POST` | `/v1/threads/:id/messages` | Send a follow-up into a delegated thread |
| `POST` | `/v1/threads/:id/close` | Mark it done (`Session.delegationClosedAt`). Frees a slot; does **not** archive or hide the chat |
| `GET`  | `/v1/threads/:id/diff` | The child's diff against its base, for review before merge |
| `POST` | `/v1/threads/:id/merge` | Rebase onto the base and fast-forward. `409` + conflicted paths on conflict |
| `GET`  | `/v1/providers` | Available providers and their models, for choosing a spawn's `agentId`/`model` |
| `POST` | `/v1/focus` | `{ threadId }` — navigate the UI to that thread |

The token **is** the caller's identity: one token per delegating session, minted on
enable and mapped to that session id in main. `GET /v1/threads` therefore returns only
that agent's own children, and an agent cannot address another session's threads by
guessing an id — there is no session parameter on the wire to forge.

### Choosing a provider and model

A spawn may name `agentId` and `model` to run a delegated thread on a different
provider than the parent — "start a thread with <model> and test X". Both default
to the parent's so a thread never silently lands on a different agent.

Cross-provider spawns are cheap here precisely because delegated threads start
fresh: no context handoff, no disposable summary, none of the `handoff` machinery a
mid-chat provider switch needs.

Three things have to hold for that to work from a casual sentence:

1. **Discovery.** `GET /v1/providers` returns each provider's id, availability, and
   model ids, and a compressed form of that list goes into the injected context.
   Without it the model invents plausible-looking ids from your prose and fails
   every time.
2. **Validation at the API boundary.** An unknown `agentId`/`model` must be a `400`
   *before* a session exists. Passing it through creates a thread that dies at
   bridge start, leaving a dead row in your delegated section with a cryptic error.
3. **Availability, not just existence.** `AgentInfo` already carries `available`,
   `requiresApiKey`, and `hasApiKey`. OpenRouter without a key and Ollama without
   its binary both exist but cannot run; naming one fails immediately.

Rejections name the valid options — `unknown provider "gpt-luna"; available: claude,
codex, openrouter, ollama` — so the agent self-corrects on retry instead of failing
silently. That is the whole reason these errors are verbose.

### Failure modes that must be explicit

- Window reloading or closed: fail fast with a real error, never hang the agent's
  curl. IPC round-trips get a 10s timeout.
- `ssh://` workspace: `409` with "delegation is unavailable in remote workspaces"
  (the agent's `127.0.0.1` is the remote host, not this machine).
- Concurrency cap reached: `429`.
- Unknown or unavailable `agentId`/`model`: `400` listing what is available.
- Explicit `mode: 'full'` without opt-in: `403` naming the setting. An *inherited*
  `full` is clamped to `build` instead — see [Isolation](#isolation).

## Mode and isolation are independent

**`mode` is permissions. `isolation` is placement.** They were coupled in the first
implementation and that made the feature's primary use case impossible:

- Running a test suite needs shell access. `ask` and `plan` disallow `Bash`, `Edit`,
  and `Write` outright (see `READ_ONLY_DISALLOWED_TOOLS` in `claude-bridge.ts`), so a
  read-only thread cannot run anything.
- `build`/`full` have shell access — but forcing them into a fresh worktree means no
  `node_modules`, so the tests still can't run.

A related instance of the same mistake: shell access was *also* gated on the
workspace being a git repository. It never needed to be — `build` + `shared` runs
in the parent's checkout and touches no git. Only `isolation: 'worktree'` needs a
repo to branch from, so that is the only thing gated now.

Both halves of "spin up a thread to run the regression suite" were therefore
unreachable. `isolation` is now a separate, caller-selectable field:

| | `isolation: 'shared'` | `isolation: 'worktree'` |
| --- | --- | --- |
| Where | The parent's checkout | Fresh branch + checkout |
| Dependencies | Already installed | **Not installed** |
| Use for | Running tests, builds, linters | Isolated edits you review and merge |
| Default for | `ask`, `plan` | `build`, `full` |
| Needs a git repo | No | Yes |

`{"mode":"build","isolation":"shared"}` is the shape for running a test suite, and
the preamble says so explicitly. Several `build` threads on `shared` write to the
same files concurrently — that combination is for *running* things, not for parallel
edits.

A clamped mode (inherited `full` -> `build`) recomputes isolation only when the
caller did **not** state one; an explicit isolation is the caller's decision and
survives the clamp.

## Isolation defaults

Isolation defaults from the effective mode — the spawn's explicit `mode` if it named
one, otherwise the parent session's.

| Effective mode | Worktree | Rationale |
| -------------- | -------- | --------- |
| `ask` / `plan` | Parent's, shared | Read-only. No writes means no races, and the parent worktree already has installed dependencies so test/build commands actually run. |
| `build` / `full` | Own worktree + branch | Concurrent writers to one worktree lose edits silently (last-write-wins on a shared file, no conflict marker) and share one git index/HEAD. Isolation is what worktrees are for. |

Write-capable spawns call the existing `addWorktree(repoPath, branch, ...)` in
`src/main/worktree-ops.ts` with a generated branch name (`crewcode/delegated/<slug>-<short-id>`),
create the child session against that path, and surface it in the workspace's
worktree list like any other. Results come back as a branch you review and merge
through the existing Git Workspace / Git Sidebar — the same flow as a crew worktree.

`mode` is optional and **inherits the delegating session's current mode**. That is
real signal rather than a guess: work delegated from a Build thread is build work.
An explicit `mode` still wins in both directions, so an agent can spawn a read-only
researcher from a Build thread or a builder from a Plan thread.

Inheritance reads the *live* parent mode — the composer's mode toggle re-registers
the session, so flipping Plan -> Build mid-conversation changes what later spawns
inherit.

Full Access is handled asymmetrically on purpose:

| Requested how | Full Access disabled | Full Access enabled |
| ------------- | -------------------- | ------------------- |
| Explicit `mode: 'full'` | `403` naming the setting | Granted |
| Inherited from a Full Access parent | Silently clamped to `build` | Granted |

An explicit request is refused loudly so the agent is never told it got what it
asked for when it didn't. An inherited one is clamped, because the agent never
asked for Full Access and 403-ing every spawn would make delegation unusable from
the mode you work in most. Isolation is recomputed from the effective mode, never
carried over from the requested one.

### Getting work back: merge

Isolation does not remove collisions. It converts them from **silent data loss**
(last write wins on a shared file, no marker, the agent reports success) into an
**explicit git conflict at merge time** — loud, reviewable, resolvable. That is
strictly better, but someone still resolves it.

**What actually conflicts.** Touching the same file is necessary but not
sufficient: git merges at hunk granularity, so two agents editing distant regions
of one file merge cleanly. A conflict needs overlapping or near-adjacent line
ranges (git needs a few lines of unchanged context between edits). Also conflicting,
despite not being "the same file changed twice": both-added files with the same
path, and edit-vs-delete or edit-vs-rename pairs.

**A clean merge is not a correct merge.** Semantic conflicts pass git untouched:
two agents each add a `formatUser` in different regions, or one renames a function
while another adds a call to the old name in a *different file*. Git is happy;
the build is not. Every merge must therefore be followed by a typecheck/test run
before the result is trusted, and the merge response says so rather than implying
success.

All children fork from the delegating session's current HEAD, recorded as
`delegationBase` on the child. Merges run **sequentially in completion order**, never
in parallel, and never automatically:

1. Child finishes and commits on its own branch.
2. `POST /v1/threads/:id/merge` rebases the child branch onto the current
   `delegationBase` tip **inside the child's own worktree**.
3. Clean rebase -> fast-forward merge into the base branch. Response reports the
   commit.
4. Conflict -> the rebase stops in the child's worktree. The API returns
   `409` with the conflicted paths; nothing lands in your working tree.

Conflicts surface in the **child's** worktree on purpose. That is where the agent
that wrote the change is still sitting, with the context for why it made it. Your
primary worktree is never left mid-merge by a background thread.

The delegating agent can then call `POST /v1/threads/:id/messages` to tell the child
to resolve, or you open the thread and drive it yourself. This reuses the existing
`onResolveConflict({ file, strategy: 'ours' | 'theirs' | 'agent' })` path in
`useGitSidebar` — `'agent'` already drops a resolution prompt into the owning tab's
composer, which is exactly the delegated-thread case.

`GET /v1/threads/:id/diff` returns the child's diff against its base so the parent
can review before asking for a merge.

**Never auto-merge.** A background thread that merges into your branch without you
looking is how you lose an afternoon. Merge is always an explicit call, and the
first failed merge stops the sequence rather than continuing into the next child.

### The dependency-install tax

A fresh worktree has no `node_modules` (or `target/`, `venv/`, ...). A write-capable
delegated thread that needs to *run* something therefore has to install first, which
can take minutes and is per-thread.

CrewCode does **not** auto-install. The spawn response reports the worktree path and
that it is uninstalled; the agent decides whether its task needs an install and runs
it in its own thread where you can see the cost. Silently running `npm install` on
four spawned worktrees behind your back is not acceptable behavior.

This is the main reason read-only threads share the parent worktree: "run the
regression suite and report back" is the common case, needs no isolation, and needs
dependencies that already exist.

### Cleanup

Archiving or closing a delegated thread does **not** delete its worktree — the
branch may hold work you have not merged. Cleanup is an explicit user action in the
worktree UI. Removal goes through `removeWorktree`, which refuses dirty worktrees;
never recursive-delete a worktree path directly.

## Data model

`Session` gains:

```ts
origin?: 'delegated'
delegatedBy?: string      // parent session id
delegatedAt?: number
delegatedWorktreePath?: string   // isolation: 'worktree' only
delegatedBranch?: string
delegationBase?: string          // commit the child forked from, and merges back onto
```

Absent on every existing persisted session, so reads use `?? undefined` and legacy
threads simply read as user-created. No migration needed.

Read-only delegated threads are siblings in the parent's tab, so cwd inheritance is
automatic. Write-capable threads own a worktree, so they get their own tab bound to
that path and carry `delegatedWorktreePath` / `delegatedBranch` for cleanup and for
the drawer's worktree row.

## Renderer wiring

`useDelegatedThreads` answers main's marshalled calls against real session state.
Handlers must **always** reply — a throw that never responds leaves the delegating
agent's curl hanging until main's 10s timeout, so the IPC callback catches and
converts to a 500.

- **create** — `chatSessions.addDelegated(parentTabId, spawn)`, then
  `sendChatSessionPrompt` with the brief. The response is sent only after the
  prompt is accepted: an agent handed a thread id must be able to poll it rather
  than race the thread's first turn.
- **list/read** — projected through `delegated-thread-projection.ts`. Bounded:
  `lastReply` is capped at 400 chars, `read` returns the most recent 20 messages at
  2,000 chars each. Never ship a full transcript over IPC — polling four threads
  has to stay cheap.
- **close** — sets `Session.delegationClosedAt`. Explicitly **not** `setArchived`;
  see [Closing is not archiving](#closing-is-not-archiving). Sending a closed thread
  a message clears the flag, so it counts against the cap again while it works.
- **focus** — `setActiveTabInWorkspace` + set active session (step 5). Not
  `setActiveTabId`, which is bound to the active workspace and goes stale
  cross-workspace.

### `addDelegated` vs `add`

Two deliberate differences from the normal session-create path:

1. **It does not activate the new session.** A delegating turn can spawn several
   threads while you are reading a different one; `add()` sets the active session,
   which would yank the view out from under you mid-turn.
2. **Ids are allocated from `idAllocationRef`, not the render-time closure.** A
   fan-out calls this several times in one tick, where `sessionsByTab` is still
   stale — allocating from it hands two threads the same id and aliases them onto
   one transcript.

### What the child inherits

Provider and model default to the parent's, so a delegated thread does not silently
land on a different agent. Skills and applied mode prompts are **not** inherited:
the brief is the whole context.

### Credentials are owned per pane, not by App

`useSessionDelegation` lives in `ChatPane`, deliberately. App tracks only the
*active* session, so an App-level effect would leave the second pane of a split
layout without credentials while still showing its toggle as on. Each mounted pane
registers its own session and revokes on unmount.

Enabling is what starts the loopback server (lazily, in main); disabling revokes the
token, and the socket closes when the last session drops it. A user who never turns
delegation on never has an open port.

Re-enabling mints a **new** token, so the delivered-marker is cleared and the block
is re-sent on the next prompt. Same on app restart — tokens are per-launch.

### The preamble is a contract

`delegation-preamble.ts` is pure and tested against its own claims. A preamble that
advertises a route or mode the API refuses produces an agent that fails
confidently — so `writeCapableEnabled: false` makes it say `ask`/`plan` only, and
the Full Access refusal line appears only while that setting is off.

Four rules are stated because agents get them wrong by default: the child cannot
see the parent's conversation (the brief must be self-contained), children cannot
re-delegate, closing is not archiving, and threads report on their own — so polling
in a loop is waste, not diligence.

## Depth-1 is enforced, not incidental

The parent's preamble tells the agent "threads you create cannot create threads of
their own." That was true only because children were never handed credentials —
an omission, not a rule. It held right up until someone opened a delegated thread
and clicked **Delegate**, at which point that thread registered, got its own token,
and started spawning grandchildren with no depth limit behind it.

`canSessionDelegate(session)` (`origin !== 'delegated'`) is now checked at three
layers, because a depth limit checked in one place is one that persisted state can
walk around:

| Layer | What it stops |
| --- | --- |
| `ChatPane` — the Delegate toggle is not rendered for a delegated session | The user turning it on by hand |
| `useSessionDelegation` — refuses to mint credentials | `delegationEnabled` persisted true from an older build, or a duplicate of an enabled chat |
| `useDelegatedThreads.perform()` — 403 on **every** route | A token that reached a delegated thread by any route at all |

The API layer is the authoritative one, and it covers every route rather than just
`create`: a delegated caller must not be able to read siblings' transcripts or merge
their branches either.

`origin` is provenance, not current ownership. Continuing a delegated thread
yourself, or the agent marking it done, never promotes it to a root chat.

## The token is the identity

There is no separate credential: whoever holds the bearer token **is** that chat as
far as the API is concerned. It can spawn siblings, close threads, read their
transcripts, focus the UI, and merge branches.

Only one channel could ever carry a token to a thread that should not have one —
the delegating agent's own writing, quoting it into a brief or a follow-up, whether
deliberately or by copying its own context. So `containsDelegationToken` checks
`POST /v1/threads` prompts and `POST /v1/threads/:id/messages` text against **every
live token** (not just the caller's) and refuses with 400.

Refusing beats redacting: a 64-hex string is never legitimate content in a task
description, and an error the agent can read and correct is better than silently
rewriting its prompt.

This does not make the token a secret from the machine — any process that can read
the agent's context can read it. It closes the one path CrewCode itself controls.

## Closing is not archiving

`close` used to call `setArchived(...)`, which hides a session from **every** live
surface. That handed the agent a decision that was never its to make: the user
opens a delegated thread to read it, and the agent — doing exactly what it was told,
tidying up finished work — makes it disappear mid-review.

The two states are now separate:

| | `close` (agent) | archive (user) |
| --- | --- | --- |
| Field | `delegationClosedAt` | `archived` / `archivedAt` |
| Frees a concurrency slot | yes | yes |
| Visible in the drawer | yes, dimmed with a `done` chip | no |
| Openable / continuable | yes | only from the archive tab |
| Reversible by the agent | yes — a new message reopens it | no |

`closed: true` in the API projection means *either*, because to the delegating agent
both mean "this no longer occupies a slot". Everything user-facing keys off
`archived` alone.

Consequences worth knowing:

- The delegated section grows until you archive things. That is the deliberate
  trade: an agent cannot decide you are finished, so the cleanup is yours.
- `focus` works on a done thread and refuses an archived one, with an error naming
  the user as the actor so the agent does not retry.
- The preamble tells the agent never to describe a close as archiving, and never to
  close a thread "to tidy up".

## Reporting back

The original design was pull-only: the preamble told the agent to poll
`GET /v1/threads` when next spoken to. In practice agents forget to poll, and the
ones that don't forget busy-wait in a `sleep`/`curl` loop instead.

`useDelegationReports` is the push half. It subscribes to the bridge registry's
`subscribeTurnEnd` fan-out — the same mechanism the crew Supervisor uses to relay
worker replies — and on a delegated thread's turn end:

1. Resolves the child's parent. Skips anything that is not `origin: 'delegated'`,
   and skips parents whose delegation toggle is off (that agent no longer holds the
   context explaining what a delegated thread is).
2. Builds a bounded report via `delegation-report.ts`: the final agent reply clamped
   to 1,600 chars, or the last error row if the thread died before replying.
3. Queues it into that parent's **coalescing window** (`REPORT_COALESCE_MS`,
   1.5s), then delivers the whole batch at once:

| Parent state | Delivery | Costs budget |
| --- | --- | --- |
| Mid-turn | Follow-up into the running turn (`streamingBehavior: 'followUp'`), like a crew worker reporting to its supervisor. No delay — nothing to coalesce for | no |
| Idle, waking on, budget left | One fresh turn carrying **every** ready report | only if recursive |
| Idle, waking off | Buffered in `delegation-inbox-store.ts`, prepended to the next prompt by `chat-session-send.ts` | — |
| Idle, budget spent | Buffered, with an explicit "paused" notice | — |

Any failure at any step falls back to the buffer — a refused follow-up, a wake
prompt the bridge rejects, a parent whose bridge cannot be revived. A report is
never dropped. In every case a system row lands in the parent's transcript, so a
report is never invisible even when nothing else happens.

### Coalescing, and why it is not optional

Waking a parent costs a **full model turn at that chat's entire context**. The
report itself is trivial — 1,600 chars, a few hundred tokens. The turn it triggers
is not: an 80k-token chat costs 80k input tokens to wake.

So five workers finishing together must produce **one** wake, not five. Crew has
always done this — `feedSupervisor` drains all buffered replies into one supervisor
turn — and the first version of this feature did not, which is the whole reason the
window exists.

Two mechanisms, both lifted from crew:

- **`REPORT_COALESCE_MS` window.** A finished report waits 1.5s for siblings.
  Workers that finish within a second of each other are almost always one request.
- **A `delivering` flag claimed synchronously before the first `await`** — crew's
  `busy`, and its comment at `useCrewSupervisor.ts:251` explains the same race:
  parallel workers each check-then-act on one coordinator, and without the
  synchronous claim they all see an idle parent and fire concurrent prompts at one
  bridge. Reports that arrive mid-delivery queue behind it and drain when it settles.

### Waiting for the transcript to settle

`turn_end` fires **before** the renderer flushes its stream buffers. Reading the
transcript synchronously in that callback captures the text that existed before the
final flush — in practice the agent's opening line ("I'll run the suite") and none
of its result. The first real run of this feature produced exactly that: a report
whose content was the worker restating its intent, and a parent that concluded the
thread had done nothing.

So a finished thread is re-read on a retry loop — `REPORT_SETTLE_ATTEMPTS` × 
`REPORT_SETTLE_INTERVAL_MS` (8 × 75ms), mirroring crew's `reportLaneReply` — until
`hasStreamingOutput` is false and a report can be built. After the budget is spent
it reports whatever it has, so a tool-only turn still produces something.

### One turn reports exactly once

`useAgentBridge` routes `turn_end`, `error` **and** `closed` through the same
callback, so one logical turn can fire it several times.

The first implementation deduplicated on reply *text*, which cannot work once the
settle retry exists: an early event and a late one legitimately see different text,
so every duplicate looked like a new report. That is what produced two rows for one
thread — `woke this chat to handle it` immediately followed by `delivered into the
running turn`.

The fix is crew's: consume the turn once. A child is added to a `reported` set when
its report is claimed, and further events are ignored until the child emits
`turn_start` again — which means genuinely new work (a follow-up the parent sent, a
rerun) and correctly reports a second time. `settling` guards the same way while a
retry loop is in flight, so three events cannot start three loops.

### Cohorts

Every thread spawned since the parent's last user message shares a
`Session.delegationRunId`. That turns a fan-out into a group rather than N unrelated
pings, and lets the report block say **"1 of 3 threads from this batch have
reported; 2 still running — do not summarize the batch as done yet."** Without it an
agent receiving the first of five reports has no way to know four more are coming,
and confidently tells you the work is finished.

The cohort is stamped at spawn (`spawnCohort`), because at report time there is no
way to reconstruct which request a thread belonged to. A batch spanning two runs, or
containing a thread with no run id, reports without cohort framing rather than
guessing.

### The autonomous wake budget

Waking an idle parent is the same capability crew's supervisor loop has, and it
carries the same risk, so it carries the same brake.

Crew can wake safely because it is a **bounded run**: a tab you explicitly launched,
a lifecycle (`configuring → provisioning → active → archiving → closed`), an idle
watchdog, and `MAX_SUPERVISOR_ROUNDS = 4` with an explicit "auto-advance paused
after 4 rounds — send a message to continue."

Solo-chat delegation has none of that. It is an ordinary chat with no run that ends,
so a parent that answers a report by spawning another thread would chain
indefinitely with nobody watching, and the delegation rate limiter only caps
creates *per minute*, not in total.

So `MAX_AUTONOMOUS_WAKES = 4` is crew's round budget under another name — but it
counts **recursion, not volume**:

- **A fan-out you asked for is free, however wide.** Spawning six workers from a
  turn you drove and having all six report is one wake costing nothing. That is the
  feature working; flat counting would penalize exactly the case people delegate
  for.
- **A wake caused by threads an autonomous turn spawned costs one.** `Session.
  delegatedDuringWake` is stamped at spawn while the parent is mid-autonomous-turn,
  so each generation of "report → spawn → report" costs a unit. That is the only
  shape that actually runs away.
- Scoped per parent, refilled **only** by a real user message — an auto-wake goes
  straight to the bridge and never reaches the send path, so it cannot refill its
  own budget or fold its spawns into the previous request's cohort.
- Not persisted. A restart means you are back, so the budget starts fresh.
- Follow-ups into a running turn never spend it: you are already watching that work.
- When spent, the batch buffers and the transcript says `auto-wake paused after 4
  autonomous rounds — send a message to continue` — deliberately crew's wording,
  because it is the same mechanism.

### The idle watchdog

A bridge can die without emitting `turn_end`. Crew hit this hard enough to need both
an idle watchdog and a transcript-stability poller; the same bridges back delegated
threads, so the same failure applies. Without a watchdog a hung thread is
indistinguishable from one still working — it sits "running" in your drawer forever
and its parent waits on a report that will never come.

`shouldAbandonThread` (pure, mirroring crew's `shouldAbandonRound`) fires only when
a thread is **still running, has no tool open, and has emitted nothing for
`THREAD_IDLE_TIMEOUT_MS`** (3 minutes, crew's window). The tool gate matters: a
single long tool call emits nothing between `tool_start` and `tool_end`, so elapsed
time alone would abandon a thread that is working perfectly. Liveness rides on
`subscribeActivity`, the same heartbeat crew's watchdog uses, with
`nextToolsInFlight` reused directly.

An abandoned thread is **reported, not acted on**: the parent gets a failed report
saying the thread is presumed stuck and was *not* closed, so it can nudge it, open
it, or carry on. CrewCode never closes or archives on the thread's behalf. Each hang
reports exactly once, and a thread that later reports normally stops being a
watchdog candidate.

Controlled by **Settings → General → "Wake chat on delegated report"**, on by
default. Off, everything buffers.

### Waking has to revive the bridge

Idle bridges are reclaimed after 10 minutes, and the long jobs actually worth waking
for are exactly the ones that outlive that. So a wake calls `ensureBridgeForSession`
when `getBridgeId` returns null, restarting the parent's agent (resuming its native
session) rather than silently failing to wake. If the bridge cannot be started —
non-bridge transport, missing workspace — it buffers instead.

### A woken agent is talking to nobody

An auto-started turn has no user on the other end. An agent that does not know that
ends the turn with a question nobody will answer, and the work stalls. Both the
session preamble and the `woke` variant of the report block say so explicitly: the
user is not present, act on the report, keep it short, do not ask them anything.

### The one accepted race

Liveness is read synchronously and dispatched in the same block, so nothing in the
*renderer* can race it — but a parent whose turn ended in main microseconds earlier
can still take a follow-up as a fresh turn. That is a millisecond window, and the
content is what it was about to be told anyway.

### Bounds

A report rides in the parent's context, so it is a token bill:

- 1,600 chars per reply, then `[truncated]` with a pointer to `GET /v1/threads/:id`.
- 12 buffered reports per parent, newest kept — a runaway spawner drops stale
  reports rather than growing one prompt without bound.
- Drained exactly once, at wire-text assembly. A report is dropped from the buffer
  even if the send then fails to start a bridge; it is still in the transcript.
- Framed as `<system>`, never as user text, so the agent does not answer the
  worker's words as though you had typed them.

### Worktree children live in the parent's tab

A write-capable child forks its own worktree but stays in the parent's **tab**.
CrewCode's active worktree is per *workspace* (`activeWorktreeIds[wsId]`), so giving
the child its own tab would not have isolated it anyway — and switching the
workspace's active worktree would move the parent's cwd too.

Instead, cwd is resolved per send from `session.delegatedWorktreePath`, so the
child's bridge runs in the isolated checkout while nothing about the workspace's
selection changes.

**Known limitation:** the surrounding UI panels (editor, git sidebar, terminal)
follow the workspace's active worktree, not the delegated session's. Opening a
write-capable delegated thread shows the *parent's* worktree in those panels even
though the agent is working elsewhere. The row's `wt` chip names the real branch.
Making those panels session-aware is a larger change than this feature needed.

### Rate limiting

The concurrency cap bounds *open threads*. It does nothing about an agent looping
create/close, or hammering a read route. A fixed 60s window per session adds
12 creates and 240 requests; both answer `429` naming the retry delay. The window
resets rather than sliding — simpler to explain in an error message than a decaying
budget.

## Drawer

`splitDelegatedSessions` (in `delegated-session-split.ts`, pure and unit-tested)
partitions the selected workspace's sessions. Workspace rows stay grouped at the
top of the drawer instead of expanding inline. After the global activity
sections, the user's own threads render in the selected workspace's **Threads**
section; delegated threads render below in a collapsible **delegated** section
using the existing `sectionClosed` map in `WorkspacesDrawer.tsx`, sorted
newest-first by `delegatedAt`.

Rows missing `delegatedAt` sort last in stable order — a legacy or malformed row
must not displace the thread you are actually waiting on.

The section header names the parent when every thread in the group came from the
same one (`delegated · Bridge work`), which is the common case of a single turn
fanning out, and stays generic for a mixed group.

Styling is `--delegated-surface` / `--delegated-surface-hover` /
`--delegated-border` in `colors_and_type.css`: the existing evergreen accent at low
alpha, per theme. No second accent colour, no shadows. An active delegated row
falls back to the normal `.sess.on` treatment so selection still reads clearly.
Write-capable children also show a `wt` chip carrying their branch name, so an
isolated worktree is never invisible in the list.

Delegated rows use the same activation, pin, rename, and delete paths as any
other session — they are ordinary `Session`s, only visually set apart. Pinned
delegated rows sort first within the delegated section rather than moving into
the normal Threads list, preserving provenance. The "new chat" `+` affordance
is deliberately absent from the delegated section: you don't hand-create a
delegated thread.

Empty section renders nothing. A delegated thread you continue yourself keeps its
`origin` — it stays in the section; provenance is history, not current ownership.

## Context injection

When a session has delegation enabled, the send path appends a short block
alongside `buildModePreamble`: endpoint, token, session header, the route table, and
the constraints (shared worktree, no nested delegation, cap on concurrent threads).
Roughly 200 tokens. Sessions with delegation disabled pay nothing and get no token.

Delivery is session-scoped and one-shot, same as mode preambles and skill bodies —
mark it delivered so it is not re-sent every turn.

## Settings

Delegation is toggled **per solo chat**, not globally: `Session.delegationEnabled`.
Only that chat's agent receives credentials and the preamble, so unrelated threads
pay neither the token nor the ~200 tokens of context.

Under General:

- **Max concurrent delegated threads** — default 4.
- **Allow Full Access in delegated threads** — off by default.

## Risks accepted

- **Read-only threads still share a worktree.** They cannot write, but they can run
  commands, and a test run that mutates state (writes fixtures, touches a local db,
  rebuilds `out/`) will be visible to the parent. Acceptable; isolating every read
  would cost a worktree per question.
- **Cost.** Each delegated thread is a full model context with no shared cache, and
  write-capable ones add a worktree plus possibly a dependency install.
- **Worktree sprawl.** Threads do not clean up after themselves by design, so
  abandoned delegated branches accumulate until you remove them.
- **Token in transcripts.** Injected credentials persist to disk in the transcript.
  Mitigated by per-launch rotation and loopback-only binding.

## Implementation order

1. `src/main/delegation-service.ts` — server, token, loopback bind, route table,
   IPC marshalling. Pure route/validation logic split into
   `delegation-routes.ts` so Vitest can load it without Electron.
2. `Session` fields + drawer section + CSS token.
3. `useDelegatedThreads` + non-activating session create. Read-only spawns only —
   ships a complete, useful feature on its own.
4. Context injection + settings + provider discovery: `GET /v1/providers`,
   `agentId`/`model` validation against the live registry, and the provider list in
   the injected context.
5. Focus navigation.
6. Write-capable spawns: worktree strategy, branch naming, `addWorktree` wiring,
   uninstalled-deps reporting, cleanup rules.
7. Merge flow: diff, sequential rebase-then-fast-forward in the child worktree,
   conflict reporting, no auto-merge.
8. Caps, rate limit, remote denial.

## Tests

- `delegation-routes.test.ts` — auth rejection, non-loopback refusal, mode cap,
  concurrency cap, remote denial, malformed bodies, and the mode-to-isolation
  mapping (`ask`/`plan` share, `build`/`full` isolate).
- Provider validation — unknown provider, known-but-unavailable provider, unknown
  model for a valid provider, and that each rejection names the valid options.
- `useDelegatedThreads` — create does not steal focus, cross-workspace focus uses
  the workspace-scoped setter.
- `useDelegatedThreads.close.test.ts` — close marks done and **never** archives, is
  idempotent, reopens on a new message; a done thread is still focusable while an
  archived one is refused with an error naming the user.
- `useDelegationReports.test.ts` — coalescing (a fan-out is one wake, one transcript
  row, and cannot fire concurrent prompts at one bridge); cohort framing for partial
  and complete batches; the watchdog (reports a silent thread, spares one inside a
  long tool call, reports a hang once, stops watching a thread that reported); wake
  on/off; bridge revival and every buffer fallback; and the budget — free for a
  six-wide user-driven fan-out, charged for recursion, paused at 4, refilled only by
  a user message, never spent by follow-ups.
- `delegation-wake-policy` is pure: `shouldAbandonThread` and `wakeCost` are the two
  calls worth testing without refs, timers, or a live bridge.
- `delegation-report.test.ts` — reply bounding, error-row fallback, `<system>`
  framing, and quote neutralization in agent-supplied titles.
- `delegation-inbox-store.test.ts` — per-parent isolation, drain-exactly-once, and
  the 12-report cap dropping oldest.
- Drawer — delegated rows group separately and survive collapse state.
- Merge — conflicts return 409 with paths and leave the base branch untouched; a
  failed merge stops the sequence instead of proceeding to the next child.

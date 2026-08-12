# Execution Custody

> Scope: interactive halt-and-reauthorize custody is enabled for synthetic crew lane threads only. Ordinary solo chats and the crew supervisor use their normal provider error/retry behavior and do not receive custody-loss banners or gates.

> Status: living document. `docs/security-model.md` covers **granting** authority —
> whether it may cross the next boundary. This document covers **withdrawing** it:
> what happens when authority that was already granted stops being knowable while
> execution is still in flight.

## The gap this closes

An admission-control model asks one question, repeatedly: *may this action cross
this boundary?* It is stateless and it is correct, but it only ever runs when
something asks. That leaves a class of failure invisible to it.

Agent runs are long-lived. CrewCode authorizes at T=0, then a provider process
executes for minutes. If the world changes underneath that grant — the process
dies mid-tool-call, the workspace root disappears, the mode is flipped, CrewCode
itself restarts — a gate-only model notices nothing. It is not that an attacker
got in. It is that **the system no longer knows whether its previously granted
authority is still lawful, and continued anyway.**

The seed of the fix was already in `crew-merge-journal.ts`: an integration found
`running` after a restart becomes `interrupted`, never inferred successful. This
document generalizes that principle across the agent layer.

## Doctrine

The rules below are binding on every current and future privileged surface in
CrewCode. They are restated in `AGENTS.md` so they constrain new work by default.

When **authority, identity, scope, provenance, or execution custody** becomes
unknown, stale, contradictory, or changes unexpectedly:

1. **Refuse** new privileged actions on the affected scope.
2. **Contain** or terminate owned execution where it is safe to do so.
3. **Preserve** the evidence and the current workspace state.
4. **Report** the exact failed invariant and the exact affected scope.
5. **Require** explicit human reauthorization before resuming.

And, without exception:

```
silence               != success
timeout               != success
lost telemetry        != success
missing process state != success
clean Git state       != behavioral correctness
```

An outcome that was never observed is recorded as **unknown**. It is never
back-filled by inference, and never by absence of a complaint.

## The invariants

Defined in `src/shared/custody-types.ts`, detected in
`src/main/agents/custody-invariants.ts`.

| Invariant | Trips when | Halts? |
| --- | --- | --- |
| `restart-recovery` | A custody record is still `running` at next launch — CrewCode stopped mid-turn | yes |
| `execution-custody-lost` | The provider process emitted `closed`/`error` while a turn was in flight, and the user did not ask for it | yes |
| `authority-drift` | Live authority no longer matches the authority recorded for the execution | yes |
| `scope-unknown` | The local workspace root the grant was scoped to no longer exists | yes |
| `orphaned-authorization` | A permission request outlived the bridge that asked for it | no — cancelled and reported |

`orphaned-authorization` does not halt on purpose. The state is fully *known*:
the process is gone, so the request can never be acted on. It is cancelled
explicitly and the card is dismissed. A halt is reserved for state that is
genuinely **unknown**, which is what a human is needed to resolve.

### What counts as "authority"

The tuple a grant is scoped to (`CustodyAuthority`):

```
provider · cwd · mode · toolPolicy · externalDirectories · mcpServers
```

Collections are sorted, so reordering configuration is not misread as drift.
Any divergence between this tuple and the one recorded in the journal — arrived
at by any path other than a sanctioned, journalled mutation — is drift.

## The custody journal

`src/main/agents/custody-journal.ts`, persisted to
`<userData>/agent-custody-journal.json` (mode `0600`, atomic temp-file rename).

One record per bridge execution:

```
running     a turn is in flight right now
idle        bridge alive, no turn in flight
ended       stopped cleanly, no turn was in flight
interrupted a turn was in flight and its outcome was never observed   [GATES]
halted      an invariant tripped mid-session                          [GATES]
```

`interrupted` and `halted` **both** refuse privileged actions until reauthorized.
They are separate words because the causes differ — `interrupted` means CrewCode
itself stopped while a turn ran; `halted` means an invariant tripped while it was
running — but they carry identical authority. `activeHalt`, `haltedRecord`, and
`reauthorize` all gate on both; a check that forgets one is a hole, and
`custody-journal.test.ts` pins the behaviour for each status independently of its
name.

**Recovery on construction** is the heart of it, and mirrors `CrewMergeJournal`:

- `running` → `interrupted` with a `restart-recovery` violation. The turn's
  effects on the workspace were not observed and are not assumed complete.
- `idle` → `ended`. An idle bridge's process being gone after a restart is
  *known* state, so it needs no human gate.

### Evidence must be on disk before the crash, not after

The record is marked `running` at **prompt time**, not at `turn_start`, and the
prompt text is persisted to `activePrompt` in the same write. This closes a real
window: the in-memory turn map (`promptTextByTurn`) dies with the process, so a
crash between sending a prompt and the provider's first event would otherwise
leave a record that looks `idle` — recovered as `ended`, with the prompt gone and
nothing to show the user. Recovery promotes `activePrompt` into
`interruptedPrompt`.

A provider rejection observed *before* `turn_start` is known state, so it rolls
the record back to `idle` rather than leaving a synthetic `running` record that
would become a false restart halt on next launch.

### Bounded audit trail

Every violation is appended to `violations` on the record (capped at 20).
`recordViolation` exists for the non-halting case: an `orphaned-authorization` is
cancelled rather than halted, but it is still written down. A tripped invariant
that left no trace would defeat the point.

### Halts are keyed to the thread, not the bridge

`bridgeId` embeds a timestamp (`br-<tab>-<agent>-<base36 now>`) and is minted
fresh on every start. A bridge-scoped halt would evaporate on exactly the restart
that raised it. Halts are therefore keyed by `sessionKey` (`"tabId:agentId"`),
falling back to `bridge:<id>` when a thread key is unavailable — that fallback
halt does not survive the process, which is stated here rather than hidden.

## Lifecycle

```
admit -> authorize -> execute -> observe
                                   |
                          invariant violated
                                   |
                    refuse -> contain -> preserve -> report
                                   |
                       explicit human reauthorization
                                   |
                                 resume
```

Reauthorization stamps `reauthorizedAt` on the halted record. **The record is
never deleted.** Resuming work must not erase the evidence of why it stopped.

## Authority mutation while a turn is running

A mode change requested mid-turn is **refused and deferred to the next turn**.
It is not applied, and it is not treated as a violation.

The reasoning: the mode segment sits in the composer and users click it casually.
Halting a turn on a normal UI action would make failing loudly indistinguishable
from failing annoyingly. But letting a `build → full` flip land underneath a turn
that is already executing is precisely the escalation this system exists to
forbid. Deferral refuses the escalation *and* honours the user's choice — the
refusal is the enforcement, and the turn keeps running under exactly the
authority it started with.

De-escalation (`full → plan`) is deferred too. Applying it mid-flight would mean
a running tool call and its own permission gate disagree about what is allowed,
which is a contradiction, not a safety improvement.

Sanctioned mutations write the new authority into the journal. That is what makes
the drift check meaningful: a change through the approved path is recorded, and
anything else is, by definition, unexplained.

## Where the tripwire runs

**Desktop bridge coordinator** (`src/main/agents/index.ts`) — full coverage.

- `bridge:start` **refuses outright** when a halt is still in force for the
  thread, and returns the halt in its result. Two reasons it is not an event:
  spawning the process and then refusing its prompts would leave an orphaned
  provider running under a grant nobody can vouch for; and the renderer's
  `bridgeId → tab` routing table is only populated on its next render, so an
  event sent at start could be dropped — a dropped halt being exactly the silent
  failure this system exists to prevent. Runtime halts (raised mid-session) *are*
  events, because by then routing is established.
- `bridge:start` otherwise opens a custody record for the execution. That record
  is the authority of record from then on.
- `turn_start` marks the record `running` and lands any deferred mode change.
- `turn_end` — and only `turn_end` — closes a running record.
- `closed`/`error` while running, and not user-initiated, trips
  `execution-custody-lost`.
- `bridge:prompt`, `bridge:respondUserRequest`, `bridge:compact`,
  `bridge:removeFollowUp`, `bridge:setMode` are gated. Each re-checks
  `scope-unknown` and `authority-drift` at the moment of the action rather than
  one action later.
- The `requestUser` path is gated too, as `authorize`, **before** a turn-scoped
  auto-approval is even prepared. Otherwise a live Full Access grant could
  approve a tool call after the scope it was granted against had disappeared —
  the gate has to sit in front of the auto-response, not behind it. A refused
  request resolves as `decline`.
- `bridge:abort`, `bridge:stop`, and the system monitor's stop control mark the
  exit user-initiated, so a stop the user asked for is known state.
- `bridge:reauthorize` is the only exit from a halt.
- `bridge:custodyState` is read-only and **never** gated by a halt. A halt must
  not hide the evidence it was raised to preserve. The chat pane reads it when a
  thread is opened, so a halt recovered from the journal appears immediately
  rather than waiting for the user to try to send something into it.

**Remote-access transport** (`src/main/agents/bridge-service.ts`) — partial.
Mid-turn mode changes are refused and deferred, and orphaned permission requests
are cancelled on close/abort/stop. It does **not** yet persist custody records or
implement the halt/reauthorize lifecycle. Stated plainly rather than implied.

**Not yet covered:** terminal (PTY) panes, plugin capability sessions, and SSH
host-key changes during a live session. Crew merges have their own equivalent
journal (`docs/behavioral-merge-review.md`).

## Evidence preservation

Before this existed, the local transcript only saved on `turn_end`. A bridge
dying mid-turn dropped the user's prompt entirely — on resume the thread looked
like the turn never happened. Losing the evidence is the failure; the
interruption is just an event.

`preserveInterruptedTurn` now writes the prompt and whatever partial response
arrived into conversation history, appended with an explicit marker:

> `[CrewCode: this turn was interrupted — <exact failed invariant>. The response
> above is incomplete, and whatever it had already done to the workspace was not
> observed.]`

The same evidence is stored on the halted journal record and shown in the halt
banner. A resumed agent reads the honest version of what happened, and so does
the user.

## User-facing behaviour

`CustodyHaltBanner` (`src/renderer/src/components/chat/CustodyHaltBanner.tsx`)
renders above the composer and states:

- the failed invariant, by name and by id;
- the affected scope — provider, workspace root, turn id;
- that nothing about the interrupted turn is assumed to have completed;
- the preserved evidence, on request;
- a single explicit **Reauthorize this thread** action.

The halt lives in `bridge-activity-store` and is deliberately **not** cleared by
bridge teardown — it outlives the process that raised it. Only a confirmed
`bridge:reauthorize` removes it; a failed call leaves the banner standing rather
than letting the UI imply the thread is authorized again.

Two related honesty fixes ship with it: a bridge that exits mid-turn now settles
its streaming message bubbles (the spinner used to keep running on a dead
process, so silence read as work in progress), and permission cards belonging to
a dead bridge are explicitly dismissed instead of being left to look live.

## Verify

```bash
npx vitest run src/main/agents/custody-invariants.test.ts \
               src/main/agents/custody-journal.test.ts \
               src/main/agents/custody.test.ts

# Group F of the boundary proof covers the withdraw-authority lifecycle.
npx vitest run src/main/security-boundary-proof.test.ts
```

## Known limits

- A halt is per-thread. Two threads in the same workspace are halted
  independently, even though they share a working tree.
- `scope-unknown` is not asserted for `ssh://` roots. A stat would be a network
  round trip on every privileged action, and their real boundary is the pinned
  host key at connect time.
- Detection is at action boundaries and lifecycle events, not continuous. A
  workspace root deleted mid-turn is caught at the next privileged action, not
  the instant it happens.
- This bounds what CrewCode can *know* and how it behaves once it stops knowing.
  It does not make an interrupted turn's partial writes disappear — it makes sure
  you are told about them instead of inheriting them silently.

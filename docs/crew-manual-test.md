# Crew Orchestrator — Manual Test Guide

How to manually verify the **supervisor ↔ worker back-and-forth** in the running
app. The automated tests (`src/renderer/src/hooks/useCrewSupervisor.test.ts`)
prove the coordination *logic* against fake bridges; this guide verifies the
*live* loop with real agent processes.

> See [crew-orchestrator.md](./crew-orchestrator.md) for the architecture and
> [CREWCODE-MULTI-AGENT.md](./CREWCODE-MULTI-AGENT.md) for the feature overview.

## Prerequisite: know which agents can reply

The supervisor is a **bridge** agent that moderates the crew as a group chat. A
worker's reply only flows back into the supervisor thread if that worker is also
a **bridge** agent. Registry from `src/main/index.ts`:

| Agent      | Transport | Replies back to supervisor? |
| ---------- | --------- | --------------------------- |
| **pi**     | bridge    | ✅ yes                       |
| **opencode** | bridge  | ✅ yes                       |
| **codex**  | bridge    | ✅ yes                       |
| **hermes** | bridge    | ✅ yes                       |
| **CrewCoder** | bridge | ✅ yes                       |
| **claude** | bridge       | ✅ yes  |

**Rule:** to see the full round trip, every worker lane must be a bridge agent.

Each chosen agent's binary must be installed and on `PATH` so the registry marks
it `available`. A missing binary surfaces as
`supervisor agent "<id>" is unavailable or not a bridge agent` in the supervisor
thread, and nothing dispatches.

## Happy-path round trip

### 1. Launch

```bash
npm run dev
```

### 2. Start a crew

- Open a workspace and start a crew. Crew opens in its own standalone tab; starting another crew should create another independent Crew tab instead of replacing a solo chat tab.
- **Mode: shared** — simplest first run (no worktrees to provision, so git is not
  a variable). Switch to isolated once the loop is confirmed.
- Add **two worker lanes**, both bridge agents — e.g. lane-1 = `pi`,
  lane-2 = `opencode`.
- Leave **Supervisor enabled** (default agent `pi`).
- Launch.
- In Crew Surface, verify each lane's selected model has a `use`/`skip` switch.
  Leave both set to `use` for the full round-trip test.

### 3. Send a prompt that *forces* delegation

This matters: the supervisor is instructed to answer pure status questions from
its own snapshot **without** delegating, so "what's the status?" will not
exercise the loop. Ask something only the workers can answer, addressed to
everyone:

> Have **each** worker independently inspect this repo and report back: the
> top-level files they see, and the one thing they'd refactor first. Then
> summarize both answers for me.

### 4. What you should see (the proof)

In the **supervisor thread**, in order:

1. Supervisor status → `thinking`, then `delegating`.
2. A system breadcrumb: `→ tasked lane-1 (pi), lane-2 (opencode) · round 1/4`.
3. Each **worker thread** receives the task (switch tabs to confirm they run).
4. Each reply lands back in the supervisor thread as a **labeled incoming
   bubble**: `lane-1 · pi`, `lane-2 · opencode`.
5. Once **both** replies are in, the supervisor is re-prompted automatically and
   posts a **synthesized summary** referencing both workers' findings.

✅ **Pass criterion:** step 5 produces a summary that references *both* workers.
That exercises the entire delegate → wait-for-all → synthesize loop.

### Run-selection toggle

Set one lane's model switch to `skip`, then ask the supervisor to delegate to
`all`. The breadcrumb should name only the enabled lane, and the skipped lane
should not appear in supervisor run-selection/status context at all. Direct lane
sends and shared-mode broadcasts should also ignore skipped models until the
switch is set back to `use`.

## Edge behaviors (each confirms a safety path)

### Missed-delegation nudge

Ask something vague: *"maybe loop in a worker on the auth code."* If the model
describes delegating in prose without emitting a fenced block, you get a one-time
system line `no ```crew-delegate``` block detected…` and the supervisor
re-prompts itself. Confirms the nudge fires exactly once per user turn.

### Terminal worker

Add a `claude` lane and delegate to all. You should see
`lane-X is a terminal worker — its reply won't appear here`, and the supervisor
does **not** hang waiting on it. Confirms the pty gate.

### Abort

During a live round, hit stop. Expect
`orchestration stopped — send a message to resume.` and the in-flight turn
aborts without kicking off a new round. The next message resumes cleanly.

### Round cap

Keep a back-and-forth going (workers that keep prompting more delegation). After
`MAX_SUPERVISOR_ROUNDS` (4) auto-advances, expect
`auto-advance paused after 4 rounds — send a message to continue.` This prevents
runaway loops.

### Idle watchdog

If a bridge worker goes fully silent (no text/thinking/tool events) for ~3
minutes mid-turn, expect `lane-X went silent for 3m — continuing without it.` and
the round advances rather than hanging forever. (A worker grinding on a long tool
call keeps emitting events, so it is *not* abandoned — the watchdog only fires on
a genuinely dark turn.)

## If it doesn't work — get the real error first

1. **Supervisor thread system messages** — bridge spawn/prompt failures post
   there in red (e.g. unavailable agent, prompt failed).
2. **DevTools console** (Electron window) — watch the bridge event stream. A
   worker that never emits `turn_end` is why a round would stall; the idle
   watchdog will eventually abandon it and post `went silent`.

## Queued follow-up while running

Verify the solo-chat follow-up queue before or after the crew checks:

- Start a bridge-backed chat run and wait until the agent is clearly streaming.
- Type a second message while the run is still active and hit the normal send shortcut/button.
- Expected: the current run does **not** stop, the composer clears, and the follow-up appears as the next user message in the transcript.
- Expected: if the composer still has text while running, the primary action reads `Queue` and a separate `Stop` action remains available.
- The follow-up should be submitted immediately with provider follow-up behavior; Pi must not show `Agent is already processing`.
- Queue more than one follow-up and confirm the provider injects them at safe points in order.

## Isolated-mode follow-up

Once shared mode passes, repeat in a **git workspace** with **isolated** mode to
verify worktree provisioning:

- On launch, each lane should get its own `crew/<tag>/<agent>-<n>` branch and a
  worktree directory (visible in the lane's path).
- On archive/close, the worktrees are torn down after agents are released (no
  orphaned processes writing into a deleted directory).
- The git lifecycle itself is covered by `useCrewSession.test.ts`; this just
  confirms the IPC wiring end to end.

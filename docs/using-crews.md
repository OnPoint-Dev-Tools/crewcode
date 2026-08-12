# Crews — running multiple agents at once

A crew is CrewCode's multi-agent surface: several AI coding agents working the
same project in parallel, each in its own lane, optionally moderated by a
supervisor agent. A crew opens in its own standalone tab — you can run more
than one crew, even on the same workspace.

## Starting a crew

Open a workspace and start a crew (command palette → **Start Crew Workers**, or
the chat header action). The configuration panel opens first:

- **Crew name** — names the tab and, in isolated mode, tags the branches.
- **Workspace mode**:
  - **isolated** — every agent gets its **own git worktree and branch**
    (`crew/<tag>/<agent>-<n>`), forked from your current branch. Agents cannot
    step on each other's edits; you review and merge each lane's branch
    afterwards.
  - **shared** — all agents work on **one branch and one set of files**.
    Simplest setup, but concurrent edits can collide; best for
    read/analysis-heavy tasks or small crews.
- **Task guide** — an optional helper that suggests a mode based on the shape
  of your task.
- **Supervisor** — on/off, plus its agent and model. Supervisor agents must be
  bridge providers.
- **Lanes** — add worker lanes; per lane pick the agent, model, reasoning
  effort, and an optional **role** (a persona/instruction preset).
- **Templates** — save a crew configuration and re-apply it later.

Launch provisions worktrees (isolated mode) and starts the lanes.

## The crew surface

- **Lane columns** — one per worker: its own thread, composer, model/effort
  buttons, and a **use / skip** switch. A skipped lane stays visible but is
  excluded from supervisor delegation, broadcasts, and automated fan-out until
  you flip it back.
- **Timeline** — the shared view of each round. Lane groups collapse so dense
  multi-agent rounds stay scannable. In split distribution, each lane card
  shows that lane's own prompt.
- **Supervisor sidebar** — the supervisor's thread (resizable). Delegation
  breadcrumbs (`→ tasked lane-1 … · round 1/4`), incoming labeled worker
  replies, and the synthesized summaries land here.
- **Git sidebar** — per-lane branch status and diffs in isolated mode, so you
  can review each agent's work before merging.

## Task distribution: split vs broadcast

A live header toggle, separate from workspace mode — you can flip it mid-run:

- **split** (default) — each worker gets a **distinct sub-task**. The
  supervisor is required to target lanes individually; duplicate task text and
  "send to all" delegations are blocked.
- **broadcast** — every worker gets the **same message**, useful for
  compare-the-answers runs.

Without a supervisor in shared mode, each worker gets its own composer in the
timeline — you address lanes directly. Lane composers support `@` file search
against that lane's effective workspace (its isolated worktree, or the shared
base path). Their textareas grow with multi-line assignments up to a bounded
height, then scroll instead of staying fixed at one line or taking over the lane.

## How the supervisor works

The supervisor moderates the crew like a group chat, and is deliberately
constrained:

- **Read-only** — supervisor agents cannot write files or run commands. They
  plan, delegate, and synthesize; workers do the work.
- **Incremental reporting** — each worker's reply is fed back to the supervisor
  as soon as that worker finishes. Fast workers are reported immediately
  instead of waiting for the slowest lane.
- **Round budget** — automatic re-delegation pauses after 4 rounds
  (`auto-advance paused — send a message to continue.`). Prevents runaway
  loops; sending a message resumes.
- **Idle watchdog** — a worker that goes completely silent mid-turn for ~3
  minutes is abandoned for that round (`lane-X went silent — continuing
  without it.`) instead of hanging the crew. A worker that is still emitting
  events (long tool calls) is never abandoned.
- Pure status questions are answered from the supervisor's own snapshot without
  waking workers.

> [!NOTE]
> Only **bridge** agents can report replies back to the supervisor. A
> terminal-transport lane still receives tasks, but you'll see
> `lane-X is a terminal worker — its reply won't appear here`, and the
> supervisor won't wait on it.

## Stopping things

Stop controls are scoped on purpose:

| Control | Effect |
| --- | --- |
| **stop all** (crew header) | aborts every runtime in the crew |
| Supervisor composer stop | aborts only the supervisor's turn |
| Lane composer stop | stops only that runtime; its next prompt respawns it |
| Lane **enabled / paused** switch | stops that runtime and excludes the lane from delegation while retaining its worktree, transcript, and editable **next action** checkpoint |

Each assignment automatically seeds the lane's next-action checkpoint. You can
edit it before switching attention. Pause/resume state and the checkpoint are
stored with the crew session, so restart recovery keeps the handoff while
honestly restoring the runtime itself as stopped. Resuming never auto-sends the
checkpoint; the operator or supervisor decides when to continue.

After a stop, sending a message resumes orchestration cleanly.

## Finishing up

In isolated mode, review lane ownership and collision signals in Cross-lane
Diff, then use the merge sidebar to verify all selected lane commits together
before applying the exact checked integration. Archive the crew afterward;
worktrees are torn down only after agents are released. In shared mode the work
is already on your branch; review the diff and commit as usual.

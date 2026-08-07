1. Overview — what the Multi-Agent Workspace Orchestrator is: running a crew of agents

  either in independent worktrees or one shared workspace, configured from the chat

    interface.
  2. The two modes — a side-by-side of isolated ("Multiple Workspaces" — own worktree +
  
    anch per agent) vs shared ("Single Workspace" — one branch, concurrent agents), with
  
    e tradeoffs (notably the shared-mode concurrent-edit risk).
  3. Architecture / layering — the deliberate split:
    - orchestrator/crew-session.ts — pure state machine (no React, no IPC)
    - orchestrator/decision-guide.ts — task-shape → mode data
    - hooks/useCrewSession.ts — effectful layer, keyed by standalone crew tab so one workspace can run multiple crew sessions
    - components/crew/* — UI
    - How it drives the existing worktree:* IPC rather than re-implementing git.
  4. State machine — the lifecycle diagram (configuring → provisioning → active →
  
    chiving → closed, plus error), lane statuses, and the CrewSession / CrewAgentLane 
  
    apes.
  5. CrewGitDriver contract — the injected boundary, why it exists (testability), and how
  
    pp wires it.
  6. Decision guide — the five task shapes and their recommendations.
  7. Registry — crewRoster / the roster selector: which agent runs in which directory +
  
    anch.
  7a. Crew Surface run selection — each selected lane model has a `use`/`skip`

    switch. Supervisor delegation, shared broadcasts, and direct lane sends only

    execute enabled (`use`) models; skipped models stay visible in the UI but are

    omitted from supervisor prompts/status context and excluded from the current

    run.
  7b. Task distribution (`session.distribution`: `split` | `broadcast`, default

    `split`) — a live header toggle in `crew-surface-head` controlling how a crew

    message reaches workers:
    - `split` (default): each worker gets a DISTINCT sub-task. With a supervisor,
      `distributionDirective()` is injected into every run-selection snapshot and
      tells the supervisor to emit exactly one distinct assignment for every
      enabled worker in the same turn before waiting for replies. Runtime
      dispatch is two-phase and fire-and-track: CrewCode starts/binds every
      targeted worker runtime first, then submits all prompts without awaiting
      any worker's full turn, so a slow Claude/OpenCode/etc. turn cannot delay
      another worker from starting. Only the supervisor bridge is serialized
      when synthesizing worker replies.
      `validateDirectivePolicy()` hard-blocks incomplete coverage, `"to":"all"`,
      targets that resolve to multiple workers, unavailable/skipped targets, and
      exact duplicate task text before any worker receives a message. On a
      violation CrewCode rejects the whole supervisor turn, tasks no workers, and
      asks the supervisor for corrected complete directives. Without a supervisor,
      the shared-mode timeline
      (`CrewTimeline`) renders one composer per worker so the user types each
      task manually; split timeline rounds show each lane's own prompt in that
      lane card instead of one shared round prompt. Isolated mode already has
      per-lane composers.
    - `broadcast`: the same message fans out to every worker (`handleBroadcast`),
      and the supervisor is told it may use `"to":"all"`; the hard split gates
      do not apply.
    - The toggle dispatches `set_distribution`, which — unlike `set_mode` — is
      legal at any lifecycle phase, so it can be flipped mid-run and takes effect
      on the next prompt.

  7c. Supervisor guardrails — supervisor bridge sessions start with

    `toolPolicy: 'read-only'` and Ask-mode behavior so they can inspect/read for
    planning but cannot write files or run write/exec tools through supported
    bridge providers. The supervisor can only reach enabled lanes through parsed
    `crew-delegate` fences; prose-only delegation is corrected with a hidden
    nudge, while invalid directive targets are reported as system errors. The
    parser accepts common markdown drift (` ```crew-delegate`, ` ``` crew-delegate`,
    indented fences, CRLF, and 3+ backticks) so valid follow-up delegations do not
    get mistaken for prose-only delegation. Supervisor bridge questions/approval
    prompts render the same agent activity card as solo chat, above the supervisor
    composer. The supervisor thread shows a scroll-to-bottom button when the
    latest messages are off-screen.

  7d. Crew controls — the supervisor sidebar is horizontally resizable so users

    can balance the group chat against worker lanes. Shared timeline lane groups
    are collapsible with chevrons so dense rounds can be scanned without losing
    the lane header/status. Stop controls are scoped: the header `stop all`
    aborts every runtime, the supervisor composer stop button aborts only the
    supervisor loop, and lane composer stop buttons stop only that lane so the
    next prompt respawns it.

  7e. Supervisor reporting cadence — worker replies are fed back incrementally,

    not batched. `useCrewSupervisor.feedSupervisor()` nudges the supervisor the
    moment a worker finishes (gated by a `busy` flag: replies arriving during an
    in-flight supervisor turn buffer and drain on its `turn_end`). Before a lane
    is reported, CrewCode briefly waits for final stream/store settling and then
    extracts the full lane response since the latest worker task, including
    multi-bubble text, no-turn-id agent output, and worker error messages. This avoids `(no textual reply)` when the worker visibly
    produced a report and keeps manual status checks consistent with the lane
    transcript. A transcript-stability poller also recovers if a bridge `turn_end`
    event is missed or fails to match the awaited lane tab: once the lane shows a
    stable non-streaming report, CrewCode relays it to the supervisor anyway.
    While workers are already awaited, prose-only supervisor status turns do not
    trigger the missed-delegation correction prompt; that correction is reserved
    for cases where no worker task was actually sent. Duplicate delegation to a
    lane that is already awaited is ignored instead of sending the same task
    twice. Worker internal thinking/tool telemetry stays in the worker lane and
    is not relayed as a supervisor reply; if a worker ends with no final text,
    the supervisor receives an explicit captured-no-text notice rather than raw
    tool rows. Bridge-provider questions/permission prompts from worker lanes
    (notably OpenCode `Question` events) render inside that worker lane as
    AgentRequest cards and can be answered there, instead of leaking raw JSON or
    silently stalling the worker. A fast worker's result no longer sits behind the slowest one — the
    failure mode split distribution makes common. Round budget
    (`MAX_SUPERVISOR_ROUNDS`) counts only fresh delegations, so incremental
    reports don't exhaust it; the idle watchdog force-feeds even with zero
    replies so an abandoned worker is still surfaced. Crew UI rendering subscribes
    only to the active crew's lane/supervisor transcript scopes, not the entire
    global message map, so high-volume worker streaming does not re-render the
    whole app shell.

  8. Known gaps — the worktree fork-point issue, no rollback on partial-launch failure,
  
    per-crew persistence after reload. Honest limitations belong in the doc.
  
    short ASCII state diagram and one usage example (begin → addLane → setMode → launch →
  
    rchive) would make it genuinely useful rather than just a type dump.


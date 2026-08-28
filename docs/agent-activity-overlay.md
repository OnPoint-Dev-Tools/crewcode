# Agent activity overlay

The inline agent activity overlay displays CrewCode-owned turn execution plus provider-native todo, plan, task, and human-input progress. It does not rely on prompt instructions or require an agent to remember to call a task tool.

## CrewCode-owned turn lifecycle

Every bridge-backed solo, lane, or supervisor dispatch creates one `activity` transcript record with a launch-scoped `activityRunId`. CrewCode advances it only from observed events: accepted startup is pending, `turn_start` is in progress, tool categories provide deterministic phases such as reading/editing/testing, and a normal `turn_end` completes it. Prompt rejection, bridge error/closure, custody halt, idle stop, or explicit stop becomes interrupted or cancelled. A terminal outcome cannot be overwritten by a later event. After an app restart, an activity record from the prior runtime projects as interrupted rather than silently resuming or becoming successful. Raw PTY agents do not receive this record because CrewCode cannot observe a structured terminal outcome.

Provider-native todos enrich and replace the generic CrewCode row while its turn is active. Once CrewCode observes a terminal outcome, that outcome wins over stale native `pending` or `in_progress` items, preventing a finished agent from continuing to appear busy. CrewCode-owned activity is a lifecycle record, not a synthetic provider tool call, and is excluded from work-log tool rendering.

## Todo and plan detection

`todo-from-toolcall.ts` folds todo, plan, and task events from the whole chat into one overlay list. It is provider-agnostic: any tool payload that carries a `todos`, `plan`, or `todoList` array or keyed map lights up the same UI. That covers:

- Claude/OpenCode todo payloads;
- Codex `update_plan` notifications;
- Pi `manage_todo_list` calls;
- Grok `todo_write` calls, using `TodosUpdated.state.todos` as the full session store (the merge `todos` array is only the subset just written);
- CrewCoder `crew-tasks` snapshots and incremental Task* mutations;
- compatible plugin/provider tool payloads, including `subject` text and snapshots that arrive on `tool_update` metadata.

Every user message starts a new activity scope. The prior turn's list clears immediately, including unfinished items. The new CrewCode lifecycle row appears without waiting for provider tools, and native evidence emitted after that user message may replace it while execution remains active. Within the current turn, an `in_progress` native item stays active only while the owning CrewCode turn is active. Sparse merge updates (`merge: true`, or entries with ids/status but no text) fold onto the current turn's last full list instead of replacing it, so unmentioned current-turn tasks are not dropped.

CrewCoder's native todo layer is optional `crew-tasks` (`TaskCreate` / `TaskList` / `TaskGet` / `TaskUpdate` / `TaskDelete`). When `autoSyncTodos` is on, every Task* result returns a session `todos` snapshot on ACP `rawOutput`, which this overlay reads like Claude/Pi. The ACP bridge preserves the exact tool name from `_meta["crewcoder/tool"].name` instead of reducing it to the generic `think` kind. `TaskList` contributes activity only when its arguments explicitly set `sessionOnly: true`; a project-wide/default list is inspection data from multiple agent sessions and must never become one chat's overlay. If a turn only has incremental mutations (older CrewCoder, or `autoSyncTodos` off), the overlay reconstructs the list from label-identified `TaskCreate` / `TaskUpdate` / `TaskDelete` events. It does not infer CrewCoder ownership from generic argument shapes because that can capture another provider's plan tools. `crew-tasks` is **disabled by default** in CrewCoder (`crewcoder task on`); CrewCode-owned lifecycle activity still works when Task* is unavailable, without enabling it or fabricating a native plan.

CrewCode keeps the lossy `rawOutput.todos` snapshot as the authoritative list/status view, but merges the matching full `rawOutput.task` record into its `TodoItem`. The retained contract matches current CrewCoder Agent and TUI records: stable `id`, session-local `displayNumber`, `subject`, `description`, `status`, `activeForm`, `owner`, `sessionId`, `projectPath`, `metadata`, `blocks`, `blockedBy`, `createdAt`, and `updatedAt`. Stable IDs and display numbers are intentionally separate. Snapshot reconciliation preserves those fields instead of erasing them. Rendering follows the TUI semantics: active work uses `activeForm`, blocked pending tasks use the blocked marker and dependency hint, completed tasks are struck through, owner/display-number hints are shown when available, and the list orders active before pending before completed work. Provider-local IDs from unrelated todo formats are not promoted to CrewCoder task identity.

## Claude task lifecycle

The Claude Agent SDK also emits `system/task_started` and `system/task_updated` messages for native Task/subagent work. `claude-bridge.ts` maintains the visible task map for the current turn and projects it into one synthetic `claude_tasks` tool call:

- the first visible task emits `tool_start` with a full `todos` snapshot;
- task starts and updates emit `tool_update` with the latest snapshot;
- immediately before `turn_end`, the bridge emits `tool_end` with the final snapshot;
- if Claude omits a terminal `task_updated`, a successful turn finalizes remaining `running` tasks as completed, while abort/error finalizes them as cancelled;
- settled tool calls treat the final result snapshot as authoritative over earlier streaming arguments;
- task state is cleared between turns;
- tasks marked `skip_transcript` are excluded as provider housekeeping.

Claude statuses map as follows:

| Claude SDK | Overlay |
| --- | --- |
| `running` | `in_progress` |
| `completed` | `completed` |
| `failed`, `killed` | `cancelled` |
| `pending`, `paused` | `pending` |

This projection changes only CrewCode visualization. Tool availability and Claude's decision to create or delegate tasks remain controlled by Claude Code and its built-in tool instructions.

## Todo visibility

**Settings → General → Todo activity** controls the global `settings.showTodoActivity` preference. It defaults to visible and persists with the other renderer settings. Turning it off hides aggregate todo/task/plan snapshots across normal and Crew chats; it does not disable provider tools or change agent behavior.

Human-input request cards are independent of this preference. Approvals, questions, editor requests, and notifications must always render because the provider may be paused waiting for the response. Request rendering therefore takes precedence over both the Todo preference and a previously dismissed todo card.

CrewCoder-mode `crewcoder_clarify` / `crewcoder_propose_plan` is a session workflow gate, not a tool-permission pause. After those tools settle, the overlay shows a dedicated clarification or **Approve plan** card. Approve sends `/approve-plan` as a normal prompt (or follow-up if the turn is still running). It must never reuse Allow/Deny on a permission card — `/approve` is still only for pending tool-call grants. A later user message hides the card: `/approve-plan` or a short CrewCoder approval continues implementation, and a revision such as `yes, but also add logging` waits for the next `crewcoder_propose_plan`. Answering a clarification is not plan approval. The Todo preference must not hide this card.

## Surfaces

Todo activity is rendered in:

- normal chat composer activity;
- Crew lane columns;
- the newest Crew timeline round;
- Crew supervisor composer activity.

Older Crew timeline rounds do not show an active overlay, preventing historical completed plans from appearing as current work.

## Task work-log rows

The `task` row in `Messages.tsx` is distinct from the todo overlay. It renders a delegated tool/subagent call in the turn work log. The overlay renders the aggregate provider task or plan snapshot.
`TaskSummaryItem` remains backward-compatible with its generic `tool`/`text` form and can additionally carry a normalized full `task` record, which uses the same task row renderer as `TodoItem`.

# Agent activity overlay

The inline agent activity overlay displays provider-native todo, plan, task, and human-input progress. It is a passive renderer: CrewCode does not prompt agents to create task lists merely to activate the UI.

## Todo and plan detection

`todo-from-toolcall.ts` scans tool calls in the current turn and normalizes arrays named `todos`, `plan`, or `todoList` into a shared status model. This covers:

- Claude/OpenCode todo payloads;
- Codex `update_plan` notifications;
- Pi `manage_todo_list` calls;
- compatible plugin/provider tool payloads.

The scan stops at the latest user message so completed plans from an earlier turn do not reappear in a new turn.

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

## Surfaces

Todo activity is rendered in:

- normal chat composer activity;
- Crew lane columns;
- the newest Crew timeline round;
- Crew supervisor composer activity.

Older Crew timeline rounds do not show an active overlay, preventing historical completed plans from appearing as current work.

## Task work-log rows

The `task` row in `Messages.tsx` is distinct from the todo overlay. It renders a delegated tool/subagent call in the turn work log. The overlay renders the aggregate provider task or plan snapshot.

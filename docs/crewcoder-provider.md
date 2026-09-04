# CrewCoder ACP provider

CrewCoder is a first-class CrewCode chat and Crew provider implemented by
`src/main/agents/crewcoder-bridge.ts`. CrewCode is the ACP **client**: it spawns
`crewcoder acp --approval review`, optionally adding a selected CrewCoder
`--mode`, and translates newline-delimited JSON-RPC 2.0 onto the shared
`AgentBridge` event stream. CrewCoder remains the ACP agent.

CrewCoder-specific usage metadata, permission semantics, reasoning,
and tool-call ordering must not change Hermes behavior.

## Setup

Install or build the `crewcoder` executable and authenticate its configured
backends through CrewCoder:

```bash
crewcoder auth
crewcoder acp --approval review
```

CrewCode detects `crewcoder` on `PATH`. Settings → Agents can override the
binary path. The provider picker shows one **CrewCoder** provider; its model
picker spans CrewCoder's configured backends using `provider:model` ids such as
`codex:gpt-5.6-sol` and `opencode:claude-sonnet-4-6`.

When CrewCoder is installed and selected as the active provider, the desktop
model-row reveal also shows a **crew** mode picker. It offers CrewCoder's
`general`, `crewcoder`, `plugin`, and `extension` profiles plus **Configured
default**. The selection is session-scoped and survives app restarts and chat
duplication. Configured default omits `--mode`, preserving the user's CrewCoder
configuration and compatibility with older installs. Choosing a concrete
profile restarts only the CrewCoder ACP process and resumes the same native
session under the selected profile. The picker closes and stays disabled while
a turn is running so authority cannot change underneath live execution. It
stays absent for unavailable or inactive providers and from the phone layout,
where the desktop model-row reveal itself is intentionally hidden.

When the concrete **CrewCoder** profile is selected, the row also shows a
session-scoped approval picker with all native policies:

- **Review** (`review`) lets safe calls proceed and asks for mutations and dangerous calls.
- **Always** (`always`) asks for every non-safe call.
- **Never** (`never`) shows no prompts while continuing to block dangerous calls.
- **Full access** (`full-access`) accepts calls without prompts.
- **Sandboxed** (`sandboxed`) shows no prompts and runs non-dangerous calls through the sandbox policy where supported.

Older or invalid persisted values fail closed to Review. Changing the policy
drops only the idle CrewCoder bridge and native-resumes it on the next prompt;
both controls are disabled during a running turn. Full access is an explicit
authority escalation: CrewCoder stops emitting approval requests and permits
dangerous commands, so CrewCode's permission overlay and dangerous-command
tripwire cannot interpose on those provider-native calls.

A concrete CrewCoder profile also owns the agent's behavioral mode, so CrewCode
locks its separate execution policy to **Build** and disables the
Ask/Plan/Build/Full control. Under the default Review policy, Build remains the
CrewCode permission gate. Explicit CrewCoder Full access bypasses that native
request path and must not be described as Build-protected. The phone model menu
disables its Mode row for the same session. Returning to **Configured default**
re-enables the execution-mode control; the session remains on Build until the
user chooses another policy.

The `crewcoder` profile adds a runtime inspect → clarify → plan → approve
sequence inside CrewCoder. CrewCode does not enforce that gate; it projects
`crewcoder_clarify` and `crewcoder_propose_plan` into the agent activity overlay
and sends `/approve-plan` as a user prompt when the user clicks **approve plan**
or picks the CrewCoder slash command. That prompt is not `/approve` and does
not settle a `session/request_permission` card. After plan approval, CrewCode
handles any permission requests emitted by the selected native approval policy;
Never, Full access, and Sandboxed may deliberately emit none. Revising a proposed
plan is a normal composer message; CrewCoder treats that as a new
`awaiting_plan` cycle rather than approval.

## ACP lifecycle

The bridge performs this handshake before reporting ready:

1. `initialize` with protocol version 1 and text-file capabilities. The bridge
   recognizes the exact `_meta["crewcoder/sessionCompact"].method ===
   "session/compact"` advertisement; it does not assume the extension exists.
2. `session/load` when CrewCode has a saved native session id; unknown ids fall
   back to `session/new`.
3. `session/set_external_directories` with CrewCode's complete session grant list, including `[]`
   when all grants were removed.
4. `session/set_model` when a model is selected.
5. `session/set_reasoning_effort` applies CrewCode's selected effort to CrewCoder's provider client.
6. `session/prompt` runs each turn; `session/follow_up` queues an instruction into an active CrewCoder turn, and `session/cancel` is an ACP notification.
7. An idle `/compact` calls advertised `session/compact` with the durable
   `sessionId`. Older CrewCoder versions without the advertisement keep the
   existing CrewCode summary-reset fallback.

CrewCoder transcript replay contains user/assistant text only. When CrewCode's
richer local transcript exists, provider replay is suppressed. CrewCoder remains
a native-resume provider. Its advertised compact RPC rewrites that durable
session in place, so CrewCode must not clear the native session id, stop the
bridge, or seed a replacement session after a successful native compact.

## Event mapping

| CrewCoder ACP update | CrewCode event |
| --- | --- |
| `agent_message_chunk` | `text_delta` |
| `agent_thought_chunk` | `thinking_delta` |
| `tool_call` | `tool_start` |
| repeated `tool_call` for the same id | `tool_update` |
| running `tool_call_update` | `tool_update` |
| completed/failed `tool_call_update` | `tool_end` |
| `_crewcoder/compaction_update` | `compaction_event` |

CrewCoder's compaction update is an additive namespaced ACP extension carrying
started/completed/failed status, automatic intent, progress, and a human-readable
message. The bridge treats it as authoritative and does not also infer
compaction from the later context-token drop. Automatic updates omit the summary
body; the compacted summary remains only in CrewCoder's durable session.
Host-requested `session/compact` returns the authoritative summary and includes
it on the completed update. CrewCode replaces only its provider replay shard
with that summary and appends the visible compact-summary card; it deliberately
retains the full rich chat transcript as display history. A skipped update does
not reset context usage. After an applied completion, CrewCode clears stale live
context occupancy from memory, disk, and the latest visible usage strip without
fabricating `0` tokens. The next CrewCoder usage report repopulates the meter
with the compacted context's measured size. Idle compact progress must not
fabricate a model `turn_start`.

CrewCoder emits genuine reasoning, so the Hermes cosmetic-thinking filter must
not be applied. Gated tools are announced as pending before the permission
request; the bridge tracks tool ids so the later running announcement does not
create a duplicate row.

Prompt JSON-RPC errors are emitted as bridge errors and followed by `turn_end`. ACP's standard
`Internal error` envelope can carry CrewCoder's actionable provider message in `error.data.message`;
the bridge prefers that detail instead of appending a misleading generic error after the streamed
failure.

CrewCoder ACP respects CrewCoder's persisted `autoCompact` setting. CrewCode does not force
compaction or retry context-window failures. Automatic and provider-neutral safety compaction are
reported live through `_crewcoder/compaction_update`, allowing CrewCode to show the compaction meter
while CrewCoder summarizes in the background. If the ACP child exits, CrewCode removes that dead
bridge registration; the next composer submission uses normal missing-bridge recovery rather than
attempting to write to closed stdin and surfacing `crewcoder acp: process not writable`. When automatic compaction is off, the user explicitly
runs `/compact` before continuing; this policy does not affect Pi or other providers.

A prompt has a ten-minute **inactivity** watchdog rather than a wall-clock turn
limit. Every matching ACP update or agent request resets it, and time awaiting a
Build permission decision is excluded. If CrewCoder becomes genuinely silent,
CrewCode sends `session/cancel` and waits up to ten seconds for the prompt RPC to
settle before emitting the timeout and `turn_end`. If cancellation itself remains
unresponsive, CrewCode terminates that bridge so its replacement starts cleanly;
a second prompt can never overlap the abandoned CrewCoder turn.

Usage prefers `_meta["crewcoder/usage"]`: `lastInputTokens` is the live
`contextTokens` value and `contextWindow` is the context limit. Top-level usage
is only the compatibility fallback.

ACP `tool_call` updates carry a category `kind` (`read`, `edit`, `think`, …), a
human `title`, and authoritative CrewCoder tool identity in
`_meta["crewcoder/tool"].name`. The bridge records that metadata as `toolName`
even when ACP also fills a generic `name`/`kind` such as `think`;
bare identifier titles remain a compatibility fallback for older CrewCoder ACP
streams.

## Todo activity

CrewCode owns a generic turn-lifecycle activity row, so its overlay does not
depend on CrewCoder calling task tools. CrewCoder has no Claude-style
`TodoWrite` snapshot tool. The matching native layer is `crew-tasks`, which is
disabled until `crewcoder task on` (or `/task on` in the CrewCoder TUI). When
enabled, every Task* result includes a session `todos` snapshot on ACP `rawOutput`
(`content` / `status` / `activeForm`) so the overlay lights up the same way as
Claude and Pi. The bridge preserves the exact Task* name from CrewCoder's ACP
metadata. Older incremental-only turns still reconstruct from `TaskCreate` /
`TaskUpdate` / `TaskDelete` arguments and result metadata. A new user message
clears the prior native list immediately; Task* evidence from the new turn
temporarily enriches the CrewCode-owned lifecycle while execution is active.
CrewCode does not enable `crew-tasks` on ACP spawn and never fabricates Task*
results. A `TaskList` result is eligible only when the call
explicitly used `sessionOnly: true`; project-wide lists can contain unfinished
tasks owned by unrelated CrewCoder sessions and are not chat activity.

The renderer preserves the complete `rawOutput.task` record alongside the
authoritative `rawOutput.todos` snapshot instead of reducing CrewCoder tasks to
three display fields. This includes stable task id, session-local display
number, subject/description, owner/session/project identity, metadata,
dependency edges, and creation/update timestamps. Snapshot updates change the
list and status without discarding those details. CrewCode's `TodoItem` and the
optional task payload on `TaskSummaryItem` render the same active-form,
blocked-pending, completed, owner, and display-number semantics as the
CrewCoder TUI, including active → pending → completed ordering.

## Mode and permission enforcement

CrewCoder always starts with `--approval review`; CrewCode applies the current
composer mode when each `session/request_permission` arrives:

| CrewCode mode | Decision |
| --- | --- |
| Ask / Plan | cancel the permission request |
| Build | show the permission overlay |
| Full Access | select `allow_once` automatically |
| any mode with `toolPolicy: read-only` | cancel the permission request |

CrewCode exposes only **Allow once** and **Reject once** for CrewCoder. CrewCoder
remembers `allow_always`/`reject_always` internally and then stops asking for that
tool; those remembered decisions would bypass a later live composer-mode change.
Once-only choices preserve the invariant that current mode is always authoritative.

CrewCode `ModeLevel` (`ask`, `plan`, `build`, `full`) must never be passed to
CrewCoder's separate agent-profile `--mode` option (`general`, `crewcoder`,
`plugin`, `extension`). The selected `Session.crewcoderMode` is the only value
allowed onto that launch flag. It is process-scoped, whereas CrewCode execution
mode remains the permission policy described above. A concrete CrewCoder
profile fixes that CrewCode policy to Build; it must never inherit a hidden
prior Ask, Plan, or Full Access value. `Session.crewcoderApprovalMode` is a
separate native authority value. CrewCode passes only `review`, `always`,
`never`, `full-access`, or `sandboxed` to `--approval`, defaults
missing/invalid values to `review`, and records the value in execution custody.

## Filesystem and SSH behavior

The bridge advertises `fs.readTextFile` and `fs.writeTextFile`:

- local roots read/write the requested absolute path through Node filesystem APIs;
- `ssh://` roots route text I/O through CrewCode's bounded SFTP helpers;
- Ask, Plan, and `toolPolicy: read-only` block ACP writes;
- `terminal/*` is not implemented.

External directories are persisted on CrewCode's `Session`, passed through bridge startup, and
synchronized into CrewCoder after new/load. CrewCoder validates and persists those roots on the
agent host before authorizing its file tools. Changing the list drops the bridge so the next start
applies the new complete set; an empty set must be sent so removed access cannot survive in the
native CrewCoder session. Synchronization failure leaves the bridge unusable and blocks prompts;
continuing with stale native-session grants would violate the filesystem boundary. CrewCode's
native directory picker is local-only and rejects SSH workspaces rather than misrepresenting a
local path as remote access.

For SSH roots, `spawnAgentProcess` starts CrewCoder on the remote host. Its bash
tool is therefore local to the spawned CrewCoder process, which means remote for
an SSH workspace.

Current limitation: the local ACP filesystem host reads saved disk bytes. It does
not yet query dirty CodeMirror or Writer buffers in the renderer, so an unsaved
edit is not visible to CrewCoder until saved. Do not describe local ACP reads as
unsaved-buffer aware until a bounded renderer-host request path is implemented.

## Deliberate exclusions

CrewCoder is not offered for inline editor completion. Each ACP `session/new`
creates a durable CrewCoder session, which is inappropriate for disposable,
high-frequency ghost-text requests. CrewCoder also does not receive CrewCode MCP
registry entries yet; `session/new` and `session/load` send an empty MCP list.

## Verification

```bash
rtk vitest run src/main/agents/crewcoder-bridge.test.ts
rtk vitest run src/main/agents/compaction-meter.test.ts
rtk vitest run src/renderer/src/components/thread/crewcoder-plan-gate.test.ts
rtk npm run typecheck
```

Manual checks should cover model discovery, streamed text/reasoning, one row per
tool id, Build permission prompts held longer than ten minutes, Ask rejection,
Full auto-accept, inactivity cancellation, native resume, usage, an SSH text
read/write round trip, and CrewCoder-mode clarify then propose-plan overlay
approval via `/approve-plan`.

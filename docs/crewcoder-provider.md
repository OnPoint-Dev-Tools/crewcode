# CrewCoder ACP provider

CrewCoder is a first-class CrewCode chat and Crew provider implemented by
`src/main/agents/crewcoder-bridge.ts`. CrewCode is the ACP **client**: it spawns
`crewcoder acp --approval review` and translates newline-delimited JSON-RPC 2.0
onto the shared `AgentBridge` event stream. CrewCoder remains the ACP agent.

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

## ACP lifecycle

The bridge performs this handshake before reporting ready:

1. `initialize` with protocol version 1 and text-file capabilities.
2. `session/load` when CrewCode has a saved native session id; unknown ids fall
   back to `session/new`.
3. `session/set_external_directories` with CrewCode's complete session grant list, including `[]`
   when all grants were removed.
4. `session/set_model` when a model is selected.
5. `session/set_reasoning_effort` applies CrewCode's selected effort to CrewCoder's provider client.
6. `session/prompt` runs each turn; `session/follow_up` queues an instruction into an active CrewCoder turn, and `session/cancel` is an ACP notification.

CrewCoder transcript replay contains user/assistant text only. When CrewCode's
richer local transcript exists, provider replay is suppressed. CrewCoder remains
a native-resume provider and uses summary-reset for manual compaction because it
has no native compact RPC.

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
compaction from the later context-token drop. The compacted summary remains in
CrewCoder's durable session and is not copied into CrewCode's transcript.
CrewCode deliberately retains the full visible transcript as history; it is not
the provider context. On authoritative completion, CrewCode clears the stale
live context occupancy from memory, disk, and the latest visible usage strip
without fabricating `0` tokens. The next CrewCoder usage report repopulates the
meter with the compacted context's measured size.

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
while CrewCoder summarizes in the background. When automatic compaction is off, the user explicitly
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
CrewCoder's unrelated `--mode` option (`general`, `plugin`, `extension`).

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
rtk npm run typecheck
```

Manual checks should cover model discovery, streamed text/reasoning, one row per
tool id, Build permission prompts held longer than ten minutes, Ask rejection,
Full auto-accept, inactivity cancellation, native resume, usage, and an SSH text
read/write round trip.

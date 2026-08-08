# Grok Build ACP provider

Grok Build is a first-class CrewCode chat provider implemented by
`src/main/agents/grok-bridge.ts`. CrewCode is the ACP **client**: it spawns
`grok agent stdio` and translates newline-delimited JSON-RPC 2.0 onto the shared
`AgentBridge` event stream.

Hermes and CrewCoder speak the same broad ACP dialect, but all three bridges stay
separate. Grok's vendor extensions, permission resolution, and usage shape must
not change Hermes or CrewCoder behavior.

## Setup

Install Grok Build and authenticate:

```bash
grok login
grok agent stdio    # what CrewCode spawns, with flags prepended
```

CrewCode detects `grok` on `PATH`; Settings → Agents can override the binary
path. The model picker is populated from the ACP handshake, so it always matches
what the installed Grok build actually offers.

## Why ACP and not headless

`grok -p --output-format streaming-json` cannot support CrewCode's modes. Its
only permission controls are `--always-approve` or static `--allow`/`--deny`
rules, so Build mode's per-tool approval, turn-scoped grants, mid-turn follow-up
delivery, and graceful cancel all become impossible. ACP provides
`session/request_permission`, `session/cancel`, and `session/load`, which map
directly onto existing CrewCode plumbing.

Note that `grok agent headless` is a *different* thing again — it runs over
xAI's WebSocket relay, not local stdio.

## Execution modes are enforced at spawn, not inherited

This is the most important behavior in this bridge.

Grok resolves its permission mode from `~/.grok/config.toml`, project
`.grok/config.toml`, **and** Claude-compatible `.claude/settings.json`. A user
with `permission_mode = "always-approve"` gets a Grok ACP session that never
asks the client anything and simply runs tools. Measured against a real config:
with no flag, a write executed silently and no `session/request_permission` was
ever sent.

`--permission-mode` is a **top-level** flag and must precede the `agent`
subcommand (`agent stdio` accepts none of these flags). CLI overrides config for
the spawned process, so CrewCode's mode always wins.

| CrewCode mode | `--permission-mode` |
| ------------- | ------------------- |
| `ask`         | `dontAsk`           |
| `plan`        | `dontAsk`           |
| `build`       | `default`           |
| `full`        | `bypassPermissions` |
| `toolPolicy: 'read-only'` | `dontAsk`, regardless of mode |

`grokSpawnArgs()` always emits a permission mode. There is no code path that
lets Grok's own configuration decide it.

### The mode is a floor, not the enforcement

Measured, not assumed: `dontAsk` still **prompts** for a client-side write
rather than auto-denying it. So read-only enforcement does not rest on the mode.
Three independent gates hold the line, and all three are CrewCode's:

1. **Spawn mode** — guarantees Grok asks the client instead of self-approving.
2. **Permission handler** — returns `cancelled` for `ask`/`plan`/read-only.
3. **`fs/write_text_file` handler** — refuses outright. Grok delegates writes to
   the client, so this call is the last gate before bytes reach disk.

A fourth gate covers tool announcements: `grokToolBlocked()` trusts Grok's
`_meta['x.ai/tool'].read_only` flag when present and falls back to a name check,
so an unknown mutating tool fails closed in a read-only mode.

CrewCode deliberately never sends `_meta.yoloMode` on `session/new`. That field
only escalates, and permission policy belongs to the spawn flag.

### Permission options are once-only

Grok offers three choices, including `allow-edits-session` ("allow all edits
during this session"). That grant outlives the turn and would survive a later
composer-mode change, so `grokPermissionOptions()` filters it out. Filtering is
by ACP `kind` (`allow_once` / `reject_once`), not by id, because the ids are
vendor spellings. "Allow all for this turn" remains CrewCode's own
`{bridgeId, turnId}` capability in `turn-permission-grants.ts`.

### Do not use Grok's native plan mode for enforcement

Grok has a real plan mode, and `session/set_mode` works. It is **not** read-only:
per Grok's own docs, "always-approve stays armed underneath plan mode" and
non-edit tools including bash still auto-run — only *edits* are blocked. CrewCode
therefore maps plan to `dontAsk` and never relies on `session/set_mode` as a
policy gate. This mirrors the existing rule for the Claude bridge.

## Usage lives on a vendor channel

Grok carries several things on `_x.ai/session_notification` instead of
`session/update`. Token usage in particular appears **only** there, as a
`response_completed` update. A by-the-book ACP client sees no usage at all and
renders a dead context meter, so `handleLine` consumes both channels.

Per-turn totals also arrive on the `session/prompt` response `_meta`:

- `_meta.inputTokens` — the last model call's input, i.e. live context occupancy.
- `_meta.usage.*` — **cumulative** across the turn's model calls.

`grokUsageFromPromptResult()` reads the former for context and the latter only
for the reported total. Using the cumulative ledger as occupancy double-counts a
two-call turn (24,440 vs the real 12,266 in the captured fixture).

The context window comes from `_meta.modelState.availableModels[]._meta
.totalContextTokens` on the `initialize` response (500,000 for grok-4.5).

## Reasoning effort is clamped

Grok accepts `low | medium | high` only, and has no "off".

The composer's effort picker therefore shows exactly those three for Grok
(`GROK_ROWS` in `EffortPicker.tsx`), using Grok's own labels and descriptions so
the two UIs agree. Offering an "off" row would be a lie — it would silently
clamp to `low` at spawn.

`grokReasoningEffort()` still clamps defensively for any value that reaches the
bridge from persisted session state or a provider switch: `off`/`low` → `low`,
`medium` → `medium`, everything above → `high`. That clamp is deliberate — Grok
rejects an unknown value for the whole process, so passing `xhigh` through would
kill the bridge at spawn rather than degrade one turn. An unset effort sends no
flag, so Grok keeps its own configured default.

Effort is applied at spawn, so changing it requires a bridge restart.

## Only a live `session/prompt` may open a turn

Two guards decide whether an incoming `session/update` starts a turn, and both
exist because of the same user-visible failure: the composer stuck on "working"
after the reply was already finished, and the next message rejected with
`grok acp: a turn is already running`.

1. **Update kind** (`grokUpdateStartsTurn`) — only `agent_message_chunk`,
   `agent_thought_chunk`, `tool_call`, and `tool_call_update` carry turn
   content. Session chrome (`available_commands_update`, `current_mode_update`,
   `session_info_update`) never does. Grok pushes `available_commands_update`
   twice right after `session/new`, before any prompt exists.
2. **Prompt in flight** (`promptInFlight`) — Grok also keeps flushing turn
   *content* after it has answered the `session/prompt` request: a trailing
   `tool_call_update`, or chunks flushed after a `session/cancel`. Those arrive
   when no request is outstanding, so nothing will ever call `endTurn` for the
   turn they would open. They are dropped instead; `endTurn` has already swept
   every unsettled tool call to `cancelled`, so no row is left spinning.

`promptInFlight` is set in `prompt()` immediately before `startTurn()` and
cleared at the top of `endTurn()` — before its `await`, so the network-backed
usage enrichment cannot leave a window where a late update sneaks a turn in.
`endTurn()` is also reachable from the process `close` handler, which the same
placement covers.

## Failure reporting

Grok answers a failed `session/prompt` with a JSON-RPC error, so the turn always
ends — the composer does not hang on a provider failure. But the payload is
split badly, verified against a live free-quota exhaustion on 1.0.0:

```json
{"code":-32003,"message":"Rate limited",
 "data":"API error (status 429 ...): subscription:free-usage-exhausted: You've
  used all the included free usage for model grok-4.5 ... tokens
  (actual/limit): 513300/500000. Upgrade ... https://grok.com/supergrok"}
```

`message` alone is worthless; `data` holds the quota, the reset window, and the
upgrade link. `grokRequestErrorMessage()` merges both and drops the summary when
`data` already restates it.

Grok also retries a failing call up to 15 times (`_x.ai/session_notification`
→ `retry_state`) and writes the same tracing-formatted line to stderr on every
attempt. One rate limit produced five stderr lines, each carrying ANSI colour
codes and an RFC3339 timestamp. `grokStderrMessage()` strips both, and the
bridge collapses an identical repeat inside a 30s window, so a rate limit is one
chat row rather than five escape-sequence-littered ones.

Two vendor turn-end signals exist and are deliberately unused, because the
JSON-RPC response is authoritative and arrives last:
`_x.ai/session/prompt_complete` (`{promptId, stopReason, agentResult}`) and
`session_notification` → `turn_completed`.

## Follow-ups are queued locally

Sending while a turn runs queues the message instead of failing. The queue lives
in the bridge, Claude-style, not upstream in Grok.

Grok *would* accept a concurrent `session/prompt` and queue it itself —
`_x.ai/queue/changed` shows a second prompt sitting at position 0 while the first
runs. That path was deliberately not used. Grok runs its queued prompt as a fresh
turn *after* the current one stops, which is the same observable behavior as a
local queue, but upstream queueing gives up two things CrewCode wants: pending
items visible in the composer, and the ability to cancel one before it is sent.
Queueing locally also keeps exactly one `session/prompt` in flight, so turn
accounting stays unambiguous (no question of which turn owns the usage, and no
double `endTurn`).

This is the same deliberate limitation the Claude bridge carries: CrewCode's one
follow-up behavior is "deliver at the next safe point," and for a provider that
cannot inject mid-turn, running it the instant the turn ends is the closest
achievable behavior.

Mechanics:

- `prompt()` with `streamingBehavior: 'followUp'` during a turn pushes onto
  `followUpQueue` and emits `follow_up_queued` (display text clamped to 300
  chars; the queued entry keeps the full text).
- `drainFollowUps()` runs after `endTurn()` — **the order matters**, because the
  drain is gated on `currentTurnId` being cleared. Draining first is a silent
  no-op and the queue never flushes. Two tests pin this ordering.
- Draining emits `follow_up_removed` with reason `sent`, then re-enters
  `bridge.prompt()`. FIFO.
- `removeFollowUp()` cancels a pending item (`reason: 'removed'`).
- `abort()` and `stop()` clear the whole queue (`reason: 'cleared'`) so a queued
  message never fires at a turn the user just cancelled.
- A concurrent prompt *without* the follow-up flag is still rejected.

## Icon

`src/renderer/src/assets/grok.svg` is a `currentColor` glyph and is registered in
`MONOCHROME_PROVIDER_IMAGES`, so the existing theme filter recolors it for dark
and light rather than shipping two files.

## Server request ids start at 0

Grok numbers its server→client requests from `0`. Presence must be tested with
`typeof id === 'number'`, never truthiness — a falsy check silently drops the
first request of every session, which is usually the first permission prompt,
and hangs the turn waiting for a reply that never comes. (This bug was hit while
probing; both existing ACP bridges already do it correctly.)

## Model discovery

`detectGrokModels()` in `model-detect.ts` reads the catalog straight off the ACP
`initialize` response `_meta.modelState`. No session is created, so discovery
never writes a stray session file into `~/.grok/sessions`. Discovery also spawns
with `--permission-mode dontAsk` so it cannot inherit a permissive user config.

## Sessions and resume

Grok advertises `loadSession: true` and persists sessions under
`~/.grok/sessions`. The bridge tries `session/load` with a saved resume id and
falls back to `session/new` if the id is stale, matching the other ACP bridges.
Grok is in `NATIVE_RESUME_PROVIDERS`, and provider history replay is suppressed
when CrewCode already holds richer local transcript history.

## Not wired yet

- **Mid-turn injection.** Nothing delivers a follow-up *into* a running Grok turn
  (see Follow-ups below for what does happen).
- **Terminal capability.** Declined with `-32601`, as in the other ACP bridges.
- **Slash commands.** Grok advertises `available_commands_update` (`/compact`,
  `/deep-research`, `/workflow`, `/goal`). None are surfaced.
- **Hooks, subagents, plugins, worktrees.** Grok has its own versions of all
  four. CrewCode ignores them; its own worktree isolation is unaffected.
- **`--deny` rules.** Not passed. Grok's deny rules are enforced ahead of
  always-approve and would be a legitimate fifth gate, but the rule-name syntax
  for non-Bash tools is unverified and a wrong name is a silent no-op, which
  would give false confidence rather than real defense.

## Known risk

An administrator can lock `bypassPermissions` off via `requirements.toml`
(`~/.grok/` or `/etc/grok/`). If set, Full Access silently degrades to
prompting. The bridge does not detect this yet.

## Tests

`src/main/agents/grok-bridge.test.ts` covers the pure policy helpers and drives
the live bridge against a fake ACP process for the refusal paths. Fixtures are
captured verbatim from `grok agent stdio` 0.2.118 so they cannot drift into a
shape the real provider never sends.

```bash
npx vitest run src/main/agents/grok-bridge.test.ts
```

Keep the permission-refusal, `fs/write_text_file`-refusal, once-only-option, and
id-`0` cases covered when changing this bridge.

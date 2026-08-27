# YuHeard — universal terminal agent-done alerts

YuHeard is CrewCode's provider-neutral channel for "an agent in a terminal
pane just finished a turn." When the channel fires, the app plays a short
knock sound and (optionally) sends a native OS notification. It works for
every built-in agent that has a PtyPane (Claude, Codex, OpenCode, Grok,
Hermes, Pi, CrewCoder, Ollama) and for any pty-transport agent whose
binary talks to the YuHeard socket.

This page covers the protocol, the CLI, the env vars, the auto-wrap
behavior, and the privacy model. For the "how do I install the Claude
hook" walkthrough, see [Install the Claude hook](#install-the-claude-hook).

## At a glance

```
any agent lifecycle (claude hook, codex wrapper, plain shell, custom)
        │
        │   writes one JSON line to the socket
        ▼
Unix socket  ~/.crewcode/yuheard.sock  (per-user, 0600)
        │
        ▼
CrewCode main process  (src/main/yuheard-server.ts)
        │   validates, dedupes, dedups within 500ms
        ▼
IPC  yuheard:state  →  renderer
        ▼
zustand store  (src/renderer/src/stores/yuheard-store.ts)
        │   on 'complete' transition:
        │     playNotificationSound('knock')
        │     optional OS notification (when window is unfocused)
        ▼
[sound, OS notification]  —  no flash, no in-app UI
```

## The protocol

YuHeard uses newline-delimited JSON over a Unix socket. The default path
is `~/.crewcode/yuheard.sock`. Override with the `YUHEARD_SOCKET` env var.

Two kinds of messages go over the socket.

### State report

```json
{
  "pane_id": "pn-ws-1-claude-x1y2",
  "state": "running",
  "source": "claude-hook",
  "message": "optional preview text for the OS notification body",
  "session_id": "optional agent session id",
  "ts": 1737000000000
}
```

- `pane_id` must match a live `PtyPane.paneId` (the value of
  `$YUHEARD_PANE_ID` set by CrewCode when it spawned the pane).
- `state` is one of `running` or `complete`.
- `source` is free-form. The renderer uses it for the `chatReply` UI
  type but it doesn't gate any behavior.
- `message` is the optional preview text shown in the OS notification.
- `ts` is `Date.now()` at send time. The server uses it for ordering;
  if missing, the server substitutes its own clock.

The server replies with one line per report:

```json
{"ok":true,"result":"applied"}
{"ok":false,"error":"unknown-pane"}
```

The `result` field is one of `applied`, `duplicate` (a same-state
report within the 500ms debounce window), or `unknown-pane`.

### Control: pane-id-lookup

When a CLI is called from a shell that wasn't spawned by CrewCode (and
so doesn't have `$YUHEARD_PANE_ID` set), it can ask the server to find a
pane by cwd:

```json
{"method":"pane-id-lookup","cwd":"/home/me/projects/foo"}
```

The server replies with the most recently created live pane whose
`cwd` matches. If multiple panes share a cwd, the most recent one
wins. Used by `bin/yuheard` when the env is missing.

## State literal strings

For symmetry with the herdr integration the user pointed at
(`/home/aura/.claude/hooks/herdr-agent-state.sh`), the canonical
state-form strings are `YuHeard:Running` and `YuHeard:Complete`. These
are documentation anchors — the wire protocol uses
`running` / `complete` as the JSON values. The literals are exported
from `src/shared/yuheard-types.ts` as `YUHEARD_RUNNING_LITERAL` and
`YUHEARD_COMPLETE_LITERAL`.

## Environment variables

CrewCode injects these into the env of every PtyPane it spawns (via
`pty.spawn`):

| Variable | Example value | Purpose |
|---|---|---|
| `YUHEARD_PANE_ID` | `pn-ws-1-claude-x1y2` | The opaque pane id. Use this verbatim in socket reports. |
| `YUHEARD_SOCKET` | `/home/me/.crewcode/yuheard.sock` | The socket path (usually the default; respected if overridden). |
| `YUHEARD_AGENT` | `claude` | The agent id if the pane is a tagged agent; unset for plain shells. |
| `YUHEARD_INTEGRATION` | `crewcode` | Always `crewcode` for panes spawned by CrewCode. |
| `PATH` (modified) | `<wrappers-dir>:<original PATH>` | The YuHeard auto-wrap shim directory is prepended. See [Auto-wrap](#auto-wrap). |

Users who run their agent outside a CrewCode pane can set
`YUHEARD_PANE_ID` and `YUHEARD_SOCKET` in their shell environment
manually. The CLI's `pane-id-lookup` control message is the fallback.

## The CLI: `bin/yuheard`

Shipped in `bin/yuheard.mjs` and exposed via the npm `bin` field as
the `yuheard` command. Works on any machine with Node.js ≥ 22.

```text
yuheard pane-id                    # print $YUHEARD_PANE_ID (or "(unset)")
yuheard socket                     # print the YuHeard socket path
yuheard running [message]          # report 'running' for the calling pane
yuheard complete [message]         # report 'complete' for the calling pane
yuheard --help                     # show help
```

Examples:

```sh
# Inside a CrewCode shell pane with auto-wrap on:
$ yuheard complete
{"ok":true,"result":"applied"}

# From a script outside CrewCode (uses pane-id-lookup by cwd):
$ yuheard complete "task done"
{"ok":true,"result":"applied"}
```

Exit codes: `0` ok, `1` socket/lookup error, `2` bad arguments.

## Auto-wrap

When `settings.yuheardAutoWrap === true` (default true) and a plain
shell pane is spawned, CrewCode installs a per-pane shim directory at
`~/.crewcode/wrappers/<paneId>/` containing one shim per enabled
agent from `AGENT_DEFS` (claude, codex, opencode, grok, hermes, pi,
crewcoder, ollama). The directory is prepended to the pane's `PATH`.

Each shim:

```sh
#!/bin/sh
real="$(command -v claude 2>/dev/null || true)"
if [ -z "$real" ]; then
  printf 'yuheard: cannot find "%s" on PATH\n' "claude" >&2
  exit 127
fi
yuheard running "$YUHEARD_PANE_ID" "$@" >/dev/null 2>&1 || true
exec "$real" "$@"
```

- `yuheard running` is fire-and-forget; socket latency never blocks
  the agent's startup.
- `exec "$real" "$@"` replaces the wrapper process, so TTY, signals,
  stdin/stdout/stderr, and exit codes behave identically to running
  the real binary directly.
- `complete` is not shimmed: the wrapper exec's the real binary, so
  the real binary IS the wrapper's child. When the real binary exits,
  `pty-service.ts`'s process-exit handler synthesizes `complete` for
  the pane (using `shouldAutoComplete()` to gate within 60s of the
  last `running` report). The 60s window is a safety bound — an
  agent that has been "running" for over a minute is not auto-completed
  because something else probably owns the lifecycle (the bridge or a
  manual socket call).

The shim directory is removed when the pane closes. If a pane crashes
ungracefully, the next app startup prunes any wrapper dir older than
24h.

## Install the Claude hook

If you want a Claude Code hook to drive YuHeard (in addition to the
auto-wrap shim and the bridge turn-end), drop the example script into
your Claude config:

```sh
cp examples/hooks/yuheard-claude.sh ~/.claude/hooks/yuheard-claude.sh
chmod +x ~/.claude/hooks/yuheard-claude.sh
```

Then in `~/.claude/settings.json` (or your plugin's `hooks.json`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "~/.claude/hooks/yuheard-claude.sh prompt" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "~/.claude/hooks/yuheard-claude.sh stop" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "~/.claude/hooks/yuheard-claude.sh start" }] }
    ],
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "~/.claude/hooks/yuheard-claude.sh end" }] }
    ]
  }
}
```

The hook reads `$YUHEARD_PANE_ID` from the env that CrewCode injected
when it spawned the Claude pane. If the env is missing (Claude was
launched outside CrewCode), the hook no-ops gracefully — installing
it has no effect on non-CrewCode sessions.

## Universality

YuHeard is the union of three report sources:

1. **PtyPane process exit** (auto-wrap case). The main process detects
   the agent's process exiting and synthesizes `complete` via
   `shouldAutoComplete()` + `reportYuHeardFromProcess()`. No client
   involvement required.
2. **Bridge turn-end** (built-in `transport: 'bridge'` agents like
   Claude, Codex, etc.). `App.tsx` subscribes to `subscribeBridgeTurnEnd`
   and calls `useYuHeardStore.applyComplete()` with the matching
   `PtyPane.paneId` (or the chat tab id if no pane exists for that
   session).
3. **Socket reports** (Claude hook, yuheard CLI, any custom client).
   Reports go to the socket, are validated, deduped, and forwarded to
   the renderer.

The renderer dedupes by `(paneId, 500ms window)` so sources 2 and 3
don't double-fire if a Claude hook reports `complete` near-simultaneous
to the bridge turn-end.

## Settings

Two toggles in **Settings → YuHeard alerts** (below the existing
notification block):

- **YuHeard alerts** (`yuheardEnabled`, default true). Master switch.
  When off, the renderer ignores all `complete` reports.
- **Auto-wrap agent commands** (`yuheardAutoWrap`, default true).
  When on, plain shell panes get the shim directory.
- **Test knock sound** button. Plays the `knock` sound (the one
  YuHeard plays on every `complete`).

The `notificationSound` global setting is **not** reused — YuHeard
always plays the `knock` tone, because the user asked for it
specifically. The global setting is reserved for the existing
agent-turn bridge notifications.

## Privacy and security

- The socket is per-user (`~/.crewcode/yuheard.sock`) with permission
  `0600`. Same-UID only. There is no auth token because the threat
  model is "another user on the same machine" and a per-user 0600
  socket is the standard Unix convention (matches ssh-agent).
- Reports carry the opaque pane id, the state, an optional free-form
  message, and an optional session id. Nothing in the protocol
  authorizes any privileged action — YuHeard is a sound alert, not
  an IPC for command execution.
- The renderer dedupes and gates on `settings.yuheardEnabled`. A
  misbehaving client that floods the socket cannot make the renderer
  play sounds faster than the 500ms debounce.
- The YuHeard server runs in the Electron main process; it cannot be
  reached from a web page, and the renderer is the only consumer of
  the IPC it sends.

## How to test

After `npm run dev`:

1. Open CrewCode, create a plain shell pane (no agent).
2. Type `claude` (with auto-wrap on). Confirm: the wrapper fires
   `running` over the socket.
3. Let the agent run, then exit. Confirm: the process exit fires
   `complete` (auto-synthesized by `pty-service.ts`) → renderer plays
   the knock sound.
4. Click the CrewCode window to focus it. Open a second pane with
   `claude` running. Switch to another tab in the same workspace.
   When the agent finishes, you should hear the knock AND see an OS
   notification.
5. In **Settings**, toggle **YuHeard alerts** off. Repeat. No sound,
   no notify.
6. From any shell, run `yuheard complete` (if you have the CLI on
   PATH). Confirm: the renderer receives the report, the same knock
   plays.

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| No knock when agent finishes. | YuHeard disabled in Settings → toggle **YuHeard alerts** on. |
| `yuheard: cannot find "claude" on PATH`. | The real binary isn't installed. Install it, or disable auto-wrap for that agent. |
| `yuheard: socket timeout`. | The CrewCode main process isn't running, or the socket path is wrong. Confirm `yuheard socket` returns a path under `~/.crewcode/`. |
| Knock fires for the wrong pane. | The pane id from the hook is wrong. Confirm `$YUHEARD_PANE_ID` is set in the env of the agent process. |
| `yuheard complete` reports `unknown-pane`. | The pane has already closed. Open a new pane and retry. |

## See also

- `docs/notifications.md` — the existing native-notification
  pipeline that YuHeard complements (but does not replace).
- `examples/hooks/yuheard-claude.sh` — copy-pasteable Claude Code
  hook.
- `bin/yuheard.mjs` — the CLI source.
- `src/shared/yuheard-types.ts` — the protocol types and state
  literal constants.
- `src/main/yuheard-server.ts` — the socket server.
- `src/main/yuheard-wrapper.ts` — the per-pane shim generator.
- `src/renderer/src/stores/yuheard-store.ts` — the renderer store.

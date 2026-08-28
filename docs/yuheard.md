# YuHeard — universal terminal agent-done alerts

YuHeard is CrewCode's provider-neutral channel for "an agent in a terminal
pane just finished a turn." When the channel fires, the app plays a short
knock sound and (optionally) sends a native OS notification. It is **not**
the chat-turn notification path — completed Solo/Crew chats keep using
**Settings → Desktop notifications** and **Notification sound**. YuHeard
is only for agents running in a PtyPane.

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
        │   on 'complete' from a terminal pane:
        │     playNotificationSound('knock')   // never the chat sound
        │     in-app toast; OS notification when the window is unfocused
        ▼
[sound, in-app toast, optional OS notification]
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
# PATH is rewritten without this shim dir, then:
#   python3/node yuheard-hook.py running
#   exec "$real" [codex -c notify=... flags] "$@"
```

- The shim reports `running` through a baked-in Python/Node helper
  talking to the Unix socket. It does **not** require `yuheard` on
  PATH (that was why shell panes never notified).
- Fish rewrites PATH in `config.fish` and often defines `function
  codex` (or similar) that shadows PATH. After rc, CrewCode runs
  `fish -C` to re-prepend the wrapper dir **and redefine those
  functions** so they exec the shim. Bash uses `PROMPT_COMMAND` to
  `unset -f` / `unalias` the same names, then prepend PATH.
- `exec "$real" "$@"` replaces the wrapper process, so TTY, signals,
  stdin/stdout/stderr, and exit codes behave identically to running
  the real binary directly.
- Mid-session `complete` is not shimmed for most CLIs. After the user
  submits a prompt inside an active agent, YuHeard watches PTY output:
  BEL / OSC 9 / OSC 777 complete immediately, and a large output burst
  that then goes idle (~2.8s) completes the turn. Launching the CLI
  explicitly disarms this fallback so its initial TUI paint cannot alert.
- **Codex is special.** The Codex TUI redraws continuously (status /
  spinner), and both startup and prompt submission can resemble a completed
  output burst. PTY idle/BEL heuristics are therefore disabled while Codex is
  active. The `codex` shim and any
  pane that *is* the Codex binary inject `-c notify=[<per-pane hook>]`
  plus `tui.notifications=true`, `tui.notification_method="bel"`, and
  `tui.notification_condition="always"`. Codex's default TUI notify
  is unfocused-only; CrewCode's xterm PTY looks focused, so without
  `always` the BEL never arrives. The hook still reports
  exactly `agent-turn-complete` or `approval-requested`; empty, startup,
  and unknown notify payloads are ignored. This does not edit
  `~/.codex/config.toml`.
- When the real binary exits within 60s of the last `running` report,
  `pty-service.ts` synthesizes `complete` (`source: auto-wrap-exit`).
  The report is accepted even after the live PTY handle is gone, as
  long as the pane was recorded at spawn. The 60s window is a safety
  bound for one-shot CLIs; long interactive sessions rely on idle/BEL
  or a Stop hook instead.

The shim directory is removed when the pane closes. If a pane crashes
ungracefully, the next app startup prunes any wrapper dir older than
24h.

The PTY service imports the wrapper generator statically and receives the
active YuHeard server through an injected accessor. Do not replace these with
runtime `require('./yuheard-*')` calls: electron-vite may place PTY service code
in a shared chunk without emitting sibling module files, causing every wrapper
setup call to fail before the shell starts. A plain shell diagnostic for that
failure is `type -a codex`: in an eligible Fish pane it must list the per-pane
CrewCode function/shim before the real executable.

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

YuHeard is the union of these report sources — none of them are the
GUI chat bridge:

1. **PTY turn detect** (interactive terminal agents). After a prompt is
   submitted, BEL / OSC 9 / OSC 777 complete immediately — those
   sequences *are* the notify. Startup output is ignored. Idle-after-output still requires an
   agent-tagged pane, a socket `running` report, or a typed line whose
   first command is a known agent CLI (`codex`, `claude`, …). Codex is
   excluded from this heuristic because it has exact hook events.
2. **Codex notify hook.** Spawned `codex` processes get a per-pane
   `-c notify=` override plus `tui.notification_condition="always"`
   and `tui.notification_method="bel"`. Codex calls the hook on turn
   complete and also writes BEL into the PTY. This is the sole completion
   path for Codex TUI panes, so sending a prompt cannot alert by itself.
3. **PtyPane process exit** (auto-wrap one-shot case). The main process
   detects the agent's process exiting and synthesizes `complete` via
   `shouldAutoComplete()` + `reportYuHeardFromProcess()`.
4. **Socket reports** (Claude hook, yuheard CLI, any custom client).
   Reports go to the socket, are validated, deduped, and forwarded to
   the renderer.

The renderer (and the server) dedupe by `(paneId, 500ms window)` so a
Stop hook and an idle detect for the same turn do not double-knock. When
the exact completing terminal pane currently owns keyboard focus, the renderer
suppresses every YuHeard surface for that completion: knock, in-app toast, and
OS notification. A different focused terminal does not suppress the alert.
Window focus alone is insufficient, and a stale xterm active element after the
CrewCode window loses focus does not suppress anything.

Chat and Crew tabs never join YuHeard. Sidecar shells on a Solo chat
do not get wrap env, idle detect, or cwd lookup. Completions in those
chats keep the existing in-app toast, `notificationSound`, and optional
OS notification — one path, not two.

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
always plays the `knock` tone. The global setting stays reserved for
chat-turn notifications. If you hear knock on a Solo/Crew chat, that
is a bug: chat must not call YuHeard.

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
3. Prompt the agent and wait for the reply. After output goes idle
   (~2.8s) you should hear the **knock**, not the chat notification
   sound. A one-shot `claude -p …` that exits still knocks on process
   exit.
4. Focus the exact terminal pane containing the agent and let a turn finish.
   You should get no knock, in-app toast, or OS notification. Then focus a
   different terminal pane and repeat: the knock and in-app toast should fire.
   Unfocus the CrewCode window and repeat to also see an OS notification titled
   "Terminal agent finished".
5. Send a message in a Solo chat. You should get the existing chat
   notification / **Notification sound**, and you should **not** hear
   the YuHeard knock unless that sound is itself set to knock.
6. In **Settings**, toggle **YuHeard alerts** off. Repeat the terminal
   steps. No knock, no terminal OS notify. Chat notifications still
   work.
7. From any shell, run `yuheard complete` (if you have the CLI on
   PATH). Confirm: the renderer receives the report, the same knock
   plays.

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Knock plays on a regular chat. | Chat must not call YuHeard. Chat uses **Notification sound**; YuHeard is terminal-only. |
| No knock when a terminal agent replies. | YuHeard disabled in Settings → toggle **YuHeard alerts** on. Close and reopen the pane after a CrewCode restart so spawn argv / shims refresh. Codex needs the injected `-c notify=` hook **and** `tui.notification_condition=always` (BEL). Other CLIs need idle/BEL or a Stop hook. A Fish `function codex` used to skip the shim; new panes redefine that function after rc. |
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
- `src/main/yuheard-turn-detect.ts` — BEL / idle fallback for still-running CLIs.
- `src/renderer/src/stores/yuheard-store.ts` — the renderer store.

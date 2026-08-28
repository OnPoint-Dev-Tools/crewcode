#!/bin/sh
# CrewCode YuHeard — Claude Code hook bridge.
#
# Install:
#   cp examples/hooks/yuheard-claude.sh ~/.claude/hooks/yuheard-claude.sh
#   chmod +x ~/.claude/hooks/yuheard-claude.sh
#   # Then in ~/.claude/settings.json (or your plugin's hooks.json), add:
#   #   "UserPromptSubmit": [{ "hooks": [{ "type": "command",
#   #       "command": "~/.claude/hooks/yuheard-claude.sh prompt" }] }]
#   #   "Stop":            [{ "hooks": [{ "type": "command",
#   #       "command": "~/.claude/hooks/yuheard-claude.sh stop"   }] }]
#   #   "SessionStart":    [{ "hooks": [{ "type": "command",
#   #       "command": "~/.claude/hooks/yuheard-claude.sh start"  }] }]
#   #   "SessionEnd":      [{ "hooks": [{ "type": "command",
#   #       "command": "~claude/hooks/yuheard-claude.sh end"    }] }]
#
# The hook reads $YUHEARD_PANE_ID and $YUHEARD_SOCKET from the environment
# that CrewCode injects when it spawns the agent's PTY. If those are unset
# (e.g. you launched `claude` outside CrewCode), the hook no-ops gracefully
# — installing it has no effect on non-CrewCode sessions.
#
# See docs/yuheard.md for the full protocol.

set -eu

action="${1:-}"
[ -n "${YUHEARD_PANE_ID:-}" ] || exit 0
[ -n "${YUHEARD_SOCKET:-}" ] || exit 0

# Optional: read the user prompt from stdin (Claude Code passes hook input
# as JSON on stdin) and use the first ~140 chars as the message body. The
# `complete` notification surfaces this as the toast body.
message=""
if [ "$action" = "prompt" ]; then
  message="$(cat 2>/dev/null \
    | sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\([^"]\{1,140\}\).*/\1/p' \
    | head -1 || true)"
fi

case "$action" in
  start|prompt) yuheard running  "$YUHEARD_PANE_ID" "$message" >/dev/null 2>&1 || true ;;
  stop|end)     yuheard complete "$YUHEARD_PANE_ID"          >/dev/null 2>&1 || true ;;
  *) exit 0 ;;
esac

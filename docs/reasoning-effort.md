# Provider reasoning effort

CrewCode exposes provider-native reasoning effort choices in the composer and per-lane crew controls.

## Supported levels

| Provider | Levels |
| --- | --- |
| Claude | `off`, `adaptive`, `low`, `medium`, `high`, `xhigh`, `max` |
| Codex | `off`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| Other bridge providers | `off`, `low`, `medium`, `high`, `xhigh` |

The picker is provider-aware. When switching providers, the composer resets an
unsupported selected level to the first offered level (or `off` when no effort
controls exist). Adaptive is offered only for Claude.

## Provider mapping

### Claude

Claude levels map directly to the Claude Agent SDK `effort` option. `off` is different: Claude enables adaptive thinking by default, so CrewCode sends `thinking: { type: 'disabled' }` explicitly.

**Adaptive** is a CrewCode selection, not an SDK effort value. It omits both
`effort` and `thinking` from `query()` options, letting Claude Code resolve its
effort from the environment, user/project settings, and model defaults. It does
not clear those settings or force a particular numeric level. The choice is
Claude-only and appears after Off in desktop, mobile, and crew effort menus.
Named effort levels guide adaptive reasoning too; supported levels depend on
the selected model and installed Claude Code version. CrewCode passes named
levels through without inventing model support or silently replacing them.
See [Claude Code effort configuration](https://code.claude.com/docs/en/model-config#adjust-effort-level)
and the [Agent SDK effort option](https://code.claude.com/docs/en/agent-sdk/agent-loop#effort-level).

Claude `max` is maximum native reasoning effort. It does not enable automatic task delegation. The SDK's separate ultracode workflow setting is intentionally not represented as a reasoning effort.

**Redacted thinking**: Opus-class models with effort thinking stream `thinking_delta` events whose `thinking` text is empty — only an `estimated_tokens` counter is exposed. This is SDK behavior, not a CrewCode bug: there is no reasoning text to render as a THOUGHTS block. The claude bridge surfaces these as a transient `Thinking… ~N tokens` status (cleared when the first text/tool block opens) rather than a thinking row. Models/configs that do stream thinking text still produce normal THOUGHTS blocks.

### Codex

Codex levels are sent through the app-server `thread/start` or `thread/resume` `effort` field. `off` omits the field. `xhigh`, `max`, and `ultra` pass through unchanged and are never downgraded.

`ultra` requests Codex's native ultra reasoning with automatic task delegation. CrewCode does not emulate that delegation: availability and sub-agent behavior depend on the installed Codex CLI/app-server version honoring the native value.

## Session behavior

Effort remains session-scoped. Changing effort drops the active bridge so the next prompt starts or resumes the provider with the new native option. Crew lanes may inherit the composer effort or pin a provider-specific value.

The same bridge options are used for local and SSH-hosted agents; no local-only path or platform-specific argument handling is required.

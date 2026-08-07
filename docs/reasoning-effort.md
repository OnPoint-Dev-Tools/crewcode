# Provider reasoning effort

CrewCode exposes provider-native reasoning effort choices in the composer and per-lane crew controls.

## Supported levels

| Provider | Levels |
| --- | --- |
| Claude | `off`, `low`, `medium`, `high`, `xhigh`, `max` |
| Codex | `off`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| Other bridge providers | `off`, `low`, `medium`, `high`, `xhigh` |

The picker is provider-aware. When switching providers, CrewCode resets an unsupported selected level to `medium` instead of silently downgrading it.

## Provider mapping

### Claude

Claude levels map directly to the Claude Agent SDK `effort` option. `off` is different: Claude enables adaptive thinking by default, so CrewCode sends `thinking: { type: 'disabled' }` explicitly.

Claude `max` is maximum native reasoning effort. It does not enable automatic task delegation. The SDK's separate ultracode workflow setting is intentionally not represented as a reasoning effort.

**Redacted thinking**: Opus-class models with effort thinking stream `thinking_delta` events whose `thinking` text is empty — only an `estimated_tokens` counter is exposed. This is SDK behavior, not a CrewCode bug: there is no reasoning text to render as a THOUGHTS block. The claude bridge surfaces these as a transient `Thinking… ~N tokens` status (cleared when the first text/tool block opens) rather than a thinking row. Models/configs that do stream thinking text still produce normal THOUGHTS blocks.

### Codex

Codex levels are sent through the app-server `thread/start` or `thread/resume` `effort` field. `off` omits the field. `xhigh`, `max`, and `ultra` pass through unchanged and are never downgraded.

`ultra` requests Codex's native ultra reasoning with automatic task delegation. CrewCode does not emulate that delegation: availability and sub-agent behavior depend on the installed Codex CLI/app-server version honoring the native value.

## Session behavior

Effort remains session-scoped. Changing effort drops the active bridge so the next prompt starts or resumes the provider with the new native option. Crew lanes may inherit the composer effort or pin a provider-specific value.

The same bridge options are used for local and SSH-hosted agents; no local-only path or platform-specific argument handling is required.

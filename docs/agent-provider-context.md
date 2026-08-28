# Agent provider context policy

CrewCode should keep provider-owned prompt context explicit and bounded.

## Provider switch context handoff

Provider-internal session state is not portable. When a user switches providers mid-chat, CrewCode starts a fresh upstream provider session but seeds it from CrewCode's own session-scoped local transcript.

Keep native resume IDs provider-specific (`sessionId:provider`) so one provider never receives another provider's opaque session id. Keep the local replay transcript scoped to the chat session itself so stateless providers and native-resume fallbacks can continue the visible conversation after a provider/model swap.

Short version: switching providers is context replay/handoff, not true provider session migration.

When the user switches providers before token exhaustion, the next send should still be treated as a handoff. Show a `handoff` progress meter in the thread, spawn a disposable incoming-provider session to summarize a bounded copy of the existing CrewCode transcript, close that disposable session, then inject a handoff packet containing workspace metadata plus the generated summary. Do this even if the target provider has a saved native resume id, because that provider's native context may be stale relative to turns completed by another provider. If disposable summarization fails, fall back to bounded transcript context.

During these pre-token phases, bridges emit transient `status` events so the renderer can explain why the composer is waiting (for example, summarizing a handoff, replaying saved history, resuming a provider session, or starting the provider runtime). These statuses are UI-only and must not be persisted as chat messages.

Manual `/compact` follows the same transparency rule: create a disposable summary session from a bounded transcript, display the generated summary in chat, replace local replay history with the summary, clear native resume state, and let the next prompt start fresh from that summary.

## Local history replay fallback

For native-resume providers (`claude`, `pi`, `opencode`, `codex`, `hermes`, `crewcoder`), CrewCode injects local `<conversation_history>` only as a fallback on the next prompt when local transcript history exists, no provider-native resume id is available (or native resume reports failure), and that provider/thread replay has not already happened in this app run. Provider handoff prompts use the separate handoff summary path instead of literal replay.

CrewCoder restores sessions with ACP `session/load`. Its provider replay contains only user/assistant text, so CrewCode suppresses that replay when the richer local transcript exists. See [crewcoder-provider.md](./crewcoder-provider.md).

Claude normally avoids this fallback when a saved Claude session id exists, because its SDK `options.resume` path is preferred.

## Claude SDK settings and native skills

Claude bridge turns omit `skills` and `settingSources`. That is Claude CLI default behavior: user, project, and local settings load, and native skill discovery follows Claude — including `~/.claude`. Do not pass `skills: []` (hides the library) or `settingSources: []` (drops `CLAUDE.md` and other filesystem settings) unless CrewCode injects equivalent repo guidance itself.

CrewCode's own `.crewcode` skill flow stays separate: selected skill bodies are injected by the composer/session path only when the user applies them.

A large global skill library still costs context on every turn. Inspect `contextBreakdown` if occupancy spikes after this path is enabled.

## Claude context meter source of truth

Claude's SDK `getContextUsage()` is the source of truth for the context pill when available. Its `totalTokens` is the current context-window usage, and `maxTokens` is the effective active window for the selected model. `rawMaxTokens` is fallback capacity metadata. The SDK result `usage` object (`input_tokens`, `output_tokens`, cache fields) is billing/request accounting and should only drive the pill when `getContextUsage()` is unavailable.

If the used-token count looks surprisingly high, inspect `contextBreakdown`/"What's using it" rather than replacing `totalTokens` with request billing tokens. CrewCode surfaces reconciliation rows (`sdk:totalTokens`, `sdk:active category sum`, `sdk:deferred category sum`, `sdk:maxTokens`, `sdk:rawMaxTokens`) plus detailed contributors (`mcpTools`, `systemTools`, `systemPromptSections`, `memoryFiles`, `slashCommands`, `skills`, `messageBreakdown`, attachments, and API usage) so spikes can be tied to a concrete source. Large `tools`, `system`, `mcp`, `skills`, or attachment categories mean Claude Code really loaded that context.

`categories` is **not** a usage list — it is the /context grid's row model, so
Claude appends synthetic capacity rows (`Free space`, and `Autocompact buffer` /
`Compact buffer`) sized so every non-deferred category sums to exactly
`maxTokens`. Summing them made the meter report `1,000,000 used of 1,000,000`
after a single prompt. `claudeCategoryTokenSums` must skip those names, and they
render in the breakdown flagged as `(unused headroom)` reserved rows.

`totalTokens` can also exceed `maxTokens`: Claude derives it from cumulative API
usage, which double-counts cache reads across a resumed thread. Live context
physically cannot exceed the window, so `activeClaudeContextTokens` caps the
reading at `maxTokens` instead of rendering >=100%.

Claude SDK context reports are authoritative absolute snapshots, so do not apply the generic "never decrease from the persisted baseline" resume floor to them. A stale persisted `1,000,000 / 1,000,000` snapshot must be allowed to drop to the next SDK-reported value, or the first visible turn after a bad snapshot stays pinned at 100%.

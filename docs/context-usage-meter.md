# Context usage meter

The chat meter divides the latest observed context occupancy by the active
context window. The numerator is the provider's current prompt/context size,
not cumulative billing tokens for the entire conversation.

The chat header **Context** button opens the session context management sidebar
directly (also available in the mobile Actions menu). Close it with the close
button, backdrop, or Escape; switching sessions closes the panel. It follows the
newest reported usage snapshot, including cleared occupancy after compaction,
and stays available before the first reading with an explicit empty state.
Opening the panel makes no extra provider requests; the Codex policy read below
happens once at bridge startup.

Token-log rows use decorative icons from the shared icon set beside their text
labels, including nested contributors and compaction policy rows. Token values
use compact k/M suffixes throughout the sidebar; hover or assistive text retains
the exact count. Percentages and contributor item counts retain their own units.

The panel shows reported occupancy, a usage bar, category token counts and
percentages of the full window. Expand MCP tools, system tools/prompt, memory
files, agents, skills, message details, attachments, and provider diagnostics when
reported. Detail rows and billing counters never become additive occupancy;
reserved/headroom/deferred rows have no active percentage. Providers without
categories show observed token counters and explain the missing breakdown.

Clicking the context pill opens a compact usage summary. When the provider
supplies token details, **Token logs** opens a scrollable right sidebar. The
sidebar can be closed with its close button, the backdrop, or Escape. Claude
provides context categories; Codex, OpenCode, and Grok provide request or turn
token counters, while CrewCoder provides session counters and its latest context
input reading. These rows can overlap and must not be added together.
If a provider reports token counts before a context window is known, the usage
strip shows a direct **Token logs** button and the sidebar marks context usage
as unavailable instead of showing a fabricated percentage.

Codex token logs show the latest app-server request's input and output, plus
cached input and reasoning output when reported. OpenCode logs show its latest
assistant message's input, output, reasoning, cache read, and cache write
counts. Grok logs show latest-call input/output and, when present, cache read,
reasoning, and cumulative turn input/output. These providers do not expose
Claude-style system/tool/message context categories through these usage events;
the sidebar labels their rows as provider token counts rather than claiming
they sum to context occupancy.

CrewCoder token logs use the ACP `session/prompt` result's namespaced
`crewcoder/usage` summary, falling back to its top-level `usage` mirror. They
show the latest context input (`lastInputTokens`) separately from cumulative
session input, output, total, cached input, cache write, and reasoning counts
when those fields are reported. The session counters can span multiple models
and requests and do not sum to the current context reading. If CrewCoder omits
`lastInputTokens`, cumulative session totals remain visible in Token logs but
do not become a context occupancy estimate.

## Window sources

Use these sources in order:

1. A full window reported for the active session or turn by the provider bridge.
2. A full window from the provider's model catalog, when it supplies one.
3. A static model-family fallback, when no provider value is available.

Claude fallback matching accepts both hyphenated provider ids (such as
`claude-opus-4-8`) and dotted versions/display names (`Claude Opus 4.8`).

Codex app-server usage notifications include `modelContextWindow`. For known
models, this can be smaller than the model's full window because it is the
effective request prompt budget. CrewCode shows the known full model capacity
as the meter denominator and labels the reported smaller value separately as
**Codex prompt budget**. For unknown models, the reported value remains the
only available window and drives the meter. A reported value larger than model
metadata also takes precedence. The full model window can come from provider
catalog metadata or CrewCode's static model fallback; the latter can be stale
if a custom Codex configuration changes capacity. Compaction-drop inference
uses Codex's reported prompt budget as its threshold denominator even when the
displayed model window is larger.
The latest request's input tokens are also treated as an authoritative context
reading, so a decrease after native compaction is not replaced by an old floor.
The app-server `model/list` response discovers models but does not document a
context-window field, so model discovery alone cannot supply the Codex meter.

Claude's SDK `getContextUsage()` supplies the active `maxTokens` (or
`rawMaxTokens`) window. The meter sums its active categories and excludes
deferred categories, unused space, and compaction headroom using each SDK row's
`kind`, with legacy category handling for older Claude binaries. CrewCode
requests `detail: 'full'`, since `summary` uses local estimates rather than
the token-counted `/context` breakdown. The categorized SDK reading is the
source of occupancy; result-message billing usage is separate and aggregates
multiple requests. The static model table can
still supply a window but cannot supply occupancy. Claude's `--help` does not
provide a model-window catalog.

CrewCode asks `getContextUsage()` after each assembled assistant message while
the SDK query is active. It retries at the result only if no valid reading has
arrived, because a result-time call can race query shutdown and a full reading
can involve token-counting API requests. If no control reading succeeds for that turn, the latest
individual assistant message's input and cache token counts provide a bounded
request-context fallback. Only when neither current-turn source exists does
CrewCode reuse an earlier measured reading; with no reading at all, the meter
stays unknown. Result-message usage remains billing-only because it aggregates
multiple requests in one turn.

CrewCoder ACP usage can also include a live `contextWindow` and
`lastInputTokens`; its bridge passes those through to the meter. Providers
that report no usable window can show no percentage if no catalog or static
fallback exists. A fallback percentage is an estimate, not a provider reading.

The latest usage snapshot is persisted for resumed chats. A new provider
report replaces its window; occupancy normalization and compaction handling
are described in [Conversation storage](conversation-storage.md).

## Provider compaction policy and /compact

The sidebar separates the provider's compaction policy from occupancy and prompt
budget. Codex reads its effective workspace configuration through a bounded,
read-only app-server config/read request at bridge creation. An explicit positive
model_auto_compact_token_limit is labeled as a configured threshold; its counting
scope is shown as full context or growth after the compacted prefix. An unset
model default, an unsupported read, or a timeout stays unknown. The sidebar does
not derive a compaction trigger from the prompt budget or a warning percentage.
Configuration evidence is a startup snapshot, not a live countdown.

Claude exposes the resolved autoCompactEnabled value used by the bridge. Its SDK
does not currently supply a numeric trigger through this integration. CrewCoder
owns its persisted autoCompact policy; its current ACP usage contract does not
report a numeric trigger or enabled setting. Both show unknown fields explicitly.
The latest matching provider compaction event supplies manual/automatic status,
including started, completed, failed/interrupted, or an explicitly inferred drop.
CrewCode does not introduce a second automatic compactor.

Typed and picked /compact commands use the same native provider path on desktop
and Brain/browser: Codex thread/compact/start, Claude /compact through the SDK,
and CrewCoder's advertised session/compact extension. These paths preserve the
provider session instead of replacing it with a separate CrewCode summary.
Codex waits for the native boundary, not the RPC acknowledgement. Claude requires
a compact_boundary before reporting success. Stop during startup cancels dispatch
and retry; concurrent turns/compaction are refused. A Codex manual-operation
completion timeout fails and stops the owned process, without retrying or claiming
success. Existing unsupported/fallback behavior remains for older providers.

Successful native boundaries invalidate old occupancy. A fresh post-boundary
reading is retained even if it arrives before the manual RPC returns. Policy
metadata survives renderer occupancy invalidation; no zero usage is fabricated.

## Automatic compaction

Claude's `compact_boundary`, Codex app-server's `contextCompaction` completion,
CrewCoder's `_crewcoder/compaction_update`, and OpenCode's matching
`session.compacted` SSE event are native completion signals. They clear the
previous context reading in the main process, its persisted snapshot, and the
latest visible usage strip. The meter remains unknown until a new provider
usage reading arrives; a pre-compaction reading must not be replayed at turn
end. Historical provider token counters remain in Token logs, while old
Claude context categories are cleared. OpenCode's event is accepted only for
the active session.

When no native boundary is observed, a high-occupancy to large-drop usage
reading can detect compaction for Codex, CrewCoder, OpenCode, and Grok. The
smaller observed reading becomes the new context baseline. Providers without
an observed boundary or trustworthy absolute context reading are not inferred
from silence or a completed turn.

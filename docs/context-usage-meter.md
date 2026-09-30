# Context usage meter

The chat meter divides the latest observed context occupancy by the active
context window. The numerator is the provider's current prompt/context size,
not cumulative billing tokens for the entire conversation.

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

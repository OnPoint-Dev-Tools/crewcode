# Agent conversation storage

CrewCode stores replayable agent conversation history as per-session files under Electron `userData`:

```txt
~/.config/crewcode/conversations/
  agent-conversations.<stable-session-digest>.json
```

Each file contains one conversation using the same wrapper shape as the legacy monolith, but with only one session key:

```json
{
  "conversations": {
    "workspace-tab-agent conversation key": [
      { "role": "user", "content": "..." },
      { "role": "assistant", "content": "..." }
    ]
  }
}
```

Older shards written as `{ "sessionId": "...", "messages": [...] }` are still readable and are rewritten to the legacy wrapper shape on load.

The legacy monolithic file remains supported for migration:

```txt
~/.config/crewcode/agent-conversations.json
```

On first access, CrewCode copies legacy entries into sharded files and writes `conversations/.agent-conversations-migrated`. The legacy file is left in place as a backup, but new saves use only the per-session files.

If a sharded file is missing or unreadable, CrewCode can lazily recover that session from the legacy monolith. Explicitly cleared sessions are recorded in `conversations/.agent-conversations-cleared.json` so legacy fallback does not resurrect deleted conversations.

## Session ids and the context-meter baseline

`src/main/agents/sessionStore.ts` persists per-session bridge state under `userData/agent-sessions.json`, keyed by the `tabId:agentId` composite the renderer uses for bridge registration:

```json
{
  "sessions": { "tab:agent": "<upstream session id>" },
  "usage":    { "tab:agent": { "contextTokens": 42000, "contextWindow": 200000, "model": "claude" } }
}
```

- **`sessions`** — the upstream/provider-native resume id, written as soon as a bridge reports one so a crash mid-conversation still leaves a resumable session behind.
- **`usage`** — a minimal snapshot of the last known context usage. The context meter is rendered per agent bubble from `usage.contextTokens / usage.contextWindow`, and the running floor that keeps that number monotonic (`entry.lastUsage`, applied by `normalizeContextUsage`) is otherwise **in-memory only**. Without this snapshot a resumed session has no baseline, so the first new turn reports a tiny per-turn count and the meter collapses to ~0 even though the conversation context is unchanged. On `bridge:start` the entry seeds `lastUsage` from this snapshot; every `turn_end`/`usage_update` writes it back. This is provider-agnostic — it fixes the resume reset for Claude, Codex, OpenCode, pi, Ollama, OpenRouter, Hermes, and CrewCoder alike.

  > `contextTokens` is an **absolute/cumulative** measure (each turn's `input` re-sends the whole conversation). When a turn under-reports it (a dip below the prior baseline — common on the first resumed turn), `normalizeContextUsage` holds the baseline and adds only the new **output** tokens. It must **never** add `input`, or the re-sent history double-counts and the meter balloons (~35% → ~65% on the first resumed reply). The result is also capped at `contextWindow`.

Both maps are cleared together when a session is explicitly reset (`bridge:resetSession` → `clearSessionId`), so a deliberate new session starts the meter fresh.

## Manual `/compact` support per provider

`/compact` is intercepted in `useComposerSend` and routed to the `bridge:compact` IPC (it is **not** sent as a normal prompt). The handler picks a strategy via `compactionStrategy()` and only the `unsupported` case returns `{ ok: false, unsupported: true }` (UI shows a "doesn't support /compact yet" notice) rather than letting the agent answer the literal string `/compact`.

| Provider | Strategy | Mechanism |
| --- | --- | --- |
| **codex** | `native` | ACP `thread/compact/start` |
| **opencode** | `native` | `POST /session/:id/summarize` (server-side) |
| **claude** | `native` | `/compact` slash command via the Agent SDK → `compact_boundary` event |
| **plugins** | `native` | plugin bridge `compact()` (local summary prompt) |
| **ollama / openrouter** (HTTP_ONLY) | `local-summary` | `LOCAL_COMPACT_PROMPT` + `compactLocalConversation` replaces our owned replay history |
| **pi / hermes / CrewCoder** | `summary-reset` | no native RPC → the agent summarizes its own live context, then we seed a fresh session with it (below) |
| _any provider with no thread/conversation key_ | `unsupported` | nowhere to persist a summary; reported instead of faked |

### `summary-reset` flow (pi / hermes / CrewCoder)

Native-session providers keep their context server-side and expose no compaction RPC, so we cannot shrink it directly. Instead:

1. **`bridge:compact`** sends `SUMMARY_RESET_PROMPT` (the structured GOALS / KEY DECISIONS / PROGRESS / OPEN QUESTIONS / NEXT STEPS template) as a normal turn while the provider still holds the **full live context**, and sets `entry.pendingSummaryReset`. The prompt is pushed onto `pendingPromptTexts` so the turn is recorded into the replay shard. The summary streams back as a **visible** agent bubble.
2. On that turn's **`turn_end`** (summary already recorded), the handler: `compactLocalConversation()` collapses the replay shard to `[continue, summary]`; `clearSessionId()` drops the upstream resume id (and its usage snapshot); the replay marker is deleted; `entry.lastUsage` is cleared.
3. The bridge is torn down via the **idle-stop path** (`idle_stopped` → renderer drops its keys silently, no "agent exited" noise). Teardown + the `completed` event are deferred to a `queueMicrotask` so ordering stays `turn_end → completed → idle_stopped` and the bridge is never stopped re-entrantly from inside its own event.
4. The **next prompt** calls `bridge:start` with no resume id but local history present → `injectHistoryOnNextPrompt` re-arms → the summary is injected as `<conversation_history>` into a fresh, small upstream session.

> History note: previously every provider without a native `compact()` fell through to `prompt('/compact')`. Codex/HTTP-only/plugins worked, but pi/hermes/opencode/claude received the literal string `/compact`, which the agent simply answered. opencode and claude now compact natively; pi/hermes/CrewCoder use summary-reset.

## Visible chat transcripts (separate from replay history)

The rich UI thread (the full renderer `Message[]` — user/agent/thinking/toolcall/system bubbles with timestamps, turn ids, tool-call state) is **not** the same as the agent replay history above. Replay shards store only `{ role, content }` for rebuilding model context; transcripts store everything the chat surface renders. The transcript is persisted in two layers:

### L2 — on-disk transcript store (authoritative, unbounded)

`src/main/transcript-store.ts` writes one file per scope under Electron `userData`:

```txt
~/.config/crewcode/transcripts/
  transcript.<scope-digest>.json   →   { "scopeId": "...", "messages": [ ...full Message[]... ] }
```

Messages are stored opaquely — the main process never inspects their shape, so the renderer `Message` type stays renderer-only. IPC surface: `transcripts:loadAll`, `transcripts:save`, `transcripts:remove`, and a **synchronous** `transcripts:saveSyncBatch` used only on window teardown (an async `invoke` can be dropped before the renderer dies, so the last turn is written synchronously).

### L1 — `crewcode:messagesByTab` localStorage (bounded fast-paint cache)

`src/renderer/src/stores/chat-messages-store.ts` keeps a synchronous localStorage copy so the transcript paints instantly on launch. localStorage has a hard ~5MB per-origin quota; the cache therefore caps each scope's tail (`MAX_PERSISTED_MESSAGES_PER_SCOPE`) and, on `QuotaExceededError`, evicts the least-recently-touched scopes so the newest conversation always wins the remaining space.

> **History note:** the original bug was `persist()` silently swallowing `QuotaExceededError`. Once the unbounded map crossed the quota, every new turn's write failed silently — old conversations (already on disk) survived, new ones vanished on restart. Do not reintroduce a silent quota catch, and do not treat localStorage as the source of truth.

### How the layers interact

- **Launch:** L1 paints from localStorage immediately; the store then hydrates from L2 (`transcripts:loadAll`), backfilling any scope L1 evicted and restoring full history for scopes L1 trimmed. Hydration never clobbers an in-memory scope that is already longer (a turn that arrived during the async load wins).
- **Writes:** L2 disk is authoritative and writes changed scopes promptly (settled/structural changes immediately; in-progress token deltas debounced). L1 localStorage is only a fast-paint cache and is refreshed during idle/debounce/teardown so large `JSON.stringify` work does not block composer typing or sidebar interactions. Both layers flush on `pagehide`/`beforeunload`/hidden visibility (L2 via the synchronous batch).
- **Deletion:** explicit session deletion (`removeSession`) calls `transcripts:remove` so a deleted thread doesn't resurrect from L2. The startup reconciliation prune deliberately does **not** delete disk files.

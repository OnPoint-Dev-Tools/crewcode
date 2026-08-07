# Execution Modes

CrewCode's composer mode (`ModeLevel`) is a per-session gate with two halves:

1. **An optional prompt preamble** injected once at session start
   (`buildModePreamble` in `src/renderer/src/hooks/chat-session-send.ts`).
2. **A real permission policy** applied per provider inside each bridge.

The preamble is advisory; the bridge policy is the enforcement. Users edit mode
prompt defaults under **Settings → Mode Prompts** and enable or disable injection
per Solo Chat from its header. Neither action changes the selected mode or its
provider permission policy.

## The four modes

| Mode (wire) | Label | Claude | Codex | ACP / pi / hermes / CrewCoder | Intent |
|---|---|---|---|---|---|
| `ask` | Ask | `default` + read-only disallow list | `read-only` sandbox, `untrusted` | permission requests declined | Answers only |
| `plan` | Plan | `default` + read-only disallow list **+ `ExitPlanMode`** | `read-only` sandbox, `untrusted` | permission requests declined | Plan; user switches to Build |
| `build` | Build | `default` (user approves tools) | `workspace-write`, `on-request` | permission overlay shown | Careful implementation |
| `full` | **Full Access** | `bypassPermissions` | `workspace-write`, `never` | auto-accept | Every tool pre-approved |

## Naming: wire value and legacy migration

The persisted `ModeLevel` value is **`'full'`**; it was renamed from `'yolo'`.
The display token is `'Full'` (a single word — it doubles as the `mode-full` CSS
class suffix and the picker item id) and the human label is `'Full Access'`, via
`MODE_LABEL` in `ModeSegment.tsx`.

Because the wire value changed, **saved sessions and the persisted `defaultMode`
can still contain `'yolo'`**. An unrecognized level is not harmless:
`MODE_FROM_SETTINGS[level]` returns `undefined`, which crashes the composer's
mode picker on its `MODE_META` lookup, and `buildModePreamble` would prepend a
literal `"undefined"` to the outgoing prompt. Every read of a persisted mode goes
through `normalizeModeLevel()` in `app-constants.ts`, which maps `yolo -> full`
and anything unknown to `build`:

- `migratePersistedSessions()` (localStorage session load) and `freshSession()`
- `App.tsx` — `sessionModeLevel` and the per-tab `tabComposerMode`
- `ChatPane` — `modeLevel`

Do not read `session.mode` or `settings.defaultMode` raw. Keep the legacy entry
in `LEGACY_MODE_LEVELS` until you are willing to reset users' saved modes.

## Configurable mode prompts

`SettingsState.modePrompts` stores the shared `ask`, `plan`, `build`, and `full`
strings. `Session.modePromptsEnabled` controls injection for one chat, defaults
to true for new and legacy sessions, and is copied when a session is duplicated.

- The normal `ChatHeader` renders on fresh Solo Chats so enablement can be chosen
  before the first send. The toggle locks after visible history or the delivery
  marker proves startup context was committed; provider context cannot be revoked.
- Prompt edits apply only when a session has not sent its startup context.
  Existing/restored sessions must not receive the prompt again.
- Disabled mode prompts leave provider-native/default system context in place.
  Skills, attachments, handoff packets, and delegation context still use their
  normal send paths.
- Prompt text is trimmed at the end and separated from the user message. An
  empty or whitespace-only string suppresses the CrewCode preamble for that mode.
- The selected `ModeLevel` must still reach bridge startup and live mode updates.
  Never use `modePromptsEnabled` to bypass or weaken provider tool policy.

## Build approval scope

Build permission cards offer **allow**, **deny**, and—when main marks the
request eligible—**allow all (this turn ONLY)**. The latter approves the current tool
and subsequent permission requests only for the same `{bridgeId, turnId}`.
Normal Build approvals resume on the next turn.

- Eligibility is main-issued only for writable Build permission requests with a
  provider turn ID. Provider-supplied capability flags are stripped.
- Enforcement lives in both Electron's bridge registry and the transport-neutral
  `AgentBridgeService`, so every approval surface and remote client behaves the
  same way.
- Grants clear on `turn_end`, a new `turn_start`, error/close, abort, stop, bridge
  replacement, and application teardown.
- Do not map this action to provider-native remembered permission choices. Those
  may outlive the turn and bypass later composer-mode changes.
- Ask/Plan read-only policy and Full Access behavior are unchanged.

## Full Access behavior

The user has pre-granted every tool, so the agent must never emit a permission or
confirmation request.

- **Claude**: `bypassPermissions` + `allowDangerouslySkipPermissions`. The
  `canUseTool` fallback also auto-allows, which matters when the mode is switched
  on an already-running bridge.
- **Codex**: `workspace-write` sandbox with `approvalPolicy: 'never'` — tools are
  auto-approved but writes stay inside the workspace. Full Access deliberately
  does **not** use `danger-full-access`; worktree isolation is the point of
  CrewCode.
- **pi / hermes / CrewCoder**: confirmation and `session/request_permission`
  requests are auto-accepted. CrewCoder exposes only once-only choices because
  its remembered decisions would bypass later live mode changes.
- **opencode / ollama / openrouter**: prompt-level preamble only (no CrewCode-side
  permission gate to relax).

### Invariants

- `toolPolicy: 'read-only'` **always wins over the mode**. Supervisor bridges and
  editor-completion bridges start read-only, so Full Access can never give a
  supervisor or ghost-text completion write/exec tools.
- `AskUserQuestion` is not a permission gate. Full Access must still surface real
  questions — blanket tool access is not blanket scope.
- Renaming or adding a mode means touching the `ModeLevel` unions
  (`src/renderer/src/types/index.ts`, `src/main/agents/bridge-types.ts`,
  `src/preload/index.ts`), the label maps in `app-constants.ts` /
  `ModeSegment.tsx` / `Composer.tsx` (cycle order) / `useMissionData.ts`, the
  Settings default-mode segment, the `mode-*` CSS classes, and every bridge's mode
  switch. The `Record<ModeLevel, …>` maps make most of these compiler-enforced.

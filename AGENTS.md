# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.
- Challenge me and push back and play devils advocate when i want to add implement something that has risks or for a new feature.

This file provides guidance to models when working with code in this repository.

<!-- rtk-instructions v2 -->
# RTK (Rust Token Killer) - Token-Optimized Commands

## Golden Rule

**Always prefix commands with `rtk`**. If RTK has a dedicated filter, it uses it. If not, it passes through unchanged. This means RTK is always safe to use.

**Important**: Even in command chains with `&&`, use `rtk`:

```bash
# ❌ Wrong
git add . && git commit -m "msg" && git push

# ✅ Correct
rtk git add . && rtk git commit -m "msg" && rtk git push
```

## RTK Commands by Workflow

### Build & Compile (80-90% savings)

```bash
rtk cargo build         # Cargo build output
rtk cargo check         # Cargo check output
rtk cargo clippy        # Clippy warnings grouped by file (80%)
rtk tsc                 # TypeScript errors grouped by file/code (83%)
rtk lint                # ESLint/Biome violations grouped (84%)
rtk prettier --check    # Files needing format only (70%)
rtk next build          # Next.js build with route metrics (87%)
```

### Test (90-99% savings)

```bash
rtk cargo test          # Cargo test failures only (90%)
rtk vitest run          # Vitest failures only (99.5%)
rtk playwright test     # Playwright failures only (94%)
rtk test <cmd>          # Generic test wrapper - failures only
```

### Git (59-80% savings)

```bash
rtk git status          # Compact status
rtk git log             # Compact log (works with all git flags)
rtk git diff            # Compact diff (80%)
rtk git show            # Compact show (80%)
rtk git add             # Ultra-compact confirmations (59%)
rtk git commit          # Ultra-compact confirmations (59%)
rtk git push            # Ultra-compact confirmations
rtk git pull            # Ultra-compact confirmations
rtk git branch          # Compact branch list
rtk git fetch           # Compact fetch
rtk git stash           # Compact stash
rtk git worktree        # Compact worktree
```

Note: Git passthrough works for ALL subcommands, even those not explicitly listed.

### GitHub (26-87% savings)

```bash
rtk gh pr view <num>    # Compact PR view (87%)
rtk gh pr checks        # Compact PR checks (79%)
rtk gh run list         # Compact workflow runs (82%)
rtk gh issue list       # Compact issue list (80%)
rtk gh api              # Compact API responses (26%)
```

### JavaScript/TypeScript Tooling (70-90% savings)

```bash
rtk pnpm list           # Compact dependency tree (70%)
rtk pnpm outdated       # Compact outdated packages (80%)
rtk pnpm install        # Compact install output (90%)
rtk npm run <script>    # Compact npm script output
rtk npx <cmd>           # Compact npx command output
rtk prisma              # Prisma without ASCII art (88%)
```

### Files & Search (60-75% savings)

```bash
rtk ls <path>           # Tree format, compact (65%)
rtk read <file>         # Code reading with filtering (60%)
rtk grep <pattern>      # Search grouped by file (75%)
rtk find <pattern>      # Find grouped by directory (70%)
```

### Analysis & Debug (70-90% savings)

```bash
rtk err <cmd>           # Filter errors only from any command
rtk log <file>          # Deduplicated logs with counts
rtk json <file>         # JSON structure without values
rtk deps                # Dependency overview
rtk env                 # Environment variables compact
rtk summary <cmd>       # Smart summary of command output
rtk diff                # Ultra-compact diffs
```

### Infrastructure (85% savings)

```bash
rtk docker ps           # Compact container list
rtk docker images       # Compact image list
rtk docker logs <c>     # Deduplicated logs
rtk kubectl get         # Compact resource list
rtk kubectl logs        # Deduplicated pod logs
```

### Network (65-70% savings)

```bash
rtk curl <url>          # Compact HTTP responses (70%)
rtk wget <url>          # Compact download output (65%)
```

### Meta Commands

```bash
rtk gain                # View token savings statistics
rtk gain --history      # View command history with savings
rtk discover            # Analyze Claude Code sessions for missed RTK usage
rtk proxy <cmd>         # Run command without filtering (for debugging)
rtk init                # Add RTK instructions to CLAUDE.md
rtk init --global       # Add RTK to ~/.claude/CLAUDE.md
```

## Token Savings Overview

| Category | Commands | Typical Savings |
|----------|----------|-----------------|
| Tests | vitest, playwright, cargo test | 90-99% |
| Build | next, tsc, lint, prettier | 70-87% |
| Git | status, log, diff, add, commit | 59-80% |
| GitHub | gh pr, gh run, gh issue | 26-87% |
| Package Managers | pnpm, npm, npx | 70-90% |
| Files | ls, read, grep, find | 60-75% |
| Infrastructure | docker, kubectl | 85% |
| Network | curl, wget | 65-70% |

Overall average: **60-90% token reduction** on common development operations.
<!-- /rtk-instructions -->

## GOLDEN RULE: Docs & AGENTS.md

Update corresponding Docs in [CrewCode Docs](/docs/), and [AGENTS.md](/AGENTS.md/) when major changes were made and or every time i add a feature. Create or update docs file for it

## What is CrewCode?

- Challenge me and push back and play devils advocate when i want to add implement something that has risks or for a new feature.

CrewCode is a desktop ACE (Agent Coding Environment) built with Electron + React + TypeScript. It lets developers run a *crew* of AI coding agents (Claude Code, Codex, OpenCode, etc.) in parallel across local git worktrees, each in its own workspace with a chat thread, embedded terminal panes, and a code/markdown editor — all in one frameless native-feeling window.

## Commands

```bash
npm run dev        # Start dev server (Vite renderer at localhost:5173) + Electron main process
npm run build      # Build all three processes (main, preload, renderer) via electron-vite
npm run preview    # Preview the production build
npm run typecheck  # Run tsc --noEmit across all tsconfigs
npm run ship -- "feat: msg"  # Stage + commit + push current branch to origin
npm run release    # Verify, bump patch version, tag, push -> triggers CI release build
```

> `npm run dev` uses `env -u ELECTRON_RUN_AS_NODE` to prevent Electron's Node.js mode from interfering.

## Releasing

`npm run ship` pushes day-to-day work; `npm run release` bumps + tags, and the
`v*` tag triggers `.github/workflows/release.yml` to build linux/win/mac into a
**draft** GitHub Release that you publish manually. `build.publish` in
`package.json` must always match the repo you actually release to, or the
in-app `electron-updater` polls an empty feed and silently reports
"not-available" forever.

Release channels are `stable` and `nightly` only, and the difference is
prerelease visibility (`autoUpdater.allowPrerelease`), not electron-builder
named channels — a named channel would need its own `<channel>.yml` feed per
train. Settings live in renderer localStorage with no main-side store, so
channel and auto-download reach main only through `updater:configure`; main
defaults to stable with auto-download off until the renderer reports otherwise.
The renderer exposes one **Automatic updates** policy (`manual`/`download`/
`automatic`) that expands via `updatePolicyToConfig` into main's two independent
flags (`autoDownload`, `autoInstallOnAppQuit`) — one enum instead of two booleans
because manual-download + auto-install is nonsensical. `download` = fetch in the
background but stay staged until the user restarts. Both flags default true in
main on absent/malformed input so a bad message can't strand a downloaded update
as never-installing.
Version and build hash must come from `app:buildInfo`, never a hardcoded string
in the UI. See `docs/releasing.md`.

## Architecture

This is a standard **electron-vite** three-process project:

| Process      | Entry                  | Purpose                                                                            |
| ------------ | ---------------------- | ---------------------------------------------------------------------------------- |
| **Main**     | `src/main/index.ts`    | Creates `BrowserWindow`, handles IPC for window controls (minimize/maximize/close) |
| **Preload**  | `src/preload/index.ts` | Exposes `window.electronAPI` to renderer via `contextBridge`                       |
| **Renderer** | `src/renderer/src/`    | React SPA — the entire UI                                                          |

Built output lands in `out/` (gitignored). In dev, the renderer runs at `ELECTRON_RENDERER_URL` (Vite dev server); in production it loads `out/renderer/index.html`.

### Renderer structure

```
src/renderer/src/
├── App.tsx               # Root — all top-level state lives here
├── main.tsx              # React entry point
├── types/index.ts        # All shared types (Tab, Message, Workspace, TermSession, etc.)
├── hooks/
│   └── useTweaks.ts      # Generic key-value state hook for TweakConfig
├── data/                 # Static mock data (workspaces, termSessions, codeFiles, commands)
├── styles/
│   ├── colors_and_type.css  # Full CSS token set — imported globally
│   └── styles.css           # Layout and component styles
└── components/
    ├── ui/               # WindowTabs, Icon, StatusPill
    ├── thread/           # ChatHeader, Messages, Sessions, WorkLog
    ├── composer/         # Composer, ModelRow, ModeSegment
    ├── terminal/         # TermColumn, TermPane
    ├── editor/           # CodeEditor, FileTree, MarkdownEditor
    ├── workspaces/       # WorkspacesDrawer, WorkspaceDock, WorkspaceRow
    ├── CommandPalette.tsx
    └── TweaksPanel.tsx
```

`App.tsx` owns all state and passes it down. There is no global state manager — everything is React `useState`.

## Code Comments: Document the "Why", Briefly

When writing or modifying code driven by a design doc or non-obvious constraint, add a comment explaining **why** the code behaves the way it does.

Keep comments short — one or two lines. Capture only the non-obvious reason (safety constraint, compatibility shim, design-doc rule). Don't restate what the code does, narrate the mechanism, cite design-doc sections verbatim, or explain adjacent API choices unless they're the point.

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero information and tend to become dumping grounds. Name files after what they *actually* contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

## Worktree Safety

Always use the primary working directory (the worktree) for all file reads and edits. Never follow absolute paths from subagent results that point to the main repo.

## Cross-Platform Support

Orca targets macOS, Linux, and Windows. Keep all platform-dependent behavior behind runtime checks:

- **Keyboard shortcuts**: Never hardcode `e.metaKey`. Use a platform check (`navigator.userAgent.includes('Mac')`) to pick `metaKey` on Mac and `ctrlKey` on Linux/Windows. Electron menu accelerators should use `CmdOrCtrl`.
- **Shortcut labels in UI**: Display `⌘` / `⇧` on Mac and `Ctrl+` / `Shift+` on other platforms.
- **File paths**: Use `path.join` or Electron/Node path utilities — never assume `/` or `\`.

## SSH Use Case

All changes must consider the SSH use case. Don't assume local-only execution. See `docs/remote-ssh-workspaces.md` for the user-facing behavior contract (ssh:// roots, agent-first auth, TOFU host pinning, remote LSP/polling constraints).

## GitHub CLI Usage

Be mindful of the user's `gh` CLI API rate limit — batch requests where possible and avoid unnecessary calls. All code, commands, and scripts must be compatible with macOS, Linux, and Windows.

## Type Declarations: Prefer `.ts` Over `.d.ts`

Project-owned type declarations belong in `.ts` files. `.d.ts` is reserved for ambient shims (e.g., `env.d.ts`, `vite/client.d.ts`). TypeScript's `skipLibCheck: true` setting applies globally, including to our own `.d.ts` files, which means any unresolved type reference in a `.d.ts` silently becomes `any` at its call sites. Write your types in `.ts` files so the compiler actually checks them. CI enforces this for `src/preload/` and `src/shared/` — see `docs/preload-typecheck-hole.md`.

### Client and transport boundary

The shared React renderer is being prepared for desktop and browser clients. New renderer code must obtain privileged operations through the typed CrewCode client boundary in `src/renderer/src/runtime/crewcode-client.ts`; do not introduce transport-specific HTTP/WebSocket calls in components. Electron currently installs `window.electronAPI` as that client. The future web adapter will implement the same contract over authenticated, versioned HTTP/WebSocket RPC. Protocol envelopes live in `src/shared/remote-access-types.ts`; see `docs/web-remote-access.md`.

### Path alias

`@renderer/*` → `src/renderer/src/*` (configured in both `electron.vite.config.ts` and `tsconfig.web.json`).

## Design system

The design system lives in `.design/crewcode-design-system/`. The canonical CSS tokens are in `src/renderer/src/styles/colors_and_type.css`.

**Hard rules:**

- Background: `#0f120f` (dark), never pure black
- Borders: 1px solid `#1c2f2f` hairline — always, never shadows
- Fonts: Inter (sans) + JetBrains Mono (mono only). Technical strings (paths, branches, model names, status pills) use mono
- Accent: `#285a48` evergreen — only one accent color
- Voice: no emoji

Use `/crewcode-design` skill when building new UI surfaces — it provides the full token set, assets, and UI kit components.

## TypeScript config

Three tsconfigs compose via project references:

- `tsconfig.json` — root references only
- `tsconfig.node.json` — main + preload processes
- `tsconfig.web.json` — renderer (`strict: true`, `jsx: react-jsx`)

## Current state

Real agent integration is wired through normalized bridges (pi, OpenCode, Claude, Codex, Hermes, CrewCoder, Ollama, and OpenRouter) with PTY panes remaining available for terminals.

Workspaces, worktrees, git operations, terminals, settings, and crew sessions are all real and persisted (workspaces + tabs to disk, messages to localStorage).

CrewCoder is a first-class ACP provider implemented separately in `crewcoder-bridge.ts`; CrewCode is the client and spawns `crewcoder acp --approval review`. Keep Hermes untouched. CrewCoder is native-resume, discovers `provider:model` choices through `session/new`, maps namespaced usage `lastInputTokens` to live context occupancy, and uses once-only permission choices so remembered agent decisions cannot bypass later composer-mode changes. Its prompt watchdog measures ACP inactivity, not total turn duration, and pauses while Build permission is awaiting user input; a genuine timeout must send `session/cancel` before CrewCode ends the turn so another prompt cannot overlap live CrewCoder work. CrewCoder ACP must respect CrewCoder's persisted `autoCompact` setting; CrewCode must not force compaction or retry context-window failures for CrewCoder, Pi, or other providers. ACP `Internal error` responses can carry the actionable CrewCoder failure in `error.data.message`, which the bridge must prefer over the generic envelope text. Local ACP file reads currently use saved disk bytes while SSH reads/writes route through SFTP; do not claim dirty editor-buffer support until a renderer-host route exists. Session-scoped `externalDirectories` are synchronized after ACP new/load through `session/set_external_directories`, including `[]` to revoke stale native-session grants; changing them must restart the bridge. CrewCoder validates and persists the roots, while CrewCode's picker remains unavailable for SSH roots. It is deliberately excluded from disposable editor completion. See `docs/crewcoder-provider.md`.

Grok Build is a third ACP provider implemented separately in `grok-bridge.ts`; CrewCode is the client and spawns `grok agent stdio`. Keep Hermes and CrewCoder untouched. Its defining constraint is that **Grok resolves its own permission mode from `~/.grok/config.toml`, project `.grok/config.toml`, and Claude-compatible `.claude/settings.json`** — a user with `permission_mode = "always-approve"` gets a session that never asks the client and silently runs tools, voiding Ask/Plan/Build. `--permission-mode` is therefore always passed, is a **top-level** flag that must precede the `agent` subcommand (`agent stdio` accepts none of these flags), and maps ask/plan/read-only to `dontAsk`, build to `default`, full to `bypassPermissions`. Never let Grok's config decide the mode, and never send `_meta.yoloMode` on `session/new` — that field only escalates. The mode is a floor, not the enforcement: `dontAsk` was measured to still *prompt* for a client-side write rather than auto-deny, so the real gates are CrewCode's own permission-request refusal and its `fs/write_text_file` refusal (Grok delegates writes to the client, making that call the last gate before disk), plus a tool-announcement gate that trusts `_meta['x.ai/tool'].read_only` and falls back to a name check so unknown mutating tools fail closed. Grok's native plan mode must **not** be used for enforcement — always-approve stays armed underneath it and only *edits* are blocked, so bash still auto-runs; this mirrors the existing Claude rule. Permission choices are once-only: `allow-edits-session` is filtered out by ACP `kind` (never by vendor id spelling) because a session-scoped grant outlives the turn, leaving turn grants to `turn-permission-grants.ts`. Token usage arrives **only** on the vendor `_x.ai/session_notification` channel as `response_completed`, so a standard-only ACP client renders a dead context meter; per-turn `_meta.inputTokens` is live context occupancy while `_meta.usage.*` is cumulative across model calls and must never be read as occupancy. Reasoning effort is Grok's `low|medium|high` with no off: the picker shows exactly those three using Grok's own wording, and the bridge additionally clamps defensively because an unknown value is rejected for the whole process; effort is spawn-time, so changing it restarts the bridge. Grok numbers its server→client requests from `0`, so id presence must be tested with `typeof id === 'number'`, never truthiness. Model discovery reads the catalog off the `initialize` response and creates no session. Follow-ups queue locally in the bridge (Claude-style) rather than through Grok's own upstream prompt queue, because upstream queueing gives up composer-visible pending items and cancellation while behaving identically otherwise; `drainFollowUps()` must run **after** `endTurn()` since the drain is gated on `currentTurnId` being cleared, and abort/stop clear the queue. Terminal capability, slash commands, and `--deny` rules are deliberately not wired. See `docs/grok-provider.md`.

Workspace folder actions are state-aware: a project's context menu always offers **Create folder**, while **Move to folder** appears only after at least one destination folder exists. The workspace drawer keeps all workspace groups above global Working/Completed/Terminals activity, then renders one **Threads** section scoped to the selected workspace; never reintroduce per-workspace inline session expansion. Every section has a semantic icon. Local workspace rows abbreviate the exact OS home-directory prefix with `~`, retain the absolute path as hover text, and leave SSH roots unchanged. Completed activity is a transient shortcut: hide it one hour after completion without deleting or archiving the underlying session or transcript. Session pins persist on `Session` and sort stably before unpinned peers inside the existing normal or delegated group; pinning must not erase delegated provenance or make duplicates inherit a pin.

Crew Surface lane model toggles are run-selection gates: `use` lanes can receive supervisor delegation, shared broadcasts, and direct sends; `skip` lanes stay visible in the UI but are hidden from supervisor prompts and must not be started by automated fan-out.

Supervisor reporting is incremental, not batched: `useCrewSupervisor` feeds each worker's reply back to the supervisor as soon as it finishes (`feedSupervisor`), gated only by a `busy` flag so it never prompts over an in-flight supervisor turn (replies that land mid-turn buffer and drain on `turn_end`). A fast worker is reported immediately instead of waiting for the slowest — critical under split distribution where workers finish at very different times. The `MAX_SUPERVISOR_ROUNDS` budget now counts only fresh delegations, not report drains, so incremental reporting can't exhaust it; the idle watchdog force-feeds (even with no replies) so an abandoned worker still gets reported. Supervisor bridges start with `toolPolicy: 'read-only'` and Ask-mode behavior; supported bridge providers must block write/exec tools for supervisors even if a normal chat bridge could use them.

Delegated threads let a solo-chat agent spawn real, persistent chat sessions through a loopback HTTP API (per-session bearer token, ephemeral port, `useDelegatedThreads` answering marshalled IPC in the renderer). `mode` is permissions and `isolation` is placement — they are independent, and `build` + `shared` is the legitimate "run the test suite in this checkout" case; never re-couple them. **Depth-1 must stay enforced at three layers, not by withholding credentials alone**: `canSessionDelegate()` (`origin !== 'delegated'`) gates the ChatPane toggle, credential minting in `useSessionDelegation`, and — authoritatively — every route in `useDelegatedThreads.perform()` with a 403, so a leaked token cannot read siblings or merge their branches either. The bearer token **is** the caller's identity, so `containsDelegationToken` must reject any create prompt or thread message carrying a live token (checked against every registered token, not just the caller's); refuse rather than redact, because a 64-hex string is never legitimate task text. **An agent must never be able to archive a chat.** `POST /v1/threads/:id/close` sets `Session.delegationClosedAt`, which frees a concurrency slot and dims the drawer row; it must never call `setArchived`, because archived sessions vanish from every live surface and only the user decides they are finished with a thread. Sending a closed thread a message reopens it, `focus` works on a done thread and refuses an archived one, and `closed` in the API projection means either state because both free a slot. Reporting is push, not poll, and is modelled directly on the crew Supervisor loop: `useDelegationReports` subscribes to the bridge registry's `subscribeTurnEnd` and routes a finished worker's bounded final reply into the parent's running turn as a follow-up, wakes an idle parent with a fresh turn, or buffers it in `delegation-inbox-store.ts` for the parent's next prompt; every failure falls back to buffering so a report is never dropped. **Reports must be coalesced, never delivered one wake per thread** — waking costs a full parent turn at that chat's whole context, so a fan-out finishing together gets one wake carrying every report (`REPORT_COALESCE_MS`), and a `delivering` flag must be claimed synchronously before the first `await` (crew's `busy`) or parallel workers all see an idle parent and fire concurrent prompts at one bridge. Autonomous waking is `settings.wakeParentOnDelegatedReport` (default on) and is bounded by `MAX_AUTONOMOUS_WAKES = 4`, which counts **recursion, not volume**: a wide fan-out from a user-driven turn is free however many threads it contains, while a wake caused by threads spawned during an autonomous turn (`Session.delegatedDuringWake`, stamped at spawn) costs one. Only a real user message refills the budget (an auto-wake bypasses the send path, so it cannot refill its own), follow-ups into a running turn never spend it, and an exhausted budget must say so in the transcript. A finished thread must be re-read on a settle retry (`REPORT_SETTLE_ATTEMPTS` × `REPORT_SETTLE_INTERVAL_MS`, mirroring crew's `reportLaneReply`) before its reply is extracted — `turn_end` fires before the renderer flushes stream buffers, so a synchronous read captures the agent's opening line and none of its result. One logical turn must report exactly once: `useAgentBridge` routes `turn_end`, `error` and `closed` through the same callback, so the guard is a consume-once `reported` set released only by the child's next `turn_start` (crew's `waiting.delete`), **never reply-text comparison** — the settle retry guarantees an early and a late event see different text, so text dedup silently delivers every report twice. `Session.delegationRunId` is the cohort stamped at spawn so a batch can report "1 of 3 done — do not summarize as finished yet"; it is unrecoverable after the fact, so never try to infer it at report time. The idle watchdog (`shouldAbandonThread`, mirroring crew's `shouldAbandonRound`, fed by `subscribeActivity` + `nextToolsInFlight`) reports a thread that is still running with no tool open and no bridge event for 3 minutes — it must **report, never close or archive**, and must keep the tool-in-flight gate or a single long tool call looks identical to a hang. A wake must revive a bridge reclaimed by the 10-minute idle sweep (`ensureBridgeForSession`), and both the preamble and the `woke` report block must tell the agent the user is not present so an auto-started turn never ends in a question. Every report also lands as a visible system row in the parent transcript, is framed as `<system>` (never user text), is clamped to 1,600 chars, caps at 12 buffered per parent, and drains exactly once at wire-text assembly. See `docs/delegated-threads.md`.

Task distribution (`session.distribution`, default `split`) is a live header toggle separate from `mode`. `split` = each worker gets a distinct sub-task: the supervisor's per-turn run-selection snapshot carries `distributionDirective()`, and `validateDirectivePolicy()` hard-blocks `"to":"all"`, targets that resolve to multiple workers, unavailable/skipped targets, and exact duplicate task text before dispatch. No-supervisor shared mode renders one composer per worker in `CrewTimeline`, and split timeline rounds show each lane's own prompt inside that lane card rather than collapsing to one shared prompt. `broadcast` = same message to all (`handleBroadcast`) and the supervisor may use `"to":"all"`. `set_distribution` is legal at any phase, so it can flip mid-run.

Crew control stops are scoped intentionally: `stop all` in `CrewSurface` aborts every runtime, the supervisor composer stop button calls `abortSupervisor()` only, and lane composer stop buttons call `restartLane()` for that lane only. The supervisor sidebar width is local UI state in `CrewSurface` and is resized with the shared `Splitter`; the supervisor thread also has a scroll-to-bottom affordance. Shared timeline lane groups (`crew-lane-group`) are locally collapsible with chevrons so dense multi-agent rounds remain scannable.

Mode prompts and applied skill bodies are session-scoped context. Send them once for a brand-new chat session; restored sessions with existing message history should seed the local delivery marker and skip re-sending the execution-mode prompt to avoid wasting tokens.

Skill activation is also session-scoped configuration. Keep active skill IDs on the solo `Session`; never use the shared skill definition's `enabled` field as cross-chat runtime state. New sessions start with no active skills, while duplicated sessions copy the source selection.

Chat archiving (`Session.archived`) is non-destructive: archiving releases the session's bridge but must never delete its transcript, and only explicit Delete calls `transcripts:remove`. Archived sessions are hidden from every live surface because `getSessions()` filters them — use `getAllSessions()` only for the archive list itself. Activation must never land on an archived session, and a tab whose sessions are all archived is treated as empty so `ensureTab` seeds a fresh thread (with an id that skips archived ones — reusing an id would alias two threads onto one transcript). The archive/rename right-click menu lives on live drawer session rows; archived chats are not shown in the drawer at all and surface only in the `archive` tab kind, a cross-workspace review page. Archive retention (`settings.archiveRetentionDays`, `0 | 30 | 60 | 90`, default `0`) is a **classifier, not a scheduler**: it flags expired chats for an explicit confirmed bulk delete and must never gain a background sweep. A session with no `archivedAt` is never expired, legacy archived sessions are backfilled to first-launch-after-upgrade rather than zero, and a malformed persisted retention value falls back to Never — enabling a window must not retroactively mark unknown-age history deletable. See `docs/chat-archiving.md`.

Settings include `hideVerboseAgentLogs`, which filters thinking/toolcall/worklog rows at the shared `Messages` renderer. Keep final agent replies, user messages, and important system/status meters visible; do not delete verbose messages from storage just because they are hidden in the UI.

Realtime voice is provider-neutral and off by default. GPT Realtime and xAI Voice adapters remain unavailable until their main-process key is configured; permanent keys must never cross preload, only short-lived client secrets may reach the renderer. The voice model is a narrow conversational controller that can send prompts and read agent status, never a coding agent with direct tool authority. Route requests through the existing session send path, keep one microphone owner across panes in `voice-session-store.ts`, and speak the complete sanitized prose projection in order—never summarize it or read code blocks, diffs, tables, logs, URLs, or long paths. Local replies exceeding the sidecar's 4,000-character per-request limit must be split at sentence/word boundaries and played sequentially, without weakening that security limit. The active transport and original agent target live in module-owned `voice-session-runtime.ts`, never in a chat-pane lifecycle: navigation and `useVoiceSessionController` unmounts must detach only the presenter, keep routing pinned to the session where the user started voice, and continue activity tracking and eventual speech. `voice-session-store.ts` keeps target and presenter scope separate so the next visible chat can adopt the overlay; non-chat pages may temporarily have no host without ending the turn. The orb is one-turn push-to-talk: every transcribed `send_prompt_to_agent` request must pause at an editable confirmation before routing; mute transport input during review, keep its output side alive for the later spoken result, and let Cancel close without contacting the agent. After Send, release the voice session only after the spoken coding-agent result finishes, then require another click. While the active coding turn has a pending/running tool call, the orb must remain in `waiting` and display **Running tools** rather than presenting a late transport event as a voice error; preserve the underlying transport error so it can surface after the coding turn stops. Its active overlay is anchored to the top edge of `ChatHeader`, extends downward over only its presenting chat pane, and remains visible for the full turn unless the user hides it. The X must hide only the overlay and leave transport, agent tracking, and eventual speech alive; render a compact phase-aware control that can reopen it. The large orb and Escape still stop the session. Composer dictation is a separate speech-to-text-only control after the branch picker: use the selected provider, insert at the current caret, and never invoke the orb, TTS, agent routing, confirmation overlay, or send; it shares only the global microphone lock. `fake` is development/test-only. `local` runs Parakeet TDT 0.6B v2 and Kokoro-82M (`am_michael` default) in the packaged native Python sidecar: main alone owns its random bearer token and authenticated loopback requests, the renderer must never connect to it directly, it must reject non-loopback binds, and app quit must stop the child. Local inference has persisted Automatic/GPU/CPU placement and a Kokoro speech-speed setting (`0.5×–2×`, default `1×`) shared by orb replies and chat read-aloud; normalize the value in main and validate it again in the sidecar. GPU must fail clearly when CUDA is unavailable rather than silently falling back. When Local is selected, launch-time background warmup loads Parakeet only; clicking dictation or the orb also starts transcription warmup immediately, and dictation must never load Kokoro. An orb turn starts Kokoro warmup only after dispatching agent work so it overlaps the coding turn. Keep the lightweight sidecar alive while unloading Kokoro after 5 idle minutes and Parakeet after 15; after model deletion, garbage collection, and CUDA cache clearing, recycle the managed sidecar only if CUDA still reports a material reserved allocation so process termination guarantees VRAM release. Capability warmups must verify their requested model flag rather than treating `/v1/health` as model readiness; preserve captured child output in request failures so users never receive an unactionable bare `fetch failed`. See `docs/realtime-voice.md`.

Solo Chat selection speech is independent text-to-speech: capture a non-empty selection wholly inside the normal Solo Chat thread at context-menu open, offer **Read selection aloud**, and use the selected Local/GPT/xAI provider. It must never open the orb, acquire the microphone, contact an agent, sanitize beyond trimming, or appear in Crew, Canvas, or Writer chat. Hosted synthesis reuses the main-owned Voice key; Local synthesis remains authenticated through main. Cap selections at 4,000 characters, replace active selection playback on the next request, and keep `off`/`fake` disabled. While synthesis is pending, keep a visible loading indicator after the context menu closes and clear it when playback starts or fails. Enabled providers also expose whole-message playback in the completed agent-message hover footer, capped at the same limit; the copy action belongs in the usage strip after token usage. See `docs/realtime-voice.md`.

Voice orb start/end shortcuts are component-local keybindings exposed in Settings and `keys.json`. In split layouts, start must target the focused composer rather than fan out; end must only stop the session that currently owns the voice microphone.

Completed-turn desktop notifications use the persisted `notificationSound` setting: `system` delegates audio to the OS, `bell`/`ding`/`knock` use the renderer's synthesized tones, and `none` stays silent. Custom tones must send the native toast with `silent: true` so users never hear both CrewCode and system audio. Coalesced crew completions play exactly one sound. On Linux, toasts go through a detached `notify-send` child process — never Electron `Notification` on the main-process hot path, whose synchronous DBus round-trips froze the app 0.5–1.1s per toast. See `docs/notifications.md`.

Completed agent-message Markdown fenced code uses the shared safe Shiki `CodeBlock`; streaming text and inline code remain lightweight. Shiki and semantic Markdown accents (headings, list markers, emphasis, links, inline code) must use `--syntax-*` CSS-variable references derived from canonical theme tokens in `colors_and_type.css`, never a fixed bundled palette, so live theme changes recolor existing messages without re-tokenization. Keep body/list text readable, the 80,000-character fallback, and React-node rendering (no `innerHTML`). See `docs/agent-message-markdown.md`.

Agent task activity is provider-native and passive: CrewCode visualizes task/plan events but does not force agents to create them. Claude SDK `task_started`/`task_updated` system messages are projected by `claude-bridge.ts` into one synthetic `claude_tasks` toolcall per turn, excluding `skip_transcript` housekeeping and settling before `turn_end`; if the SDK omits a terminal update, successful turns finalize running tasks as completed and abort/error cancels them. Reset state between turns, and treat settled result snapshots as authoritative over streaming args. `latestTodoActivity()` must remain current-turn scoped and power normal chat plus Crew lane/timeline/supervisor overlays. The global **Settings → General → Todo activity** preference hides only aggregate todo UI; approvals/questions must render regardless of that preference or todo-card dismissal because they can pause the provider. Keep delegated `task` work-log rows distinct from aggregate todo activity. See `docs/agent-activity-overlay.md`.

The floating Tweaks panel owns presentation controls for density and workspace dock placement/sizing only. Embedded terminal-column visibility is controlled by chat header and command actions through `showTerminal`; it must update every embedded `ChatPane` (normal/Crew, Canvas chat, and Writer chat) without killing PTY panes. Standalone terminal tabs and explicit Canvas terminal panes remain independent. See `docs/tweaks-panel.md`.

Queued follow-up messages are also session-scoped. There is exactly ONE follow-up behavior: deliver the message into the running turn at the next safe point (mid-stream), not after the turn fully ends. The app-level value is the single literal `streamingBehavior: 'followUp'` — do NOT reintroduce a `'steer'` option in CrewCode's types/UI; `'steer'` is pi RPC's own term and lives only inside `pi-bridge`. This is a deliberate naming inversion against pi: pi's `'steer'` = deliver between the running turn's tool calls before the next LLM call (what we want), while pi's `'followUp'` = wait until the agent fully stops (append-after, what we do NOT want). So `pi-bridge` maps our `'followUp'` to pi's `'steer'`; forwarding pi's `'followUp'` verbatim was the "injects after the last message" bug. Claude's Agent SDK physically cannot inject into a live turn, so `claude-bridge` buffers the follow-up and runs it as a fresh turn the instant the current turn ends (the only thing it can do) via the queue→`drainFollowUps` path. While a bridge agent is running, sending with non-empty composer text should submit a follow-up instead of forcing a stop. An accepted follow-up's IPC resolves immediately — the renderer must NOT clear the bridge's running flag on that resolution (turn_end owns it), or the composer flips idle mid-turn and the next send gets rejected. Bridges that queue locally (claude) mirror the queue to the renderer via `follow_up_queued`/`follow_up_removed` events (reasons: `sent`/`removed`/`cleared`); the composer shows pending items and can cancel one via `bridge:removeFollowUp`. Providers that queue upstream (pi) report nothing and cannot un-send. Aborting/stopping a turn deliberately clears the whole queue.

Composer execution modes are `ask | plan | build | full`, where `full` is displayed as **Full Access**. A mode has an optional prompt preamble (`buildModePreamble`) **plus** a real per-provider permission policy; the preamble is advisory, not enforcement. Settings customizes the shared prompt text, while `Session.modePromptsEnabled` controls injection per Solo Chat from `ChatHeader`; it defaults true, copies on duplicate, and locks after startup context is sent because provider context cannot be revoked. Disabling it must never weaken provider-native permission policy, and skills/delegation context must still be delivered. Build approvals may grant **allow all (this turn ONLY)** only through main-issued `{bridgeId, turnId}` capability state: approve the current and later permission requests in that turn, clear on every turn/bridge termination boundary, and never use provider-native remembered choices that could outlive the turn. The wire value is `'full'` (renamed from `'yolo'`), the display token is `Mode` = `'Full'`, and the label is `MODE_LABEL` = `'Full Access'`. Because the wire value changed, persisted sessions and `defaultMode` can still hold `'yolo'`, so every read of a persisted mode goes through `normalizeModeLevel()` (`yolo` -> `full`, unknown -> `build`) — an unrecognized level returns `undefined` from `MODE_FROM_SETTINGS`, which crashes the composer mode picker and prepends a literal "undefined" to the prompt. Full Access means every tool is pre-approved: Claude uses `bypassPermissions`, Codex uses `workspace-write` + `never` approvals (deliberately NOT `danger-full-access` — worktree isolation stays), pi/hermes/CrewCoder auto-accept permission requests, and agents must never ask for tool permission. `toolPolicy: 'read-only'` always overrides the mode, so supervisor and completion bridges stay read-only even in Full Access, and real `AskUserQuestion` prompts still surface. See `docs/execution-modes.md`.

Reasoning effort choices are provider-native: Claude exposes `off/low/medium/high/xhigh/max`; Codex exposes `off/low/medium/high/xhigh/max/ultra`; other providers expose `off/low/medium/high/xhigh`. Claude `off` must explicitly disable SDK thinking, and its named levels map to SDK `effort`. Codex `xhigh/max/ultra` must pass through app-server unchanged rather than silently downgrade. Codex Ultra's automatic delegation is upstream provider behavior—CrewCode does not emulate it. See `docs/reasoning-effort.md`.

Claude SDK turns must preserve project guidance without loading global skill bloat: use `settingSources: ['project']` with `skills: []`. Do not switch to full SDK isolation (`settingSources: []`) unless CrewCode injects equivalent repo guidance itself. See `docs/agent-provider-context.md`.

Agent conversation replay history is stored per session under `userData/conversations/agent-conversations.<stable-session-digest>.json`. Each shard must keep the legacy `{ conversations: { [sessionId]: messages } }` shape with a single session key, so it behaves like a sliced-up `agent-conversations.json`. Do not reintroduce a single monolithic `agent-conversations.json` live store; that legacy file is migration input only.

Provider switching mid-chat is context handoff, not true provider state migration. Keep provider-native resume IDs keyed by the provider-specific bridge key, but keep CrewCode's local replay transcript keyed by the chat session scope so a new provider can continue from the existing visible thread. A provider switch with existing messages should show a `handoff` meter and inject a handoff packet on the next prompt, including workspace metadata plus an AI summary generated by a disposable incoming-provider session even when the target provider has an old native resume id. Bound the transcript before disposable summarization so smaller-context providers do not fail on huge sessions. If disposable summarization fails, fall back to bounded transcript context.

Manual `/compact` uses the same disposable-summary pattern: generate an AI summary from a bounded transcript in a temporary session, show the summary in chat, replace CrewCode's local replay history with that summary, clear the provider-native resume id, and start fresh on the next prompt.

Visible chat transcripts persist in two layers (`src/renderer/src/stores/chat-messages-store.ts` + `src/main/transcript-store.ts`). **L2 — disk** is authoritative and unbounded: one file per scope under `userData/transcripts/transcript.<scope-digest>.json` holding the full rich `Message[]`, written back on the same settle/debounce cadence and via a synchronous IPC batch (`transcripts:saveSyncBatch`) on window teardown. **L1 — `crewcode:messagesByTab` localStorage** is a bounded, synchronous cache for instant paint on launch; it caps each scope's tail and, on `QuotaExceededError`, evicts the least-recently-touched scopes so the newest conversation always wins. On launch the store hydrates from L2, backfilling anything L1 evicted. Do NOT treat localStorage as the source of truth or let `persist()` swallow quota errors silently — that was the original "recent messages vanish on restart" data-loss bug. Growing turns stay memory-only: do not serialize L1 or structured-clone L2 for live thinking/agent/tool rows, because those synchronous renderer costs caused the workspace-wide hitch on structural stream events. A settled scope schedules both layers at bounded idle; pagehide/beforeunload/hidden visibility synchronously flushes even live scopes, which is the durability guarantee. User messages are settled and therefore persist before normal agent work, while a crash may lose only the partial in-progress response. Main's `transcripts:save` is a last-wins async queue (`fsp.writeFile`), never a sync write on the IPC handler; the teardown sync batch drops queued payloads for scopes it writes so a stale async write can't clobber it. Transcript mtimes are cached in main after the launch scan and updated on writes/removes—never re-read and JSON-parse every shard per `transcripts:mtimes` request (that blocked Browser main for 1.2–1.3s on Mission Control tool-state refreshes). Explicit session deletion must also call `transcripts:remove`; the reconciliation prune must NOT delete disk files.

`persist()` is a **hot path — it runs on every structural message, i.e. every tool call**. Per-scope serialization is cached in a `WeakMap` keyed by the scope's `Message[]` identity (arrays are replaced immutably, so reference equality proves the tail is unchanged): a write touches one scope but the payload needs all of them, and re-stringifying every scope each time cost 20-28ms per tool call. Do not drop that cache or key it by anything weaker than array identity. It must serialize each changed scope exactly once and assemble the payload by string concat under explicit budgets (`MAX_PERSISTED_SCOPES`, `L1_BYTE_BUDGET`, `PER_SCOPE_BYTE_CAP`, and `MAX_PERSISTED_MESSAGES_PER_SCOPE = 60` — sized just above the DOM pager's `PAGE_SIZE = 50`). Never re-stringify the whole map once per evicted scope: quota is the *steady state*, so the old snapshot-then-retry loop did O(scopes) multi-megabyte serializations and blocked the renderer for ~2s on every tool call. Quota retries must only re-join already-serialized strings. `scopeLastTouched` must stay a **monotonic counter, not `Date.now()`** — same-millisecond ties let eviction shed the newest conversation instead of the coldest. Quota/eviction behavior is covered in `chat-messages-store.test.ts`; keep it covered.

Renderer re-render isolation: state that changes at high frequency must NOT live in `App.tsx`, because `App` rebuilds the whole tab tree (and, on Workbench, every mounted `ChatPane`) on each render. Two such slices are now isolated into stores that only their consumers subscribe to — `stores/terminal-unread-store.ts` (background PTY output; a `claude`/`codex` agent in a hidden tab used to re-render the shell ~1.4×/s) and `stores/composer-draft-store.ts` (per-tab composer drafts; every keystroke re-rendered the shell). Do not move either back into `App`. Live agent state (running / status / queued follow-ups / pending user requests) lives in `stores/bridge-activity-store.ts`, not in `useBridgeRegistry`'s `useState`. It used to ride on the `bridges` prop, which meant ChatPane's Stop button, spinner, follow-up pills, and permission prompts only stayed correct because that bundle got a fresh object identity on every App render — an accident, not a design, and one no type or test protected. Consumers now subscribe to the slice they read: ChatPane uses `useIsBridgeRunning` / `useBridgeStatus` / `useQueuedFollowUps` / `useUserRequestsForTab`. `useBridgeRegistry` still subscribes to `runningByBridge` (the drawer and Mission Control fan out over every session via `isBridgeRunning`), but status and follow-up churn no longer re-render App. Do not reintroduce `getBridgeStatus` / `getQueuedFollowUps` / `userRequestsByTab` onto the `bridges` bundle. `clearBridges()` deliberately does NOT drop user requests — an idle-stopped bridge keeps its tab's requests, while `dropBridge`/`releaseTab`/`resetSession` clear them explicitly; `bridge-activity-store.test.ts` pins that.

Structural message updates (tool calls and new thinking blocks) must stay isolated from the workspace shell. `Messages`' `areRowsEqual` compares a work-log anchor's actual source `ToolCallMessage` identities; never replace that with blanket live-turn invalidation, because a growing thinking/text sibling would rebuild every work log in the turn. Agent rows receive a precomputed `showTurnSummary` boolean instead of reading the whole transcript. Self-contained rows — `thinking` above all — re-render only when their own message changes. `chronologicalStreamSegments` caches splits per chunk string, so a growing block only re-splits its tail instead of every chunk on every flush (that was quadratic in turn length); it also appends units in a loop rather than `push(...units)`, which throws on very long blocks. Solo-chat auto-follow runs in the next animation frame, not `useLayoutEffect`: reading `scrollHeight` synchronously during every React commit forced shell-wide layout. Keep `.thread-shell` layout/paint-contained so transcript reflow cannot invalidate the workspace drawer.

`ChatPane` is still not `React.memo`'d, but that is now a cost/benefit call rather than a correctness trap: `MessageRow` is already memoized and `Messages` pages at 50 rows, so an App-driven ChatPane re-render is cheap reconciliation. Memoize only against a profile, never against a theory.

Markdown/text editor drafts in chat and Writer Workspace intentionally persist unsaved buffers in renderer localStorage (`markdown-draft-storage.ts`) so pane refreshes or tab switches do not make untitled/dirty files disappear. This is draft retention only; do not write files to disk until the user saves or accepts the Writer review.

Writer DOCX/PDF support is a conversion workflow, not native binary editing. Persist one source/working/generated link in app user data, reopen the same sibling Markdown working copy on repeated binary clicks, preserve the original, and review local and agent edits through Pierre. Export only approved text to one stable generated DOCX/PDF derivative; replace that derivative only while its stored content hash proves it is still CrewCode-owned, otherwise fork a collision-safe output. Local agent writes use the editor file watcher; SSH Writer files use bounded polling because remote filesystem events are unavailable. Keep an agent's on-disk candidate separate from any dirty local draft, and never imply layout-perfect round-tripping or OCR support. See `docs/writer-document-formats.md`.

The code editor's active editing surface is CodeMirror 6 (`CrewCodeMirrorEditor`) wrapped by `CodeEditor`, which still owns tabs, file-tree UI, save/format, disk-conflict prompts, and plugin editor actions. Keep high-frequency editor document/selection/autocomplete state inside CodeMirror instead of lifting it into `App.tsx`. Direct `@codemirror/*` dependencies use local `file:` links to the independently cloned package repositories under `packages/crew-codemirror`; rebuild those sources with `npm run codemirror:build`, and never run the upstream `codemirror:install` bootstrap over uncommitted package edits because it hard-resets every child repository. Editor themes come from `packages/crew-codemirror/theme-library`, use the checked IDs in `src/shared/editor-theme-types.ts`, and must reconfigure through CodeMirror's theme `Compartment` so switching palettes never destroys document, history, selection, scroll, or LSP state. Editor file/tree icons use the vendored Bearded Icons assets and mapping under `src/renderer/src/assets/bearded-icons`; preserve its GPL-3.0 license/attribution, prefer exact filename then compound-extension mappings, and never runtime-reference the gitignored `.crewcode/` source. The FileTree Outline must derive active-document symbols inside CodeMirror: prefer hierarchical LSP document symbols for TS/JS, use the bounded local fallback for supported non-LSP languages, reject stale responses by document identity, and keep symbol extraction out of `App.tsx`. TypeScript/JavaScript intelligence uses one shared `@codemirror/lsp-client` and `typescript-language-server` process per workspace. Keep JSON-RPC framing and process ownership in the main process, sanitize LSP Markdown, refuse definition/problem paths outside the workspace sandbox, and launch SSH language servers remotely rather than reading remote projects through local-only paths; remote hosts must provide TypeScript and `typescript-language-server`, and CrewCode must not install them automatically. The Problems and workspace-search indexes must remain bounded. Code Actions currently apply only validated, non-overlapping edits to an unchanged active document; fail closed on commands, stale responses, malformed ranges, and multi-file edits. LSP rename and workspace replace are preview-first multi-file flows: block affected dirty tabs, reject outside-workspace/stale/malformed edits, verify file snapshots immediately before writing, and roll back completed writes after a later failure. Preserve the same guarantees over SSH. Editor AI completions use a dedicated provider/model setting and disposable `agent:completion` bridges: bounded context, `toolPolicy: 'read-only'`, `thinking: 'off'`, no persisted conversation/resume state, 20-second timeout, cancellation on every stale edit, and built-in providers only (no plugins/Copilot API). Ghost text must never show model reasoning: disabling provider reasoning is not sufficient, because models that inline `<think>` blocks into the content stream arrive as ordinary `text_delta`. Every completion route must normalize through the shared `src/main/agents/completion-text.ts` (strip reasoning blocks, reject unterminated ones, then unwrap one fence) — do not re-inline a per-provider copy of that logic. Completion-only hosted APIs are deliberately distinct from chat providers: OpenCode Go uses its OpenAI-compatible bearer-key endpoint and OpenRouter reuses its API route; both must remain ephemeral and never write completion content to conversation history. See `docs/code-editor.md`.

Workbench/Canvas Mode is a fresh workspace surface (`kind: 'canvas'`) for workbench-owned chats and terminals. It must NOT mount live panes from existing app chat/terminal tabs; doing so duplicates heavy streaming/xterm work and can freeze the renderer when multiple agents are active. Workbench pane membership persists in `crewcode:workbenchPanesByTab:v1`; chat transcripts use the existing chat stores, and terminal metadata uses `crewcode:terminalSessions:v1`. Workbench-owned panes are allowed because they are created explicitly inside Workbench, but future hardening still needs virtualization, explicit lifecycle controls, and measured terminal mount caps. See `docs/canvas-mode.md`.

The standalone Git Workspace tab (`kind: 'git'`) is a full-page surface backed by the same `useGitSidebar` state/actions as `GitSidebar`. Keep Git Sidebar and Git Workspace behavior consistent; page-specific changes should live in `GitPage`/CSS unless the underlying git behavior truly changes. Push authentication uses a one-shot `GitAuthModal` plus temporary askpass helper; do not persist Git passwords/tokens unless a dedicated secure keychain flow is added. See `docs/git-workspace.md` and `docs/git-authentication.md`.

## Plugin platform notes

CrewCode has a local-first plugin platform moving from v0 prototype to stable contract.

Key files:

- `src/shared/plugin-types.ts` — checked shared plugin manifest/API/result types.
- `src/shared/plugin-permissions.ts` — permission labels, descriptions, and risk levels.
- `src/main/plugin-contract.ts` — pure/testable manifest validation, path safety, and capability gate logic. Keep Electron imports out of this file so Vitest can load it.
- `src/main/plugins.ts` — Electron IPC/protocol wiring for local plugins.
- `src/renderer/src/components/plugins/PluginTabHost.tsx` — sandboxed iframe host and postMessage forwarder.
- `packages/crewcode-plugin-api/` — local source for the official `crewcode-plugin-api` TypeScript package (unpublished; publish to npm before v1).
- `schemas/crewcode.plugin.schema.json` — official manifest schema draft.
- `docs/plugins.md` and `docs/plugins-v0.md` — plugin contract docs.
- `examples/plugins/codebase-graph-lite/` — static JS dogfood plugin.
- `examples/plugins/typescript-panel-template/` — TypeScript/React plugin template that builds to static assets.

Security model:

- Plugin UI must stay isolated in sandboxed iframes.
- Plugin UI must never receive `window.electronAPI`.
- Plugin panels load through `crewcode-plugin://`, never raw `file://`.
- Capability calls flow `iframe postMessage -> trusted renderer -> plugins:invoke -> main permission gate`.
- Community install is Git-first: accept public credential-free HTTPS repository URLs, shallow-clone to staging, require `crewcode.plugin.json` at the root, and install a pinned commit only after manifest/permission review. Never run package installs, hooks, build scripts, or repository code during installation.
- Git-installed repositories must reject symlinks, submodules, `node_modules`, special entries, and configured size/file-count limits. Updates must come from the recorded repository, move the previous folder to a dated backup, and clear approval for every new revision even when permissions are unchanged.
- Git source metadata lives in `~/.crewcode/plugin-sources.json`; keep it separate from author-owned manifests.
- Keep remote/SSH workspaces denied in plugin API v0 unless a dedicated safe remote capability route is implemented.
- Keep path traversal and permission-denial coverage in `src/main/plugin-contract.test.ts` when changing plugin capability logic.

Local plugin layout:

```txt
~/.crewcode/plugins/my-plugin/
  crewcode.plugin.json
  panel.html
  assets/index.js
```

TypeScript plugins are supported by compiling to static assets and pointing `contributes.tabs[].entry` at the built HTML, e.g. `dist/panel.html`. Do not import plugin React components into the trusted renderer.

Plugin validation commands:

```bash
npx vitest run src/main/plugin-contract.test.ts
npm run typecheck
```

Near-term plugin roadmap order:

1. Security tests and hardening.
2. Permission UX: labels, dangerous permissions, changed-permission warning, revoke/disable, audit log.
3. Low-risk extension points implemented: sidebar panels (`contributes.sidebarPanels`), status items (`contributes.statusItems`), editor actions (`contributes.editorActions`), and chat actions (`contributes.chatActions`).
4. Better dev loop implemented: registry watch/refresh, iframe reload, visible plugin errors, and bundled example copy from Settings → Plugins.
5. Higher-risk gates: terminal watchers, agent providers, browser/network/secrets.
6. CLI/SDK only after dogfooding stabilizes the internal API.

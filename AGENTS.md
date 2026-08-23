# Development Rules

## Conversational Style

- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.
- Challenge me and push back and play devils advocate when i want to add implement something that has risks or for a new feature.

This file provides guidance to models when working with code in this repository.

## GOLDEN RULE: Docs & AGENTS.md

Update corresponding Docs in [CrewCode Docs](/docs/), and [AGENTS.md](/AGENTS.md/) when major changes were made and or every time i add a feature. Create or update docs file for it

## What is CrewCode?

CrewCode is a desktop ACE (Agent Coding Environment) GUI built with Electron + React + TypeScript. It lets developers run a *crew* of AI coding agents (Claude Code, Codex, OpenCode, etc.) in parallel across local git worktrees, each in its own workspace with a chat thread, embedded terminal panes, and a code/markdown editor — all in one frameless native-feeling window.

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

## Worktree Safety

Always use the primary working directory (the worktree) for all file reads and edits. Never follow absolute paths from subagent results that point to the main repo.

## GOVERNING DOCTRINE: Execution Custody

Binding on every privileged surface in this repository, current and future. Full
rationale and implementation map in `docs/execution-custody.md`.

Granting authority is decided at the gates in `docs/security-model.md`. This
doctrine governs the other half of the lifecycle: **withdrawing authority once it
has already been granted.**

When **authority / identity / scope / provenance / execution custody** becomes
unknown, stale, contradictory, or changes unexpectedly:

```
-> refuse new privileged actions on the affected scope
-> contain or terminate owned execution where safe
-> preserve evidence and current workspace state
-> report the exact failed invariant and affected scope
-> require explicit human reauthorization before resuming
```

Never, under any circumstance, infer a successful outcome from the absence of a
failure signal:

```
silence               != success
timeout               != success
lost telemetry        != success
missing process state != success
clean Git state       != behavioral correctness
```

Rules for new code:

- An operation whose outcome was never observed is recorded as `interrupted` or
  `halted`. It is never back-filled as complete, and never on restart.
- Long-lived executions carry a persisted custody record. Process-local runtime
  ids are cleared on restart; in-flight work becomes `interrupted`, not success.
- Authority must not change underneath an execution that is already running.
  Refuse and defer the mutation; do not apply it mid-flight.
- Every sanctioned authority mutation is written to the custody record. An
  unrecorded divergence is drift and must trip.
- Reports name the exact failed invariant and the exact affected scope. Never a
  generic error.
- A halt is cleared only by explicit human reauthorization. Halted records are
  stamped, never deleted — resuming work must not erase why it stopped.
- Read-only inspection of custody state is never gated by a halt. A halt must
  not hide the evidence it was raised to preserve.

Crew merges must not equate a clean Git merge with behavioral correctness. Keep the cross-lane collision analysis explainable and advisory, preserve the explicit review gate, and persist source worktree/commit provenance before starting a merge. On restart, process-local runtime ids must be cleared and a still-running merge audit or verification check must become `interrupted`, never inferred successful. Verification IPC accepts only main-discovered `typecheck`/`test` ids, displays the exact command and package script before execution, and must never become arbitrary command execution. See `docs/behavioral-merge-review.md`.

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

The shared React renderer supports desktop and direct browser clients. New renderer code must obtain privileged operations through the typed CrewCode client boundary in `src/renderer/src/runtime/crewcode-client.ts`; do not introduce transport-specific HTTP/WebSocket calls in components. Electron installs `window.electronAPI`; the web adapter implements the same contract over authenticated, versioned HTTP/WebSocket RPC. Protocol envelopes live in `src/shared/remote-access-types.ts`; see `docs/web-remote-access.md`.

Remote-access credentials are authority boundaries. Pairing tokens must remain short-lived, memory-only, and single-use. Persist only device-session digests in owner-only atomic stores; enforce expiry and revocation. Browser HTTP/WebSocket origins must match exactly or be explicitly configured—never reflect arbitrary `Origin`/forwarded headers. Keep authentication limiters bounded, and do not hardcode CJ's `crewcode.logixhub.icu` deployment as a default Hub URL.

The self-hosted Hub is a separate `crewcode hub` process, not Electron renderer state. Keep its SQLite store owner-only and server-side; persist WebAuthn public credentials and only digests of browser/CSRF secrets. Bootstrap credentials and WebAuthn challenges stay short-lived and memory-only. Require user verification, exact configured RP origin/id, one-use challenges, secure HttpOnly SameSite cookies, and CSRF checks for mutations. Machine enrollment tokens must also stay short-lived, memory-only, single-use, and rate-limited; persist only machine bearer digests at the Hub and keep the brain credential file owner-only. Presence and relay connections are outbound-only and revocation must fail closed. Hub connection tickets remain short-lived, memory-only, one-shot, browser-session/user/machine bound, and exact-origin protected. Relay application frames must stay end-to-end encrypted and ordered; the Hub may route metadata but must not receive RPC/source/terminal/agent plaintext. Do not let Hub identity, machine presence, or requested ticket scope imply Brain execution authority: `crewcode brain` defaults to no RPC grants, and every decrypted method must pass both explicit Brain-local scope and registered-workspace validation. Relay loss means pending outcomes are interrupted, never successful.

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

## TypeScript config

Three tsconfigs compose via project references:

- `tsconfig.json` — root references only
- `tsconfig.node.json` — main + preload processes
- `tsconfig.web.json` — renderer (`strict: true`, `jsx: react-jsx`)

## Current state

Read this file only when working on any of the features below and need the Current state of them `CrewCoder provider`, `ACP Grok Build`, `Sidebar Folder Creation`, `Crew Supervisor`, `Delegated Threads`,`Chat Archiving`, `Hide work Logs`, `Realtime Voice Orb`, `Notifcation Sound`, `Agent Messages`, `Agent Task Activity`, `Cusromization Panel`, `Queued Messages`, `Composer Execution Modes & reasoning`, `Claude SDK Global skills isolation`, `Provider Switch Handoff & Compact`, `Chat`, `Markdown Editor`, `Code Editor`, `Workbench Mode`, `Git Workspace/Sidebar`, [Current State](docs/current-state.md)

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

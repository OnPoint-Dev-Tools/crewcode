# Development Rules

## Conversational Style

- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.
- Challenge me and push back and play devils advocate when i want to add implement something that has risks or for a new feature.

This file provides guidance to models when working with code in this repository.

## GOLDEN RULE: Docs & AGENTS.md

Update corresponding Docs in [CrewCode Docs](/docs/), and [AGENTS.md](/AGENTS.md/) when major changes were made and or every time i add a feature. Create or update docs file for it

Git Workspace changed-file rows support stage/unstage controls and a context
menu for stage, stage-all, unstage, and explicitly confirmed discard actions.

GitHub pull-request creation, review, and management stay inside Git Workspace/Git Sidebar through the typed CrewCode client. Preserve the single-PR Branches → Details → Review creation flow, measured base-relative evidence, the compact current-branch PR sidebar launcher, and the canonical repository PR Browser with real on-demand detail/diff/check evidence, PierreDiff per-file review, overall review submission, explicit draft-to-ready action, visible action-gate reasons, explicit merge confirmation, and merge/squash/rebase choices. The Browser must capture the exact selected PR/branches, lock selection/navigation during every mutation, and refresh authoritative evidence after the observed result; do not restore a second review shell or mutation state. PR conflict preparation must require explicit confirmation, the exact clean PR-head worktree, validated refs, observed fetch/merge outcomes, and must surface conflicts through the existing merge card without implicit checkout; retain `MERGE_HEAD` visibility after the last file is staged, then require explicit continue and push. `--auto` is not conflict resolution. Read methods remain registered-root `workspace:read`; mutations require `workspace:write`. Never expose GitHub credentials to the renderer/browser, fabricate inline comments, imply self-approval is available, or infer readiness/merge from silence. Crew integration remains a separate provenance-journal and behavioral-verification workflow. See `docs/github-pull-requests.md`.

Pull-request creation may select a bounded subset of the observed base-to-head
commit history. Revalidate full commit ids after fetching the latest base, then
create and push a new named head branch by cherry-picking in history order from
an isolated temporary worktree; never rewrite, checkout, or dirty the user's
current branch. Abort and remove the isolated operation without pushing when a
selected commit conflicts. Keep PR conflict file editing, ours/theirs,
exact-file staging, continue, abort, and push in the PR Browser's contextual
Conflicts tab. Recheck the selected PR head branch before every local mutation
and refresh GitHub detail/check evidence after the resolved head is pushed.

PR creation Details keeps optional Description, Problem, What changed, Why it
changed, and Solution fields. Submit only non-empty author content under exact
level-two Markdown headings and show explicit not-provided states in Review;
never fabricate a missing section. The PR Browser Conflicts tab must render one
bounded, canonical PierreDiff patch from Git's exact stage-2 ours and stage-3
theirs blobs for the selected unresolved path, label the PR-head/base sides,
and keep Use ours/Use theirs actions beside that evidence. Manual resolution
remains editable, must reject standard conflict markers before exact-file
staging, and must not treat the marker-filled working file as side evidence.
Conflict-side reads require registered-root `workspace:read`; resolution writes
and staging retain `workspace:write`.

The Git Workspace repository PR browser loads a bounded all-state catalogue through the typed client, selects the current branch's head PR when present, and filters the observed catalogue locally by all/open/closed/assigned-to-viewer. Treat merged PRs as closed and assigned as observed assignee or requested-reviewer identity only. Load selected PR details on demand and identify the author with the observed GitHub username plus exact creation timestamp. Keep Overview, Timeline, Code changes, and Checks in the middle pane: Overview always exposes Description/Problem/What changed/Why it changed/Solution while marking absent author content as not provided rather than inventing it; Timeline chronologically combines the observed open event, commits, comments, and submitted reviews; Code changes loads GitHub's combined base-to-head diff on demand, never the `--patch` format-patch mail series, strips defensive mail boundaries, folds repeated paths under one canonical `diff --git` header, and sends one selected file patch to PierreDiff; Checks shows observed status and links only as an external fallback. Keep non-heading copy across every PR surface at the readable PR body scale rather than terminal-label sizes. Show real reviewers, assignees, labels, checks, branches, and change metrics. Keep mutation actions in the Browser inspector with exact target confirmation and mutation locking. Preserve the stacked mobile catalogue/detail and file-list/diff layouts and the explicit SSH-unavailable result. See `docs/github-pull-requests.md`.

PR authorship avatars must be retrieved only through the trusted main/Brain boundary. Restrict every redirect and bounded raster response to GitHub-controlled hosts, return only a data URL to the renderer, cache successful images by username, and keep the GitHub-mark fallback when retrieval fails. Keep observed GitHub comments and submitted review summaries at the bottom of PR Browser Overview after the description sections, with author, state, exact timestamp, Markdown body, and an explicit empty state.

PR Browser inline reviews remain bound to the exact selected PR, head commit, file path, diff side, and line. Keep pending inline comments local until one explicit review submission sends the summary and bounded comment batch; main must revalidate the current GitHub head before mutation and refuse stale drafts rather than retargeting them. Review-thread evidence and viewed-file state come from bounded GitHub GraphQL queries through the trusted main/Brain boundary. Show resolve/reopen only from observed viewer capability flags. When GitHub viewed-state evidence is unavailable, label any session-only fallback as local-only. Preserve previous/next/next-unviewed navigation and observed files/commits since the viewer's latest completed review. These reads require registered-root `workspace:read`; submissions, thread state, and file viewed state require `workspace:write`. See `docs/github-pull-requests.md`.

PR Browser management stays in the canonical selected-PR inspector. Preserve exact-number mutation locking and authoritative catalogue/detail refresh for title/body edits, reviewer/assignee/label changes, draft/ready transitions, and close/reopen. Load bounded assignable-user, suggested-reviewer, and repository-label choices only when management opens through registered-root `workspace:read`; all management mutations require `workspace:write`. Keep author, label, base, head, review-request, and review-decision filtering local to the bounded catalogue. Preserve repository-scoped selected PR, filters/search, middle-pane tab, and selected file when returning where the evidence still exists. Copy PR identity and branch evidence without opening GitHub. Never expose GitHub credentials to the renderer or imply a mutation succeeded before refreshed GitHub evidence is observed. See `docs/github-pull-requests.md`.

PR Browser checks and merging remain head-pinned to the exact selected PR. Load bounded check suites, jobs, steps, annotations, and logs on demand through the trusted main/Brain boundary; state explicit third-party provider limits instead of inventing unavailable evidence. Pass the exact selected PR number when resolving GitHub's required-check fields, and surface check-context failures in the merge inspector instead of silently swallowing the action. Check context and logs require registered-root `workspace:read`; reruns and merge automation require `workspace:write`. Revalidate the GitHub head and job/run ownership before reruns, and require explicit confirmation for job/workflow reruns, direct merge, auto-merge, queue submission, and disabling automation. Keep merge/squash/rebase, auto-merge, and queue operations locked to the observed head commit, then refresh authoritative detail and check evidence and report only the resulting observed state. Treat branch-update permission reasons as update guidance, not fabricated merge blockers. See `docs/github-pull-requests.md`.

Desktop system-tray behavior is opt-in. When enabled, closing the window hides
it while app-owned work continues; the tray must expose explicit Open and Quit
actions, and Quit must pass through normal cleanup. Disabling the preference
removes the tray immediately. Retain the macOS Dock icon and do not expose tray
behavior to web, Hub, or headless runtimes. See `docs/system-tray.md`.

Chat sessions persist independent `createdAt`, `lastUsedAt`, and `archivedAt`
timestamps. Advance `lastUsedAt` only when work is sent through the chat; the
Archive page displays it as `MM/DD/YYYY`, while retention continues to use only
`archivedAt`.

Global chat notifications are live-event-only. Never replay historical errors,
agent exits, or replies from the L1 cache, L2 transcript hydration, continuity
reconciliation, startup, or session switching. Preserve global delivery for
newly appended live errors and active-scope delivery for live agent-exit
warnings. See `docs/notifications.md`.

Git and GitHub notification-bar events are live and user-triggered only. Publish
observed successful commit, push, pull, fetch, sync, merge, repository-publish,
and PR mutation results; never notify from polling, catalogue refresh, startup,
or restored state. The Git Workspace PR launcher badge counts only observed open
and draft PRs, excluding closed and merged PRs. See `docs/notifications.md` and
`docs/github-pull-requests.md`.

Active Git surfaces silently refresh the bounded GitHub pull-request catalogue
once per minute so PRs created or changed by other users update the Browser and
open-count badge. Keep that poll single-flight, preserve selection when possible,
and never turn polled transitions into notification-bar events.

Git tabs retain meaningful unfinished UI state across inactive-tab unmounts in
bounded process-session memory keyed by exact outer tab/worktree identity. Keep
commit/amend drafts, PR creation fields/step, PR Browser location, review summary,
and queued inline comments; clear the applicable draft on explicit cancel or
successful submission. Never retain credentials, mutation locks, destructive
confirmations, or infer repository outcomes from UI memory. See
`docs/git-workspace.md` and `docs/github-pull-requests.md`.

Git Sidebar Pull Requests lists bounded observed repository PRs and prioritizes
the current branch PR. After successful creation, refresh authoritative GitHub
status so the new PR appears immediately. Clicking a PR row must open the
canonical in-app PR Browser with that exact PR number selected, never default to
an external GitHub page.

Inactive standalone terminal tabs stay mounted to preserve their PTYs, but must
pass `active={false}` through `TermColumn` to `XTermPane`. Buffer their output
without `term.write()`, then refit and replay it with bounded frame work and
xterm callback backpressure when activated. Keep bridge activity phase changes
inside the existing 50 ms text/thinking stream flush. Idle App-owned pollers
must preserve state identity when data is unchanged, remain single-flight, and
use asynchronous filesystem/child-process APIs; never put sync I/O or
`spawnSync` in an automatic refresh path. See
`docs/terminal-stream-performance.md`.

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

Optional desktop/web continuity attaches Electron to an enrolled, detached background
Brain through an owner-only loopback rendezvous. Once attached, the Brain store is
authoritative for routed workspaces, transcripts, replay/resume state, terminals,
agents, and the allowlisted workspace/chat catalogue; Electron retains native-only
integrations through the composite client. Seed only missing Brain state, preserve
provider-specific resume keys, and alias legacy `thread:` replay to `web:` without
overwriting existing Brain data. Newer desktop transcript shards merge into existing
Brain shards by message identity. Continuity catalogue patches include session
completion timestamps so web drawer rows can show the same elapsed labels. Normal desktop close must not stop the Brain; only an
explicit Stop Brain/Quit-and-stop action withdraws remote availability. Serialize
prompts FIFO within one conversation while allowing different conversations to run in
parallel, and merge divergent full transcript saves instead of letting stale clients
clobber observed turns. Keep Hub scopes/registered-root checks intact and never treat
this as file synchronization. Never hydrate the aggregate `transcripts.loadAll` result
over a Brain/Hub relay; load bounded per-scope tails for active/L1 conversations and
hydrate cold scopes on demand while keeping full shards authoritative on the Brain.
The 32-scope startup hydration must retain encryption and control-frame headroom under
the Hub's shared 8 MiB connection burst; keep remote scope tails at or below 96 KiB
unless the aggregate relay-budget test and transport budget are changed together.
Keep the pre-React startup surface present while Electron
probes, attaches to, and hydrates from an enabled Brain; startup status is observational
and must never imply attachment success before it is observed. Desktop & Web Settings
must probe and show the Hub's observed canonical browser/passkey origin without exposing
its machine credential; never substitute the enrollment address for an observed browser
origin or imply that enabling Brain starts or proves reachability of the separate Hub
service. Browser adapters must return real disposer functions for unconditional shared
subscriptions whose desktop event source is absent, and must keep optional desktop-only
capabilities genuinely absent; never let a generic unsupported-method Proxy turn an
optional capability probe into a throwing function. See
`docs/desktop-web-continuity.md`.

Continuity catalogue hydration must merge desktop-only session/tab identities into a
Brain catalogue without replacing genuine identities the Brain already owns, once
desktop catalogue authority exists. Until that marker is present, or while the Brain
still contains transcript-derived recovered rows, Electron reseeds the exact desktop
names, active selection, tab-key order, and per-tab session order; drop unmatched
recovered navigation rows while preserving transcript shards, and retain genuine
web-created sessions. If catalogue records are missing, recover only
registered-workspace solo chats from bounded metadata-only transcript
scope/timestamp/provider/title hints; store those fallback rows oldest-first so the
drawer reverse matches desktop recency; retitle dated Recovered chat rows from the
four-word first-prompt hint; never transfer transcript bodies or provider-native
resume ids for catalogue recovery, and never materialize crew lane scopes as solo
sessions. Recovered rows stay browser-local and must not enter
Brain continuity patches unless a real user send promotes the row. Only owner-loopback
desktop control may establish the persisted desktop-catalogue authority marker; generic
browser continuity RPC must not forge it. The marker and exact desktop repair apply only
to optional Electron-to-Brain attachment. Do not change standalone Hub,
`hub --local-brain`, manually started Brain, or web-only behavior to require desktop
state. Browser provider availability/model discovery must
read the Brain registry even when desktop path overrides are unsupported. Automatic
headless registry probes must use asynchronous filesystem/child-process APIs and retain
login/interactive-shell plus common install-location parity. Browser `delegation.*`
RPC remains session-bound and requires the existing Brain-local `agent` scope.

Source-checkout remote-access scripts are `npm run enroll -- --hub <origin>`, `npm run
brain`, and `npm run hub:mobile`. Keep mobile Hub fail-closed around an existing
Tailscale Serve configuration: replacement requires explicit `--tailscale-replace`.
Do not run the foreground `npm run brain` against the default Brain data directory
while Electron Background Brain owns it.

Remote-access credentials are authority boundaries. Pairing tokens must remain short-lived, memory-only, and single-use. Persist only device-session digests in owner-only atomic stores; enforce expiry and revocation. Browser HTTP/WebSocket origins must match exactly or be explicitly configured—never reflect arbitrary `Origin`/forwarded headers. Keep authentication limiters bounded, and do not hardcode CJ's `crewcode.logixhub.icu` deployment as a default Hub URL.

Hub-connected web Settings lists every machine enrolled to the authenticated owner and
keeps reversible disablement distinct from permanent revocation. Disable must persist
the authority suspension, reject heartbeats/tickets/new Brain relays, close existing
Brain and browser relay sessions, and preserve the machine credential for explicit
re-enable. Enable clears the suspension but reports offline until a fresh Brain relay
and heartbeat are observed. Keep these same-origin, session/CSRF-protected Hub control
operations behind the typed CrewCode client; never route them through the selected
Brain, expose Hub credentials, show the surface in direct-server/Electron-only
Settings, or infer machine availability from the mutation response.

Browser delegation keeps its agent-facing endpoint Brain-loopback and bearer-scoped;
delegate requests, editor watches, and LSP handles remain bound to the authenticated
browser session that owns them. Browser plugin iframes load only approved plugin
assets through expiring asset-only grants and continue to invoke capabilities through
the trusted renderer plus manifest permission gate. Remote GitHub UI may drive the
Brain's `gh` device login and registered-workspace publishing, but must never expose
the Brain's GitHub credential or allow remote logout.

The self-hosted Hub is a separate `crewcode hub` process, not Electron renderer state. `crewcode hub --local-brain` may spawn a sibling `crewcode brain` on the Hub host after owner passkey setup; keep Hub SQLite and Brain credentials in separate data dirs, do not default-grant scopes, and still enroll extra machines with `crewcode enroll` then `crewcode brain`. Keep its SQLite store owner-only and server-side; persist WebAuthn public credentials and only digests of browser/CSRF secrets. Bootstrap credentials and WebAuthn challenges stay short-lived and memory-only. Require user verification, exact configured RP origin/id, one-use challenges, secure HttpOnly SameSite cookies, and CSRF checks for mutations. Machine enrollment tokens must also stay short-lived, memory-only, single-use, and rate-limited; persist only machine bearer digests at the Hub and keep the brain credential file owner-only. Presence and relay connections are outbound-only and revocation must fail closed. Hub connection tickets remain short-lived, memory-only, one-shot, browser-session/user/machine bound, and exact-origin protected. Relay application frames must stay end-to-end encrypted and ordered; the Hub may route metadata but must not receive RPC/source/terminal/agent plaintext. Do not let Hub identity, machine presence, or requested ticket scope imply Brain execution authority: `crewcode brain` defaults to no RPC grants, and every decrypted method must pass both explicit Brain-local scope and registered-workspace validation. Relay loss means pending outcomes are interrupted, never successful. Preserve the first observed encrypted-relay close reason through browser startup and record bounded close metadata (peer, WebSocket code, and reason) in the Hub audit store; never replace it with a later generic disconnected error or log relay payloads. Brain-to-browser encrypted frames must use bounded callback-backed ordering and advance their sequence/nonce only after the preceding WebSocket send is accepted; serialization, transport, or queue failure closes the affected tunnel rather than creating a sequence hole.

Remote cross-thread conversation handoff stays Brain-local. Namespace browser replay shards under `web:`; never copy the replay store into browser persistence. Require an authenticated owner-held destination bridge and Brain-local `agent` scope, refuse handoff while the destination is running, perform bounded disposable summarization on the Brain, clear the destination native resume id, and replay the combined destination history exactly once on its next native-provider prompt. Missing history, lost ownership, or summary failure is an explicit failure, never inferred success.

The Hub mobile home is control-plane-only until a user selects an online machine. At ≤768px an authenticated Hub root may route to `/app?hub=mobile`, where `MobileDashboard` reads only cookie-authenticated Hub session and machine-presence data. Do not install a Brain runtime, request relay authority, expose fake agent/worktree statistics, or affect Electron/direct-server/desktop startup from this route. Machine selection enters `/app?hub=mobile&machine=…`, which may open a disposable end-to-end encrypted, Brain-scoped mobile overview; it must request only the scopes needed for real stats, render unavailable values explicitly, return bounded recent-thread metadata rather than transcript bodies, and close its relay before the full renderer opens. Compatibility fallback for an older Brain may use `transcripts.mtimes` to render untitled saved rows, but must never use `transcripts.loadAll` for this overview. Mobile overview counts must use the canonical Mission Control `deriveMissionStats` aggregation over Brain-visible transcript sessions and executions; do not duplicate `mc-stats` semantics, and do not classify completed solo turns as done. A recent-row deep link must carry a bounded workspace/tab/scope descriptor, validate workspace→tab→scope ownership after transcript hydration, preserve the exact transcript scope id when restoring a missing browser session, and refuse invalid/conflicting descriptors. Only the explicit full-app action enters `/app?machine=…` without a thread target. Keep `/?hub-admin=1` as the mobile escape hatch for Hub account and device administration.

### Path alias

`@renderer/*` → `src/renderer/src/*` (configured in both `electron.vite.config.ts` and `tsconfig.web.json`).

## Design system

The design system lives in `.design/crewcode-design-system/`. The canonical CSS tokens are in `src/renderer/src/styles/colors_and_type.css`.

Renderer components may use Tailwind v4 utilities through the utilities-only integration in `src/renderer/src/styles/tailwind.css`. Preflight must stay disabled so incremental conversions do not reset unrelated app surfaces. Use the `cc-*` semantic Tailwind colors, which map to the canonical live CSS tokens; see `docs/tailwind-renderer.md`.

The Prompt/Skills Studio desktop rail keeps its header, filters, and footer fixed while `.pb-list` scrolls independently; preserve the `.pb-left` → `.pb-inner` → `.pb-list` flex-height chain and `min-height: 0` above 768px. The phone list is an edge-to-edge surface, not a centered percentage-width card. Keep the `.pb` → `.pb-left` → `.pb-inner` container chain at `width: 100%`, `max-width: 100%`, and `min-width: 0`. Do not render the category-chip scroller on phones; retain only its compact management/favorite/layout toolbar. Phone cards must be non-shrinking children of the scrollable flex list, grow to fit their wrapped title and description, and contain overflow without line clamps. The phone detail editor must not offer or render Split mode: resolve a stored desktop Split state to Source, retain explicit Source/Preview choices, and let `.pd-source` fill the remaining body height. Actionable controls remain at least 36px and text inputs remain at the iOS-safe 16px.

The composer PromptPicker has separate Prompts and Skills tabs backed by the shared prompt library. Prompt selection inserts into the visible composer (using variable fill when required); Skill selection toggles only the resolved session's `enabledSkillIds`, remains open for multi-select, and never inserts the skill body or mutates a global enable flag. Keep enabled state visible and phone tabs/rows at least 44px/48px respectively.

On phones, Code Editor keeps the code canvas primary and opens its file tree as a dismissible right overlay. Git Sidebar must remain the same stateful surface on desktop and mobile, becoming an off-canvas panel with backdrop/close controls instead of being hidden or squeezing chat/editor content. Changes by turn is a full-screen mobile review: its catalogue stacks above the diff when open, while a targeted changed-file route keeps the catalogue closed. Keep all JS/CSS decisions aligned at `≤768px`; see `docs/mobile-responsive-pages.md`.

Git Workspace phone layout keeps the shared `useGitSidebar` state/actions, a compact two-column overview, changed files stacked above a bounded diff, and the remaining Git tools in a bounded scroll panel. Use the canonical `≤768px` breakpoint, ≥36px actionable controls, and 16px text inputs; do not restore fixed desktop-width columns or unbounded stacked panels.

The final work-log changed-file chips and Turn Changes drawer must use the same turn-change aggregation. A chip targets its exact turn/file in the drawer with the agent-summary/list sidebar closed; do not route it through the ordinary editor file-open action or rebuild a second, lossy file list.

Normalize multi-file provider output into one unified patch per file before rendering. Repeated edits to one file must merge their hunks under one canonical `diff --git` header so `PierreDiff` receives a single-file patch and does not drop to the raw fallback.

Git Sidebar `gs-changes-list` rows open the active worktree's diff in Code Editor's existing `PierreDiff` surface. Git Workspace and Git Sidebar share `useGitSidebar` comparison state and use the workspace-scoped Settings default branch as a read-only base; never checkout that branch implicitly, diff the primary workspace when a worktree is active, or expose staging actions for committed comparison-only rows.

Drawer thread rows may be dragged onto a Solo Chat `.chat-pane-row` or a terminal pane to join the window split group. Do not re-key the session or mount it into Workbench; same-tab splits use a viewport tab (`sessionOwnerTabId` + `pinnedSessionId`) and must not `ensureTab` the viewport id. Disable drag on phones. See `docs/workspace-session-split.md`.

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

Read this file only when working on any of the features below and need the Current state of them `CrewCoder provider`, `ACP Grok Build`, `Sidebar Folder Creation`, `Crew Supervisor`, `Delegated Threads`,`Chat Archiving`, `Hide work Logs`, `Realtime Voice Orb`, `Notifcation Sound`, `App updates`, `Agent Messages`, `Agent Task Activity`, `Cusromization Panel`, `Queued Messages`, `Composer Execution Modes & reasoning`, `Claude SDK Global skills isolation`, `Provider Switch Handoff & Compact`, `Chat`, `Drawer session split`, `Markdown Editor`, `Code Editor`, `Workbench Mode`, `Git Workspace/Sidebar`, `Mobile-responsive Pages`, [Current State](docs/current-state.md)

Agent activity must not depend on prompt instructions or provider tool compliance. Every bridge-backed solo, crew-lane, or supervisor dispatch creates a dedicated CrewCode-owned `activity` transcript record for that turn; raw PTY agents are excluded because their terminal outcome is not observable. Advance it only from observed bridge events: `turn_start` begins work, tool categories may update its deterministic phase, and normal `turn_end` completes it. Prompt rejection, abort, stop, bridge error/closure, custody halt, or lost runtime becomes cancelled/interrupted, never success. Terminal activity is immutable, and a persisted running record from another app runtime projects as interrupted. Provider-native todo/plan/task snapshots may replace the generic row only while the CrewCode lifecycle is active; the CrewCode terminal outcome wins over stale native pending/in-progress state.

CrewCoder `crew-tasks` activity remains provider-owned and optional. Preserve the exact Task* tool name from ACP `_meta["crewcoder/tool"].name` even when ACP `name`/`kind` is generic (`think`/`other`). Treat `rawOutput.todos` as the authoritative session snapshot, and fold newer running Task* mutations over the current turn's last completed snapshot so live status is not masked. Merge a matching full `rawOutput.task` record without letting the lossy snapshot erase its stable id, session display number, description, owner/scope, metadata, dependency edges, or timestamps; keep provider-local generic todo ids out of that richer CrewCoder contract. Render `activeForm`, blocked pending state, completed state, owner, and display number consistently with the CrewCoder TUI. Every user message starts a fresh activity scope. Accept `TaskList` as native activity only with explicit `sessionOnly: true`; project-wide/default lists mix unrelated sessions and must be ignored. Use label-identified incremental TaskCreate/TaskUpdate/TaskDelete reconstruction as a compatibility fallback, never generic argument-shape guessing. Grok `todo_write` completion state comes from `result.TodosUpdated.state.todos` (the full session map); `TodosUpdated.todos` and merge arguments are a subset and must fold, not replace. CrewCode must not prompt providers to manufacture activity, fabricate tool events, or implicitly enable CrewCoder `crew-tasks`. CrewCoder-mode clarify and plan-approval cards are independent of `crew-tasks` and of tool-permission Allow/Deny; they stay visible when Todo activity is hidden. See `docs/agent-activity-overlay.md`.

YuHeard PTY integration must remain bundle-safe. `PtyService` receives the active YuHeard server through an injected accessor and statically imports its shell-wrapper helpers; do not use runtime relative `require('./yuheard-*')` calls from PTY code because electron-vite can move that code into a chunk without emitting the required sibling modules. CLI launch, initial TUI paint, and prompt submission are not completed turns. Codex must use only its exact `approval-requested` and `agent-turn-complete` hook events—never generic PTY idle/BEL heuristics—while output fallback detection remains available for agents without an exact hook. Suppress every YuHeard surface only when the exact completing terminal owns keyboard focus in the focused CrewCode window; a different pane must still alert. See `docs/yuheard.md`.

CrewCoder agent profiles are separate from CrewCode execution modes. Show the desktop model-row profile picker only when the installed CrewCoder provider is active; disable it during a running turn, persist the optional session-scoped `crewcoderMode`, omit `--mode` for Configured default, and pass only `general | crewcoder | plugin | extension` to `crewcoder acp --mode`. A concrete profile locks the underlying CrewCode permission policy to Build and disables Ask/Plan/Build/Full on desktop and phone; Configured default re-enables those controls. Never retain a hidden prior Ask, Plan, or Full Access policy under a concrete profile. When the concrete `crewcoder` profile is active, show the separate desktop approval picker and persist `crewcoderApprovalMode`; expose only CrewCoder's `review`, `always`, `never`, `full-access`, and `sandboxed` values, with `review` as the fail-closed default. Treat approval changes as immutable launch authority: disable them during a running turn, drop only the idle bridge, include the value in custody, and native-resume on the next prompt. Never suppresses prompts but continues to block dangerous calls; Sandboxed applies the native sandbox policy where supported; Full access bypasses CrewCoder approval requests and dangerous-command blocking, so label that risk truthfully and never imply CrewCode Build still interposes. Never route Ask/Plan/Build/Full into CrewCoder's `--mode`. The `crewcoder` profile's plan gate is CrewCoder-owned: project `crewcoder_clarify` / `crewcoder_propose_plan` into the activity overlay and send `/approve-plan` as a prompt, never as a tool-permission Allow/Deny. See `docs/crewcoder-provider.md`.

CrewCoder manual compaction is capability-gated. Expose the bridge `compact()` path only after observing exact `initialize._meta["crewcoder/sessionCompact"].method === "session/compact"`; older CrewCoder versions retain summary-reset. Call the advertised method only while idle and keep CrewCoder's durable session id and ACP child after success. Use the returned summary to replace CrewCode's replay shard and add the visible compact-summary card while retaining the full rich display transcript. Treat `_crewcoder/compaction_update` as authoritative, never infer a duplicate from usage, never fabricate a turn for idle progress, and do not clear usage/replay when the provider reports a skipped compact. See `docs/crewcoder-provider.md` and `docs/conversation-storage.md`.

Provider context handoff is initiated from the Solo Chat header or `/handoff`. Its Used chats tab mirrors the current workspace's live Sessions catalogue across chat tabs; starting either a new or used destination closes the card immediately and moves progress/failure feedback to the destination meter. Preserve each selected destination's owner tab/worktree, existing provider/model/effort locking, and disposable destination-provider summary flow documented in `docs/provider-context-handoff.md`.

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

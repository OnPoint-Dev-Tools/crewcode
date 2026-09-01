# Terminal stream performance

Terminal processes stay alive when users switch window tabs. The renderer keeps
their `XTermPane` components mounted so terminal state, process ownership, and
scrollback survive navigation.

## Inactive terminal tabs

An inactive standalone terminal tab is mounted under
`.terminal-keepalive.hidden`. That container uses `visibility: hidden` and keeps
its full dimensions, so CSS alone does not stop xterm parsing or WebGL work.

`App.tsx` therefore passes an explicit `active` flag through `TermColumn` to
`XTermPane`. Inactive panes continue receiving PTY bytes but enqueue them in
`TerminalOutputBuffer` instead of calling `term.write()`:

- pending output is bounded to the same 2,000,000-character scale as PTY replay;
- if the bound is exceeded, the oldest hidden output is discarded and xterm
  receives an explicit omission notice when the tab becomes active;
- activation refits xterm before replay;
- replay is limited per animation frame and waits for xterm's write callback,
  preventing an unbounded parser queue;
- disposal cancels scheduled work and releases the buffered tail.

Visible terminal panes use the same frame queue. Bursty PTY chunks are coalesced
instead of creating one renderer task and xterm write per chunk.

Do not infer visibility from element dimensions. Hidden keepalive tabs retain
non-zero layout dimensions, which is why the explicit `active` ownership signal
is required. Split-view terminals are active because they are visible. Embedded
chat, Crew, mobile-sheet, and Workbench terminals default active while mounted.

## Structured chat streams

Bridge text and thinking deltas already render on a 50 ms buffer. Their activity
phase updates must happen inside that same flush. Dispatching an activity update
for every raw provider delta reintroduces transcript scans and store writes at
provider-token frequency even though the text itself remains batched.

## Idle background work

Renderer responsiveness also applies when no agent is running. Automatic
status and file-library refreshes must not create work merely because their
timer fired:

- `useCrewcodePromptFiles` may rescan the config library every five seconds,
  but it publishes the previous state object when prompt, skill, command, and
  error content is unchanged. Because the hook is owned by `App`, replacing
  unchanged arrays would reconcile the complete application tree.
- Config-library scans are single-flight. A slow local disk or SSH scan is
  skipped at the next timer tick instead of accumulating concurrent scans.
- Local `FilesystemService.readDir` and `readFile` operations use asynchronous
  filesystem APIs. They must not perform periodic `readdirSync`, `statSync`, or
  `readFileSync` work on Electron's main event loop.
- Automatic GitHub status uses asynchronous, time-bounded `git`/`gh` child
  processes. Independent PR, run, and issue requests execute concurrently, and
  an unchanged result preserves the prior `App` state object.

Do not use `spawnSync` or synchronous filesystem APIs in interval-, focus-, or
visibility-driven refresh paths. Explicit user actions may have different
latency constraints, but automatic work must yield to input and painting.

## Verification

Run:

```bash
npx vitest run src/renderer/src/components/terminal/terminal-output-buffer.test.ts src/renderer/src/hooks/useAgentBridge.thinking-stream.test.ts
npx vitest run src/renderer/src/hooks/useCrewcodePromptFiles.test.ts src/main/filesystem-service.test.ts src/main/github-service.test.ts
npm run typecheck
```

# Code Editor

CrewCode's code editor uses a fork of CodeMirror 6 for the active editing surface.

## Current foundation

- `src/renderer/src/components/editor/CodeEditor.tsx` owns the surrounding product UI: tabs, file tree, save/format actions, disk-change conflict handling, plugin editor actions, and search-result jumps.
- `src/renderer/src/components/editor/CrewCodeMirrorEditor.tsx` owns the live editing surface.
- CodeMirror is intentionally kept below `CodeEditor` so high-frequency typing, selection, autocomplete, and scroll state do not force broad React/App re-renders.
- Source documents, including Markdown opened in the code editor, soft-wrap long lines by default. Wrapping is visual only: it never inserts newlines or changes line-number semantics.
- Direct `@codemirror/*` dependencies are declared in `package.json` as local `file:` dependencies. npm links them to the package sources under `packages/crew-codemirror`, so locally built changes are used by CrewCode at runtime.

## Local CodeMirror development

CodeMirror 6 is split across independent repositories. `packages/crew-codemirror` is the official development orchestrator, and its `state`, `view`, `autocomplete`, language, and other child directories are the actual package repositories.

```bash
npm run codemirror:install
npm install --legacy-peer-deps
npm run codemirror:build
npm run codemirror:status
```

- Run `codemirror:install` only to bootstrap or deliberately reset/update the workspace. Upstream's installer hard-resets every child package to its `origin/main`, so it will discard uncommitted package edits.
- Edit a package's `src/` files, then run `npm run codemirror:build`. `npm run codemirror:dev` watches and rebuilds all CodeMirror packages while developing.
- Each child package is its own Git repository. Commit custom work in the package repository and point its remote at the intended fork before sharing it; the orchestrator does not combine package history into one repository.
- CrewCode links its directly imported packages, including `autocomplete`, `commands`, enabled language packages, `language`, `lint`, `lsp-client`, `state`, and `view`. Their compatible transitive dependencies are deduplicated by npm.

## Editor themes

**Settings → Code Editor → Editor theme** controls the code canvas independently from the application chrome. The selection persists as `settings.editorTheme` and defaults to `crewcode`.

- `src/shared/editor-theme-types.ts` is the checked ID contract and rejects stale or unknown persisted values.
- `editor-theme-registry.ts` maps those IDs to all exports in `packages/crew-codemirror/theme-library`, grouped as CrewCode, dark, and light choices in Settings.
- `CrewCodeMirrorEditor` installs the selected extension through a CodeMirror `Compartment`. Switching themes reconfigures only the theme extension, preserving the document, selection, undo history, LSP session, and scroll position.
- CrewCode's structural editor rules—font, spacing, borders, and tooltip shape—remain active. A selected library theme overrides the canvas colors and syntax highlighting.

## File icons

The editor file tree and open-file tabs use Bearded Icons 1.22.0. `bearded-file-icons.tsx` resolves icons in this order:

1. Exact case-insensitive filename mapping, such as `package.json`.
2. Longest compound extension, such as `test.tsx`, before the final extension.
3. VS Code language-ID fallback for common source extensions such as `ts`, `tsx`, `py`, and `rs`.
4. The Bearded generic file icon.

Folders use distinct closed and expanded assets. The original SVG sources, `icons.json` mapping, attribution, and GPL-3.0 license are vendored under `src/renderer/src/assets/bearded-icons/`; do not replace them with references into `.crewcode/`, which is local-only and excluded from production builds.

## Document outline

The file-tree **Outline** tab displays symbols for the active document and navigates the CodeMirror selection when a symbol is clicked.

- TypeScript and JavaScript use hierarchical `textDocument/documentSymbol` responses from the shared language server, including classes, interfaces, methods, functions, variables, enums, modules, and types.
- Python, Rust, Markdown/MDX, CSS-family, HTML/XML/SVG, and TS/JS without an available language server use the bounded local fallback in `editor-outline.ts`.
- Extraction is scheduled and debounced inside `CrewCodeMirrorEditor`; high-frequency document state is not lifted into `App.tsx`.
- A response is accepted only while the CodeMirror document identity that requested it remains current, preventing stale symbols after edits or file switches.
- The UI presents explicit “open a file” and “no symbols found” states instead of the previous permanent placeholder.

## Autocomplete layers

The first implemented layer is local word completion from the current document:

1. Local current-document word completions.
2. Language-aware completions via TypeScript/LSP or per-language services.
3. CrewCode-agent ghost text completions using existing agent providers.
4. Tab behavior priority: accept ghost text, accept completion menu item, otherwise indent.

Layers 1, 2, and 3 are implemented for TypeScript and JavaScript. Agent completions use `agent:completion` / `agent:completionCancel`, not GitHub Copilot APIs. The main process starts a disposable provider bridge with `toolPolicy: 'read-only'`, no conversation key or resume state, bounded prefix/suffix context, a 20-second timeout, and hard cancellation on a new edit/cursor position. Built-in providers are allowlisted; plugin providers are intentionally excluded from this first version.

Ghost text must never contain model reasoning. Two independent guards enforce this, and both are required:

1. **Reasoning off at the provider** — the disposable completion bridge starts with `thinking: 'off'`, so providers with native reasoning effort (claude, codex, pi, hermes, opencode) do not reason for a completion at all.
2. **Sanitize the output** — `src/main/agents/completion-text.ts` is the single shared normalizer for every completion route (bridge providers and the hosted OpenCode Go route). It strips complete `<think>` / `<thinking>` / `<reasoning>` blocks, treats an unterminated opening block as "all reasoning, no completion", then unwraps a single Markdown fence. Guard 1 does not cover models that serialize hidden reasoning into the *content* stream (common on local ollama models and DeepSeek/Qwen-class models via OpenRouter), which is why the sanitizer cannot be dropped. Behavior is pinned by `completion-text.test.ts`.

Bridges route structured reasoning to `thinking_delta`, and the completion handler only accumulates `text_delta` — do not start accumulating `thinking_delta` into completion output.

Editor AI completion is disabled by default to avoid unexpected provider usage. Users enable it in **Settings → Editor completion**, then choose the provider and completion model independently from chat. Prefer a mini/fast model for low latency. TypeScript language intelligence is local workspace tooling and does not call an AI provider.

## TypeScript and JavaScript language intelligence

TypeScript-family files (`ts`, `tsx`, `mts`, `cts`, `js`, `jsx`, `mjs`, and `cjs`) connect CodeMirror's `@codemirror/lsp-client` to `typescript-language-server` over an Electron IPC transport.

- One renderer-side LSP client and one language-server process are shared per workspace. The client stays warm for 30 seconds after the final TS/JS editor unmounts to avoid churn during tab switches.
- Local workspaces use CrewCode's bundled `typescript` and `typescript-language-server` packages.
- SSH workspaces launch `typescript-language-server --stdio` inside the remote workspace over the pooled SSH connection. The remote host must already have both `typescript` and `typescript-language-server` installed and available on its login-shell `PATH`; CrewCode never installs remote software automatically.
- Diagnostics render in CodeMirror's lint gutter and inline markers. The editor also keeps a bounded per-workspace diagnostic index (up to 500 items per document, 100 documents, and 2,000 rendered overall) for the resizable left-side **Problems** drawer. It opens beside the CodeMirror gutter without reducing editor height. Problem rows resolve their URI through the workspace sandbox before opening a file, and navigate to the reported line and column.
- LSP completion runs alongside current-document words, and completion `additionalTextEdits` provide TypeScript auto-import insertion.
- **CmdOrCtrl+.** requests `textDocument/codeAction` for the current selection and displays the available quick fixes/refactors. The first safe implementation applies only validated, non-overlapping text edits for the unchanged active document. It deliberately refuses server commands, stale responses, malformed ranges, and multi-file workspace edits until CrewCode has a reviewed multi-file preview/transaction flow.
- **Shift+F12** finds symbol references through LSP and displays sandboxed workspace locations in the left drawer. **F2** requests an LSP rename and previews every affected file/edit count before Apply. Rename rejects outside-workspace URIs, document operations, stale source text, malformed/overlapping edits, and affected dirty tabs. Writes verify the preview snapshot and roll back already-written files on failure; the same flow works through local filesystem or SSH SFTP APIs.

## Workspace search and replace

The FileTree Search tab extends its existing bounded content search with a replacement field and preview count. Search remains capped at 200 readable text files and 100 displayed matches to protect renderer responsiveness.

- Results are the replacement preview; clicking one still opens its exact line.
- Apply is blocked when any affected open tab has unsaved changes.
- Every file is re-read and compared with the search snapshot before writing, preventing stale replacements.
- Writes use the sandboxed local/SSH filesystem bridge and roll back files already written if a later write fails.
- Replacement is literal, with the existing case-sensitive toggle controlling matching.
- Hover and signature help are enabled. LSP-provided Markdown is sanitized before insertion into the renderer.
- **F12** requests `textDocument/definition`. Definitions inside the workspace open through the existing sandboxed editor file APIs and move the cursor to the returned location. Definitions outside the workspace are refused rather than bypassing the filesystem sandbox.
- The main process validates renderer messages, caps protocol frames at 8 MiB, and frames/unframes JSON-RPC with standard `Content-Length` headers. Language servers stop on workspace/client release and application shutdown.

## Hosted API completion routes

The editor exposes two dedicated HTTP routes that avoid spawning a CLI bridge for every suggestion:

- **OpenCode Go API** — OpenCode Go routes models through their documented compatible APIs: Chat Completions models use `https://opencode.ai/zen/go/v1/chat/completions`, while MiniMax models use the Anthropic-compatible `https://opencode.ai/zen/go/v1/messages` endpoint. It defaults to `minimax-m3` and sends at most one hosted request per qualifying editor input.
- **AI trigger gate** — Ghost completion is scheduled only after a direct CodeMirror typing/paste event that inserts at least one non-whitespace character. Return, whitespace, deletes, cursor movement, focus, scrolling, selection changes, external reloads, and programmatic ghost acceptance never start a request; typing cancels and replaces any pending request. It waits 80ms after input and sends 3,500 characters before and 1,000 after the cursor to favor low latency.
- **OpenRouter API** — reuses CrewCode’s existing OpenRouter API key and model catalog.

These are completion-only choices, not chat-agent providers. Their keys are stored by the main-process `agent-keys.json` store with owner-only permissions, never in renderer settings/localStorage. Both requests are ephemeral: no completion prompt or reply is read from or written to conversation history.

## Performance rules

- Do not move CodeMirror document state into `App.tsx`.
- Do not send an agent autocomplete request on every keystroke without debounce and cancellation; the current debounce is 80 ms.
- Bound autocomplete context by bytes/tokens before sending it to an agent provider; main enforces 12,000 prefix characters and 4,000 suffix characters.
- Typing must never wait for AI or LSP responses.
- Preserve SSH/remote workspaces: completion context may describe remote paths, but provider execution must not assume local-only file access.

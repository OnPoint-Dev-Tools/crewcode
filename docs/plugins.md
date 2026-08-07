# CrewCode plugins

CrewCode plugins are local extensions loaded from `~/.crewcode/plugins`. The v0 contract is local-first: manifest schema, isolated panel UI, `crewcode-plugin-api`, explicit permissions, and static asset loading through CrewCode's plugin protocol.

## Install layout

CrewCode always loads plugin UI as static assets. Authors can either write **no-build plugins** directly as HTML/CSS/JS or write **bundled plugins** with TypeScript/React/Vite and build them first.

```txt
~/.crewcode/plugins/my-plugin/
  crewcode.plugin.json
  panel.html
  assets/index.js
```

A bundled TypeScript/React plugin should compile to static assets before CrewCode loads it. Templates can include checked-in compiled assets so copying works immediately:

```txt
my-plugin/
  crewcode.plugin.json
  src/main.tsx
  src/panel.html
  compiled/src/panel.html
  compiled/assets/index.js
```

The manifest tab entry points at the compiled file, for example `compiled/src/panel.html`.

## Install from Git

Users can install community plugins without downloading an archive:

1. Open the **Plugins** page.
2. Select **Install plugin**.
3. Paste the plugin's public HTTPS Git repository URL.
4. Review the pinned commit, manifest, requested permissions, and repository size.
5. Select **Install unapproved**, then approve the installed plugin separately.

Git-installed plugins record their repository URL and exact commit in CrewCode's local source registry. Use the download action on an installed plugin to inspect the repository's current default-branch commit. CrewCode shows the proposed version and permissions before installing an update. Every installed revision returns to the unapproved state, even when its permission list is unchanged. The previous installed folder moves to a dated `~/.crewcode/plugin-backups/` entry before an update is activated.

Repository installation intentionally supports public HTTPS repositories only. Private credentials, SSH URLs, URL query parameters, and fragments are rejected.

### Repository rules

A repository that users can install must follow these rules:

- `crewcode.plugin.json` must be at the repository root and its `id` must remain stable across updates.
- All runtime UI must already be built and checked in. CrewCode never runs `npm install`, package-manager hooks, build scripts, or repository code while installing.
- The repository cannot contain Git submodules, symbolic links, `node_modules`, or special filesystem entries.
- The checked-out plugin is limited to 3,000 files, 10 MB per file, and 50 MB total.
- Manifest entries and plugin API compatibility must pass the same validation as local plugins.
- An installed plugin ID cannot be silently replaced by a different repository.
- Updates are installed from a pinned commit and require a new explicit approval before contributions become active.

These rules keep installation reproducible and prevent a plugin repository from turning installation itself into a code-execution path. Plugin runtime permissions remain a separate trust decision.

## Contribution states

CrewCode now treats plugin contributions as three separate states:

- **Declared**: present in `crewcode.plugin.json`. These show up in plugin diagnostics even when not active.
- **Globally active**: the plugin is enabled and approved, and the contribution has any required permission gate.
- **Workspace active**: globally active plus enabled for the current workspace. Missing workspace entries default to enabled so existing local plugins keep working until a user disables them for a workspace.

This prevents “install plugin = every action appears everywhere” while preserving local-first defaults for v0. Session-level plugin enablement is still future work.

## Manifest

Every plugin needs `crewcode.plugin.json`.

```json
{
  "$schema": "../../../schemas/crewcode.plugin.schema.json",
  "id": "codebase-graph-lite",
  "name": "Codebase Graph Lite",
  "version": "0.1.0",
  "crewcode": { "apiVersion": "0.1" },
  "permissions": ["workspace:read"],
  "contributes": {
    "tabs": [
      {
        "id": "main",
        "title": "Codebase Graph Lite",
        "icon": "grid",
        "entry": "panel.html",
        "singleton": true
      }
    ],
    "sidebarPanels": [
      {
        "id": "sidebar",
        "title": "Graph",
        "icon": "sidebar",
        "entry": "panel.html"
      }
    ],
    "statusItems": [
      {
        "id": "graph-ready",
        "title": "Codebase Graph Lite",
        "text": "graph lite",
        "icon": "grid",
        "sidebarPanel": "sidebar"
      }
    ],
    "editorActions": [
      {
        "id": "show-in-graph",
        "title": "Show in Graph Lite",
        "icon": "grid",
        "sidebarPanel": "sidebar"
      }
    ],
    "chatActions": [
      {
        "id": "inspect-chat",
        "title": "Inspect chat with Graph Lite",
        "icon": "grid",
        "sidebarPanel": "sidebar",
        "messageRole": "any"
      }
    ]
  }
}
```

The schema lives at `schemas/crewcode.plugin.schema.json`.

Compatibility is enforced at registry load time. v0 currently supports only `crewcode.apiVersion: "0.1"`; unsupported API versions are rejected with a message that names the plugin's requested version and the versions supported by the running CrewCode build.

## Contribution points

Current stable-contract candidates:

- `contributes.tabs` — opens isolated plugin panels in CrewCode tabs.
- `contributes.sidebarPanels` — opens isolated plugin panels in the right plugin sidebar rail.
- `contributes.statusItems` — renders small clickable indicators in the workspace dock/status strip.
- `contributes.editorActions` — renders small actions in code/markdown editor toolbars for the active file.
- `contributes.chatActions` — renders safe actions in the chat context menu.
- `contributes.chatHeaderItems` — renders controlled buttons/badges in the chat header.
- `contributes.commands` — registers command palette entries.
- `contributes.mcpServers` — declares local MCP server commands for CrewCode-controlled agent tool routing.
- `contributes.agentProviders` — declares plugin-powered agent providers. Supported runtimes are listed below; `mock` is testing-only.
- `contributes.gitLenses` — renders read-only Git sidebar lenses/actions.
- `contributes.missionWidgets` — renders display-only Mission Control widgets/actions.
- `contributes.terminalWatchers` — renders opt-in terminal pane watcher actions; no output stream is sent yet.
- `contributes.browserActions` — renders explicit browser toolbar actions; no cookies/storage/page text are sent automatically.

Panel entries must be relative paths inside the plugin folder. Absolute paths and path escapes are rejected.

MCP server contributions are manifest declarations only: plugin UI does not spawn processes or receive secrets. CrewCode owns MCP lifecycle and permission approval. A plugin must request `mcp:server` before approved MCP server contributions appear in the registry.

Agent provider contributions are first-class SoloChat/Crew Worker agents, not terminal shortcuts. The manifest declares the provider, CrewCode adds it to the normal agent selector and crew config, and CrewCode owns bridge lifecycle. The plugin iframe still receives no Node/Electron access.

Supported provider runtimes:


| Runtime             | Required permissions               | How it works                                                                                                                                                                                                                                 | Best for                                                                                 |
| ------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `mock`              | `agent:provider`                   | CrewCode emits a deterministic bridge response. Testing-only fixture, not a real runtime.                                                                                                                                                    | Provider registration tests.                                                             |
| `exec`              | `agent:provider`, `terminal:spawn` | CrewCode spawns `command` with `args` without shell interpretation. `{{prompt}}` and `{{cwd}}` placeholders are replaced. If `{{prompt}}` is not used, CrewCode writes the prompt to stdin. stdout/stderr stream back as the agent response. | CLI agents like GitHub Copilot CLI, Grok CLI, Kilo Code CLI, Aider/Goose-style wrappers. |
| `http`              | `agent:provider`, `network:fetch`  | CrewCode POSTs `{ prompt, cwd, model, provider }` to `endpoint`. Response may be plain text or JSON with `text`, `response`, `message`, `output`, or a configured `responsePath`.                                                              | Company/internal agent APIs and simple local gateways.                                   |
| `sse-http`          | `agent:provider`, `network:fetch`  | CrewCode POSTs like `http`, then reads `data:` server-sent events until completion. `requestFormat: "openai-chat"` can be used for OpenAI-shaped streaming endpoints.                                                                         | Streaming HTTP gateways.                                                                 |
| `openai-compatible` | `agent:provider`, `network:fetch`  | CrewCode POSTs OpenAI chat-completions JSON to `/v1/chat/completions` and reads `choices[0].message.content`. Optional `apiKeyEnv` sends a bearer token from the process environment.                                                        | LM Studio, vLLM, LiteLLM, Ollama/OpenAI-compatible proxies, company model routers.       |
| `stdio-jsonrpc`     | `agent:provider`, `terminal:spawn` | CrewCode spawns a command and sends a JSON-RPC line with method `prompt`; line-delimited JSON responses can emit `text`, `delta`, or `done`.                                                                                                 | Structured local agents without terminal scraping.                                       |
| `websocket`         | `agent:provider`, `network:fetch`  | CrewCode opens a WebSocket, sends prompt JSON, streams text/JSON messages until `done` or close.                                                                                                                                             | Long-lived local/company agents with bidirectional transport.                            |


Runtime limits for v0 providers:

- Turns time out after 60 seconds by default. `timeoutMs` is allowed but clamped to 5–300 seconds.
- Output is capped at 256 KB per turn by default. `maxOutputBytes` is allowed but clamped to 8 KB–1 MB. Over-limit output fails the turn and kills/aborts the provider request.
- `abort`/`stop` sends `SIGTERM` to spawned providers and aborts in-flight HTTP requests.
- `exec` stderr streams into the visible response for CLI compatibility; a non-zero exit still marks the turn failed.
- `apiKeyEnv` may reference an existing environment variable for provider auth. Secrets are not stored in plugin manifests or injected into plugin iframes.
- `requestFormat: "openai-chat"` lets `http`/`sse-http` providers reuse the OpenAI chat request body without changing runtime.
- `responsePath` can extract custom JSON text fields, e.g. `choices.0.message.content`. It must resolve to a string; a non-string value falls through to the default field chain.
- Payload extraction lives in `src/main/agents/plugin-provider-payload.ts`. Stream frames (SSE events, websocket messages) that carry no text emit nothing — an unrecognized JSON frame is never echoed into the transcript, because OpenAI-shaped streams end with role-only, empty-delta, and usage-only chunks. Single-shot response bodies still fall back to the raw body, since there the body is the reply.
- Provider success/failure events are recorded in the Plugins page debug log.
- Provider plugins show an auth warning in the Plugins page until first-class plugin secret storage exists.

```json
{
  "permissions": ["mcp:server"],
  "contributes": {
    "mcpServers": [
      {
        "id": "linear",
        "title": "Linear MCP",
        "command": "npx",
        "args": ["-y", "@company/linear-mcp"],
        "category": "issues"
      }
    ]
  }
}
```

Mock provider example:

```json
{
  "permissions": ["agent:provider"],
  "contributes": {
    "agentProviders": [
      {
        "id": "mock-reviewer",
        "title": "Mock Reviewer",
        "runtime": "mock",
        "models": ["mock-default"]
      }
    ]
  }
}
```

Exec provider example:

```json
{
  "permissions": ["agent:provider", "terminal:spawn"],
  "contributes": {
    "agentProviders": [
      {
        "id": "copilot-cli",
        "title": "GitHub Copilot CLI",
        "runtime": "exec",
        "command": "gh",
        "args": ["copilot", "-p", "{{prompt}}"],
        "models": ["copilot-cli"]
      }
    ]
  }
}
```

HTTP provider example:

```json
{
  "permissions": ["agent:provider", "network:fetch"],
  "contributes": {
    "agentProviders": [
      {
        "id": "company-http",
        "title": "Company HTTP Agent",
        "runtime": "http",
        "endpoint": "http://localhost:8787/agent",
        "models": ["company-default"]
      }
    ]
  }
}
```

HTTP requests use this shape:

```json
{
  "prompt": "user prompt text",
  "cwd": "/active/workspace/path",
  "model": "company-default",
  "provider": "plugin-id:provider-id"
}
```

## Permissions

Plugins declare permissions up front. Main process capability handlers enforce them.

Currently implemented as iframe capability methods:

| Permission        | Methods                                     |
| ----------------- | ------------------------------------------- |
| `workspace:read`  | `workspace:listFiles`, `workspace:readFile` |
| `workspace:write` | `workspace:writeFile`                       |

Contribution-gate permissions:

- `agent:provider` — allows an approved plugin to register agent providers. Spawned runtimes additionally require `terminal:spawn`; network runtimes additionally require `network:fetch`.
- `mcp:server` — allows an approved plugin to register local MCP server commands. CrewCode owns spawning/routing.
- `terminal:spawn` — required by `exec` and `stdio-jsonrpc` agent provider runtimes.
- `network:fetch` — required by `http`, `sse-http`, `openai-compatible`, and `websocket` agent provider runtimes.

Declared but not exposed as general iframe capabilities yet:

- `git:read`
- `git:write`
- `terminal:read`
- `agent:prompt`
- `browser:read`
- `secrets:read`

Explicitly reserved iframe methods:

- `network:fetch` — denied from plugin iframes even when permission is declared; provider runtimes are the current safe network path.
- `secrets:get` — denied from plugin iframes even when `secrets:read` is declared; use CLI auth, local endpoints, or provider `apiKeyEnv` for now.

Remote SSH workspaces are denied in plugin API v0 until the remote backend has safe capability routes.

## Browser API

Plugin UI is sandboxed and does not receive `window.electronAPI`. Use the plugin browser API instead:

```ts
import { crewcode } from 'crewcode-plugin-api'

crewcode.onContext(ctx => {
  console.log(ctx.workspace?.name)
  console.log(ctx.openContext.source) // e.g. editor-action, git-lens, browser-action
})

const { files } = await crewcode.workspace.listFiles()
const file = await crewcode.workspace.readFile('src/App.tsx')
await crewcode.workspace.writeFile('notes/plugin.txt', 'hello')
```

`ctx.hostApiVersion` reports the plugin API version of the running CrewCode, so a plugin can feature-detect at runtime in addition to the manifest-level `crewcode.apiVersion` gate. `ctx.openContext` is intentionally minimal. Depending on where the user opened the panel/action it may include `filePath`, `browserUrl`, `terminalPaneId`, or `chatMessageId`; plugins should treat all fields as optional. Browser actions receive the live BrowserTab URL, terminal watcher actions receive the clicked pane id, and chat actions receive the latest message/turn id when available.

`packages/crewcode-plugin-api` is the official v0 API source. No-build templates vendor its canonical `browser/crewcode-plugin-api.js` helper; bundled TypeScript templates vendor the typed source until the package is published.

## Templates and dogfood plugins

Template guidance lives in `docs/plugin-templates.md`. Bundled folders under `examples/plugins/` test the contract before CLI/SDK work:

- `static-panel-template` — no-build HTML/CSS/JS starter panel.
- `typescript-panel-template` — TypeScript/React starter that builds static assets for an isolated iframe.
- `mcp-server-template` — MCP server contribution starter with a stdio skeleton.
- `codebase-graph-lite` — baseline read-only graph panel using tabs, sidebar panels, status items, editor actions, and chat actions.
- `repo-radar` — read-only workspace scanner for TODOs, risk signals, and source mix. It stresses repeated `workspace:listFiles`/`workspace:readFile` calls and contribution-point discoverability.
- `handoff-pack` — read/write handoff generator that creates `.crewcode/handoffs/*.md`. It validates permission approval for `workspace:write`, chat header items, and a practical team workflow.
- `mock-agent-provider` — contributes a testing-only mock bridge agent. It validates `agent:provider`, plugin agent discoverability, and bridge lifecycle without shell/network access.
- `github-copilot-cli-provider` — contributes an `exec` provider using `gh copilot suggest`; validates real CLI-backed agent providers for users with the GitHub Copilot CLI extension installed.
- `company-agent-http-adapter` — contributes an `http` provider and local test server template for company/internal agent APIs.
- `openai-compatible-provider` — contributes an `openai-compatible` provider template for local/company OpenAI-shaped gateways.
- `git-risk-lens` — contributes a read-only Git sidebar lens.
- `mission-ci-widget` — contributes a display-only Mission Control widget.
- `terminal-watchdog-lite` — contributes an opt-in terminal pane watcher action without output streaming.
- `browser-docs-grabber` — contributes a browser toolbar action without automatic page data access.

## Dev loop

CrewCode watches `~/.crewcode/plugins` while the app is open. Git installs, updates, and local folder changes refresh the registry and reload open plugin iframes without restarting CrewCode.

In the dedicated Plugins page you can install a public Git repository, check Git-installed plugins for updates, refresh the registry manually, open the plugins folder, open each plugin folder/manifest, approve/revoke/disable plugins, and review categorized debug events: manifest validation, asset load, iframe runtime errors, capability denials, provider spawn failures, provider HTTP failures, and provider successes.

Plugin iframes also have a reload button. The browser API reports uncaught errors and unhandled promise rejections back to CrewCode so runtime failures are visible in the panel host and Settings debug log.

## Security model

```txt
plugin iframe
  -> postMessage
  -> trusted renderer forwarder
  -> main process permission gate
  -> approved capability / CrewCode-owned MCP lifecycle
```

Rules:

- Plugin panels load through `crewcode-plugin://`, not raw `file://`.
- Plugin protocol responses include explicit MIME types, `X-Content-Type-Options: nosniff`, and restrictive CSP for HTML panels.
- Plugin iframe popups are blocked; external window opens are denied by default and safe web/mail links are opened externally by the shell.
- Plugin UI never receives trusted renderer APIs.
- Manifest entries are validated before registration.
- Git installation never runs repository scripts and rejects symlinks, submodules, embedded dependencies, and oversized checkouts.
- Each installed or updated Git revision requires explicit approval before activation.
- Capability calls and contributed MCP servers check manifest permissions.
- Workspace paths are kept under the workspace root.
- Remote workspaces are denied for v0.

## CLI workflow

The standalone `crewcode-plugin-cli` package (`npm install -g crewcode-plugin-cli`, once published — until then run it from the repo via `npm run crewcode`) exposes a `crewcode` command with plugin subcommands for the local-first v0 workflow.

```bash
crewcode plugin create my-plugin --template static-panel
crewcode plugin dev ./my-plugin
crewcode plugin package ./my-plugin
```

- `crewcode plugin create <id>` copies a template from `examples/plugins/`, rewrites the manifest id/name, points `$schema` at the official schema URL, and validates the result.
- `crewcode plugin dev [pluginDir]` validates the manifest and installs the plugin into `~/.crewcode/plugins/<id>` as a symlink/junction by default. Use `--copy` for copy mode, `--build` to run `npm run build` first, and `--watch` to run the plugin's `npm run dev` script after install.
- `crewcode plugin package [pluginDir]` validates the manifest, runs `npm run build` when available unless `--no-build` is passed, and writes `dist/<id>-<version>.crewcode-plugin.tgz` plus a SHA-256 summary JSON.

Supported create templates: `static-panel`, `typescript-panel`, `mock-agent`, `http-agent`, `openai-agent`, `exec-agent`, `mcp`, `browser-action`, and `git-lens`.

## Officialization checklist

Done:

- `schemas/crewcode.plugin.schema.json` is the manifest contract.
- Tests cover manifest validation, protocol path safety, and permission denial (`plugin-contract.test.ts`, `plugin-examples.test.ts`, `crewcode-plugin-cli.test.ts`).
- More than three real plugins are dogfooded under `examples/plugins/`.
- `crewcode plugin create/dev/package` ships in `packages/crewcode-plugin-cli`.

Remaining before the v1 bump:

1. Publish `packages/crewcode-plugin-api` to npm (currently unpublished; bundled plugins vendor the source).
2. Publish `packages/crewcode-plugin-cli` to npm.

Marketplace, signing, and package review are intentionally out of v0 scope.

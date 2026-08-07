# CrewCode plugin templates and dogfood examples

Use these folders as local plugin starting points. Copy one into `~/.crewcode/plugins/<plugin-id>`, refresh the Plugins page, approve it, then edit from there.

## Starter templates

| Template | Use when | Key files |
| --- | --- | --- |
| `static-panel-template` | You want a no-build HTML/CSS/JS panel. | `crewcode.plugin.json`, `panel.html`, `plugin.js`, `crewcode-plugin-api.js` |
| `typescript-panel-template` | You want a bundled TypeScript/React panel compiled to static assets. | `src/`, `vite.config.ts`, manifest entry `compiled/src/panel.html` |
| `mock-agent-provider` | You want to add a new agent provider shape before shell/network integration. | `contributes.agentProviders`, `runtime: mock` |
| `company-agent-http-adapter` | You want an HTTP-backed company/local agent provider. | `runtime: http`, `server.mjs` |
| `openai-compatible-provider` | You want an OpenAI-compatible model gateway. | `runtime: openai-compatible`, `apiKeyEnv` |
| `github-copilot-cli-provider` | You want an exec-backed CLI agent provider. | `runtime: exec`, `terminal:spawn` |
| `mcp-server-template` | You want to declare a local MCP server. | `contributes.mcpServers`, `server.mjs` |
| `browser-docs-grabber` | You want a browser toolbar action. | `contributes.browserActions` |
| `git-risk-lens` | You want a git/sidebar review lens. | `contributes.gitLenses` |

## Template rules

- Use `crewcode-plugin-api` as the only plugin UI API. No-build plugins vendor `crewcode-plugin-api.js`; bundled plugins import or vendor the typed source.
- Keep plugin UI sandboxed. Do not import plugin React components into CrewCode's trusted renderer.
- Keep `crewcode.apiVersion` pinned to a supported version, currently `"0.1"`.
- Add only the permissions your template needs; approval and changed-permission warnings are based on the manifest permission set.
- Treat `openContext` fields as optional. Actions opened from editor, browser, terminal, chat, git, or restored tabs provide different subsets.

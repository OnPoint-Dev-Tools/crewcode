# Plugin templates

CrewCode ships local plugin templates under `examples/plugins/`. They are intentionally copyable folders, not a CLI generator yet.

Terminology: **no-build plugins** are plain HTML/CSS/JS copied as-is. **Bundled plugins** are authored with TypeScript/React/Vite and built to static assets before CrewCode loads them.

## Copy workflow

1. Copy a folder from `examples/plugins/` into `~/.crewcode/plugins/`.
2. Open Settings → Plugins.
3. Refresh the plugin registry.
4. Approve the plugin after reviewing permissions.
5. Edit the copied folder and refresh again.

## Recommended starting points

- **No-build panel**: `examples/plugins/static-panel-template`
  - No build step.
  - Best for workspace dashboards, lightweight repo lenses, and proof-of-concept panels.
- **TypeScript/React panel**: `examples/plugins/typescript-panel-template`
  - Includes checked-in `compiled/` assets so it runs immediately after copying.
  - Vendors the official `crewcode-plugin-api` typed source until the package is published.
  - Rebuilds TypeScript/React source into `compiled/` after edits.
  - Best for richer UI while keeping iframe isolation.
- **Agent provider**:
  - `examples/plugins/mock-agent-provider` for registry/selector/lifecycle validation only.
  - `examples/plugins/company-agent-http-adapter` for brokered HTTP providers.
  - `examples/plugins/openai-compatible-provider` for OpenAI-compatible model gateways.
  - `examples/plugins/github-copilot-cli-provider` for brokered CLI providers.
- **MCP server**: `examples/plugins/mcp-server-template`
  - Declares `contributes.mcpServers` and a local stdio server skeleton.
- **Browser action**: `examples/plugins/browser-docs-grabber`
  - Validates explicit browser action placement without automatic page data access.
- **Git lens**: `examples/plugins/git-risk-lens`
  - Validates git/sidebar review placement and read-only workspace scanning.

## Contract guardrails

- Current supported plugin API: `crewcode.apiVersion: "0.1"`.
- Use `packages/crewcode-plugin-api` as the canonical API source: no-build plugins vendor `browser/crewcode-plugin-api.js`, bundled plugins import or vendor the typed package source.
- Plugin panels load through `crewcode-plugin://` and run in sandboxed iframes.
- Plugin UI never receives `window.electronAPI`.
- Remote SSH workspaces remain denied for plugin capability calls in v0.
- Network and secrets are not general iframe capabilities. Provider runtimes, CLI auth, local endpoints, and `apiKeyEnv` are the current safe paths.

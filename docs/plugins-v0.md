# CrewCode plugin platform v0

CrewCode plugins are local-first extensions loaded from `~/.crewcode/plugins`. Community plugins can also be staged from public HTTPS Git repositories, reviewed at a pinned commit, and installed without executing repository scripts. The current v0 contract is documented in `docs/plugins.md`; this file is the shorter implementation snapshot.

> **Status (pre-v1):** The v0 contract has stabilized. The CLI (`crewcode plugin create/dev/package`) and `packages/crewcode-plugin-api` are both built and tested — see `docs/plugins.md` for their documented behavior. The only remaining gates before the v1 bump are operational, not code: publish `crewcode-plugin-api` + `crewcode-plugin-cli` to npm

## Current v0 shape

A no-build plugin folder contains a checked manifest and static UI assets:

```txt
~/.crewcode/plugins/codebase-graph-lite/
  crewcode.plugin.json
  panel.html
  crewcode-plugin-api.js
  plugin.js
```

A bundled TypeScript/React plugin is authored in `src/`, built to static assets, and points its manifest entry at the built HTML file. CrewCode does not import plugin React components into the trusted renderer.

## Isolation rule

Plugin UI runs in a sandboxed iframe. It does not receive `window.electronAPI`.

```txt
plugin iframe
  -> postMessage request
    -> trusted renderer forwarder
      -> main-process plugin permission gate
        -> approved CrewCode capability
```

## v0 contribution points

The manifest currently supports tabs, sidebar panels, status items, editor/chat/header actions, commands, MCP server declarations, agent providers, git lenses, mission widgets, terminal watcher actions, and browser toolbar actions. See `schemas/crewcode.plugin.schema.json` for the exact checked shape.

## v0 iframe capabilities

The iframe permission gate currently supports:

- `workspace:listFiles` — requires `workspace:read`
- `workspace:readFile` — requires `workspace:read`
- `workspace:writeFile` — requires `workspace:write`

`network:fetch` and `secrets:get` are reserved and denied from plugin iframes. Agent provider runtimes are the current safe path for brokered network/CLI execution. Remote SSH workspaces are intentionally denied until the remote backend gets plugin-safe routes.

## v0 browser helper

No-build plugins include `crewcode-plugin-api.js`, the canonical browser helper from `packages/crewcode-plugin-api/browser`:

```html
<script src="crewcode-plugin-api.js"></script>
<script src="plugin.js"></script>
```

Bundled plugins import or vendor the typed source contract from `packages/crewcode-plugin-api`:

```ts
import { crewcode } from 'crewcode-plugin-api'
```

The API exposes `crewcode.apiVersion`, context listeners, workspace methods, and reserved network/secrets namespaces.

## Remaining before v1

The stabilization work below is done: tab lifecycle/restore, permission naming and denial messages, remote-workspace denial, schema/permission/protocol test coverage, and dogfooding across no-build, bundled, provider, MCP, browser, and git-lens plugins. The `crewcode` CLI ships `create/dev/package`.

Still open before the v1 bump:

1. Publish `packages/crewcode-plugin-api` to npm so bundled plugins can `import { crewcode } from 'crewcode-plugin-api'` without vendoring.
2. Publish `packages/crewcode-plugin-cli` to npm so authors can run `crewcode plugin ...`.

Marketplace, signing, hosted registries, and package review remain out of scope.

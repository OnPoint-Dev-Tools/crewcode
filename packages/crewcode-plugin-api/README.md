# crewcode-plugin-api

Official typed/browser API for isolated CrewCode plugin panels.

This package is the source contract for the v0 plugin bridge. Plugin UI still runs in a sandboxed iframe and never receives `window.electronAPI`; calls are forwarded through CrewCode's permission gate.

## TypeScript / bundled plugins

```ts
import { crewcode } from 'crewcode-plugin-api'

crewcode.onContext(ctx => {
  console.log(ctx.workspace?.name)
  console.log(ctx.openContext.source)
})

const { files } = await crewcode.workspace.listFiles()
const app = await crewcode.workspace.readFile('src/App.tsx')
```

## Static/no-build plugins

Copy the canonical browser helper from this package into your plugin folder:

```txt
crewcode-plugin-api.js
```

Then load it before your plugin code:

```html
<script src="crewcode-plugin-api.js"></script>
<script src="plugin.js"></script>
```

The helper exposes `window.crewcode` and `window.crewcode.apiVersion`. It is generated from this package's TypeScript source (`npm run build:browser`) — do not edit the vendored `.js` by hand.

`workspace.writeFile()` requires the plugin manifest permission `workspace:write`. `ctx.openContext` explains why/how the panel was opened and may include optional safe hints such as `filePath` or `browserUrl`.

## Custom timeout

Requests reject after 10 seconds by default. On large or SSH-backed workspaces you can widen it by building your own instance from the exposed factory:

```ts
import { createCrewCodeApi } from 'crewcode-plugin-api'
const crewcode = createCrewCodeApi({ timeoutMs: 30_000 })
```

The no-build helper also exposes `window.createCrewCodeApi` for the same purpose.

## Host version

The context payload carries `hostApiVersion` — the plugin API version of the running CrewCode. The manifest gate already rejects a plugin whose declared `crewcode.apiVersion` the host does not support, but you can also feature-detect at runtime:

```ts
crewcode.onContext(ctx => {
  if (ctx.hostApiVersion && ctx.hostApiVersion !== crewcode.apiVersion) {
    // adapt or warn
  }
})
```

## Reserved in v0

`crewcode.network.fetch()` and `crewcode.secrets.get()` are declared for forward-compatibility but are **reserved** — they reject immediately with an explanatory message. For network access use an `agentProvider` runtime (`http`/`sse-http`/`openai-compatible`/`websocket`); for auth use a provider `apiKeyEnv` or local CLI auth.

Do not put secrets in plugin HTML/JS or manifests. Plugin iframes never receive secrets.

# TypeScript panel plugin template

This template shows how CrewCode plugins can be authored in TypeScript/React while still loading as isolated static panel assets.

## Build

```bash
npm install
npm run build
```

The manifest points at `compiled/src/panel.html`. This checked-in compiled output lets the template run immediately after copying; rebuild it after editing `src/`.

```json
{
  "contributes": {
    "tabs": [{ "entry": "compiled/src/panel.html" }]
  }
}
```

## Install locally

Copy this folder into `~/.crewcode/plugins/typescript-panel-template`. It will run immediately from the checked-in `compiled/` assets. Build inside the copied folder after editing `src/`:

```bash
mkdir -p ~/.crewcode/plugins/typescript-panel-template
cp -R . ~/.crewcode/plugins/typescript-panel-template
cd ~/.crewcode/plugins/typescript-panel-template
npm install
npm run build
```

Restart CrewCode and open `TypeScript Plugin` from the command palette.

## API

`src/crewcode-api.ts` is vendored from the official `packages/crewcode-plugin-api` source contract so copied templates work before the package is published. When consuming the package directly, import `crewcode` from `crewcode-plugin-api`.

Plugins are declared in the manifest, become globally active after enablement + approval, and can be disabled per workspace from CrewCode's Plugins page.

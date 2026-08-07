# crewcode-plugin-cli

Command-line tool for scaffolding, developing, and packaging [CrewCode](https://github.com/OnPoint-Dev-Tools/crewcode) plugins. Exposes the `crewcode` binary.

## Install

```bash
npm install -g crewcode-plugin-cli
```

Or run without installing:

```bash
npx crewcode-plugin-cli plugin list
```

## Quick start

```bash
crewcode plugin list                                    # show all templates
crewcode plugin create my-plugin --template static-panel
crewcode plugin dev ./my-plugin                         # live-install for development
crewcode plugin package ./my-plugin                     # build a distributable archive
```

## Commands

- `crewcode plugin list` — list every bundled template with its aliases and description.
- `crewcode plugin create <id>` — scaffold a local plugin from a bundled template. Flags: `--template`, `--out`, `--name`, `--force`.
- `crewcode plugin dev [pluginDir]` — validate and install a plugin into `~/.crewcode/plugins` (override with `CREWCODE_PLUGINS_DIR`) as a symlink/junction by default. Flags: `--copy`, `--build`, `--watch`.
- `crewcode plugin package [pluginDir]` — validate, optionally build, and write a `.crewcode-plugin.tgz` plus a SHA-256 summary JSON. Flag: `--no-build`.

## Templates

Run `crewcode plugin list` for the current set with descriptions. Each has short aliases, e.g. `--template panel`, `--template react`, `--template mcp`.

## License

Apache-2.0.

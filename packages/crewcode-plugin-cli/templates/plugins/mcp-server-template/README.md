# MCP server plugin template

A starter layout for plugins that declare a local MCP server.

## What it demonstrates

- `mcp:server` permission and `contributes.mcpServers` manifest shape.
- A companion tab panel explaining the server contribution.
- A tiny stdio `server.mjs` skeleton for authors to replace with a real MCP SDK server.

## Install locally

```bash
mkdir -p ~/.crewcode/plugins/mcp-server-template
cp -R . ~/.crewcode/plugins/mcp-server-template
```

Refresh the Plugins page, approve the plugin, and enable its MCP server from CrewCode's MCP picker when available.

## Notes

The skeleton intentionally does not request network or secrets. Add those only after CrewCode's audited gates support your use case.

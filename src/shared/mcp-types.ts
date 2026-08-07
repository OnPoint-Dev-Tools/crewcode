// Shared MCP (Model Context Protocol) server contract. Kept as checked
// TypeScript (not .d.ts) so renderer settings, preload, and main agree on one
// shape for both the user-managed registry and the bridge:start wire payload.
// No Electron imports — this is loaded from the renderer too.

// Transport the server speaks. Only stdio is wired today; `sse`/`http` are
// reserved so the registry shape doesn't need a migration when remote servers
// land.
export type McpTransport = 'stdio' | 'sse' | 'http'

export interface McpServerConfig {
  // Stable id used to reference the server from a session's selection list.
  id: string
  // Human label shown in Settings and the composer picker.
  name: string
  // Executable launched to start the server (stdio) or base URL (sse/http).
  command: string
  // Extra argv passed to the command (stdio only).
  args?: string[]
  // Extra environment for the server process.
  env?: Record<string, string>
  transport?: McpTransport
}

// Result of reading the user-editable ~/.crewcode/mcp.json registry. `errors`
// holds per-entry/parse messages so the UI can surface a bad file without
// dropping the valid entries.
export interface McpFileSnapshot {
  path: string
  exists: boolean
  servers: McpServerConfig[]
  errors: string[]
}

// Map a registry entry to the ACP `session/new` `mcpServers` stdio shape
// (`{ name, command, args, env }`). ACP only models stdio servers, so non-stdio
// entries are filtered out by the caller.
export interface AcpMcpServer {
  name: string
  command: string
  args: string[]
  env: { name: string; value: string }[]
}

export function toAcpMcpServer(server: McpServerConfig): AcpMcpServer {
  return {
    name: server.name,
    command: server.command,
    args: server.args ?? [],
    env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value })),
  }
}

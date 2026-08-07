import type { McpServerConfig } from './useSettings'

// Combine the app-managed registry (Settings UI / localStorage) with servers
// defined in ~/.crewcode/mcp.json into one list for the composer and send path.
// App entries win on id collision (the user can see/manage them in the UI),
// file entries fill in the rest. Order is app-first, then file, both stable.
export function mergeMcpServers(
  appServers: McpServerConfig[],
  fileServers: McpServerConfig[],
): McpServerConfig[] {
  const byId = new Set(appServers.map(s => s.id))
  return [...appServers, ...fileServers.filter(s => !byId.has(s.id))]
}

// Resolve which MCP servers a chat session actually attaches, from three
// inputs: the global enable toggle, the user's server registry, and the
// session's opted-in ids. Pure so the send path and the composer badge share
// one definition (and it's unit-testable without React).
//
// Rules:
// - Global toggle off → nothing, regardless of selection (opt-in is moot).
// - Only ids that still exist in the registry count — a removed server can
//   linger in a persisted session and must not resurrect.
// - Order follows the registry, not the selection, so the result is stable.
export function resolveSessionMcpServers(
  enabled: boolean,
  registry: McpServerConfig[],
  selectedIds: string[] | undefined,
): McpServerConfig[] {
  if (!enabled) return []
  const ids = new Set(selectedIds ?? [])
  return registry.filter(s => ids.has(s.id))
}

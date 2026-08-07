// Pure parser for the user-editable MCP registry at ~/.crewcode/mcp.json.
// Kept free of Electron/fs imports so it can be unit-tested directly and reused
// wherever the raw JSON is available.
//
// Three input shapes are accepted, in priority order:
//   1. Standard MCP config:  { "mcpServers": { "<name>": { command, args, env } } }
//      — the de-facto format used by Claude/Cursor/etc. Key becomes the id+name.
//   2. Explicit list:        { "servers": [ { id, name, command, args, env } ] }
//   3. Bare array:           [ { id, name, command, args, env } ]
//
// Every malformed entry is skipped with a human-readable error rather than
// failing the whole file, so one bad block doesn't hide the rest.

import type { McpServerConfig, McpTransport } from '../shared/mcp-types'

export interface ParsedMcpConfig {
  servers: McpServerConfig[]
  errors: string[]
}

const VALID_TRANSPORTS: McpTransport[] = ['stdio', 'sse', 'http']

function asStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  if (!value.every(v => typeof v === 'string')) return undefined
  return value as string[]
}

function asEnv(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') return undefined
    out[k] = v
  }
  return out
}

// Build one server from a loose record. `fallbackId`/`fallbackName` apply to the
// map form where the key supplies identity. Returns an error string instead of a
// server when required fields are missing or mistyped.
function buildServer(
  raw: unknown,
  fallbackId: string | undefined,
  fallbackName: string | undefined,
  label: string,
): McpServerConfig | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return `${label}: expected an object`
  }
  const obj = raw as Record<string, unknown>

  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : fallbackId
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : (fallbackName ?? id)
  if (!id) return `${label}: missing "id" (or a map key to derive it from)`
  if (typeof obj.command !== 'string' || !obj.command.trim()) {
    return `${label}: missing or invalid "command"`
  }

  const args = asStringArray(obj.args)
  if (args === undefined) return `${label}: "args" must be an array of strings`
  const env = asEnv(obj.env)
  if (env === undefined) return `${label}: "env" must be a string→string map`

  const transport =
    typeof obj.transport === 'string' && VALID_TRANSPORTS.includes(obj.transport as McpTransport)
      ? (obj.transport as McpTransport)
      : 'stdio'

  return {
    id,
    name: name ?? id,
    command: obj.command.trim(),
    args,
    env,
    transport,
  }
}

export function parseMcpConfig(raw: unknown): ParsedMcpConfig {
  const servers: McpServerConfig[] = []
  const errors: string[] = []
  const seen = new Set<string>()

  const push = (built: McpServerConfig | string) => {
    if (typeof built === 'string') { errors.push(built); return }
    if (seen.has(built.id)) { errors.push(`duplicate server id "${built.id}" — keeping the first`); return }
    seen.add(built.id)
    servers.push(built)
  }

  if (Array.isArray(raw)) {
    raw.forEach((entry, i) => push(buildServer(entry, undefined, undefined, `servers[${i}]`)))
    return { servers, errors }
  }

  if (typeof raw !== 'object' || raw === null) {
    return { servers, errors: ['mcp.json: root must be an object or array'] }
  }

  const obj = raw as Record<string, unknown>

  // Standard map form.
  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    for (const [key, value] of Object.entries(obj.mcpServers as Record<string, unknown>)) {
      push(buildServer(value, key, key, `mcpServers.${key}`))
    }
  }

  // Explicit list form (can coexist with the map form in one file).
  if (Array.isArray(obj.servers)) {
    obj.servers.forEach((entry, i) => push(buildServer(entry, undefined, undefined, `servers[${i}]`)))
  }

  if (!obj.mcpServers && !obj.servers) {
    errors.push('mcp.json: expected a top-level "mcpServers" object or "servers" array')
  }

  return { servers, errors }
}

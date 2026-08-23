import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import os from 'os'

import { parseMcpConfig, type ParsedMcpConfig } from './mcp-config-parse'
import type { McpFileSnapshot } from '../shared/mcp-types'

/** Electron-free MCP registry reader shared by desktop IPC and the headless Brain. */
export function crewcodeMcpDir(): string {
  return join(os.homedir(), '.crewcode')
}

export function mcpConfigPath(): string {
  return join(crewcodeMcpDir(), 'mcp.json')
}

export function readMcpConfig(): McpFileSnapshot {
  const path = mcpConfigPath()
  if (!existsSync(path)) return { path, exists: false, servers: [], errors: [] }

  let parsed: ParsedMcpConfig
  try {
    parsed = parseMcpConfig(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    return { path, exists: true, servers: [], errors: [`mcp.json: ${(error as Error).message}`] }
  }
  return { path, exists: true, servers: parsed.servers, errors: parsed.errors }
}

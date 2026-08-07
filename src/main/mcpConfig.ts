import { ipcMain, shell, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import os from 'os'
import { parseMcpConfig, type ParsedMcpConfig } from './mcp-config-parse'
import type { McpFileSnapshot } from '../shared/mcp-types'

/**
 * ~/.crewcode/mcp.json is a user-editable MCP server registry. Settings reads it
 * (read-only, alongside the app-managed list) and the composer picker offers its
 * servers. Editing the file is the only way to change these entries — CrewCode
 * watches the file and broadcasts changes so Settings refreshes live.
 */

function crewcodeDir(): string {
  return join(os.homedir(), '.crewcode')
}

function mcpConfigPath(): string {
  return join(crewcodeDir(), 'mcp.json')
}

const TEMPLATE = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    }
  }
}
`

function ensureConfigFile(): string {
  const dir = crewcodeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = mcpConfigPath()
  if (!existsSync(file)) writeFileSync(file, TEMPLATE)
  return file
}

export function readMcpConfig(): McpFileSnapshot {
  const path = mcpConfigPath()
  if (!existsSync(path)) {
    return { path, exists: false, servers: [], errors: [] }
  }
  let parsed: ParsedMcpConfig
  try {
    const raw = readFileSync(path, 'utf8')
    parsed = parseMcpConfig(JSON.parse(raw))
  } catch (err) {
    return { path, exists: true, servers: [], errors: [`mcp.json: ${(err as Error).message}`] }
  }
  return { path, exists: true, servers: parsed.servers, errors: parsed.errors }
}

let mcpWatcher: FSWatcher | null = null

function broadcastMcpChanged(): void {
  const result = readMcpConfig()
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('mcp:changed', { at: Date.now(), ...result })
  })
}

function startMcpWatcher(): void {
  if (mcpWatcher) return
  const dir = crewcodeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  try {
    // Watch the directory (not the file) so create/delete/rename of mcp.json is
    // caught too — editors often replace-on-save rather than write in place.
    mcpWatcher = watch(dir, { persistent: false }, (_evt, filename) => {
      if (!filename || filename.toString() === 'mcp.json') broadcastMcpChanged()
    })
  } catch {
    // Watch is best-effort; manual refresh from Settings still works.
  }
}

export function registerMcpConfigIpc(): void {
  startMcpWatcher()

  ipcMain.handle('mcp:list', () => readMcpConfig())

  ipcMain.handle('mcp:openFile', () => {
    const file = ensureConfigFile()
    shell.openPath(file).then(err => {
      if (err) console.error('[mcp] openPath failed:', err)
    })
    return { ok: true, path: file }
  })
}

import { ipcMain, shell, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, writeFileSync, watch, type FSWatcher } from 'fs'
import { crewcodeMcpDir, mcpConfigPath, readMcpConfig } from './mcp-config-service'

/**
 * ~/.crewcode/mcp.json is a user-editable MCP server registry. Settings reads it
 * (read-only, alongside the app-managed list) and the composer picker offers its
 * servers. Editing the file is the only way to change these entries — CrewCode
 * watches the file and broadcasts changes so Settings refreshes live.
 */

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
  const dir = crewcodeMcpDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const file = mcpConfigPath()
  if (!existsSync(file)) writeFileSync(file, TEMPLATE)
  return file
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
  const dir = crewcodeMcpDir()
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

import { ipcMain, shell, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import os from 'os'

/**
 * ~/.crewcode/keys.json is the source of truth for shortcut overrides. The
 * renderer reads it on startup, writes it back when bindings change, and the
 * Settings button opens it for hand-editing. We watch the file and broadcast
 * changes so edits apply live (no restart). Keyed by stable action id; the
 * renderer's shortcuts.ts converters map ids ↔ runtime overrides.
 */

const KEYS_FILE_HELP =
  'CrewCode keybindings. Each key is an action id; the value is a list of tokens. ' +
  'Modifiers: Cmd, Ctrl, Alt, Shift (or glyphs ⌘ ⌃ ⌥ ⇧). Cmd maps to ⌘ on macOS ' +
  'and Ctrl elsewhere. Remove an entry to fall back to its default.'

function crewcodeDir(): string {
  return join(os.homedir(), '.crewcode')
}

function keysFilePath(): string {
  return join(crewcodeDir(), 'keys.json')
}

function readKeysFile(): { ok: boolean; data: Record<string, unknown> | null; error?: string } {
  try {
    const p = keysFilePath()
    if (!existsSync(p)) return { ok: true, data: null }
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    return { ok: true, data: parsed && typeof parsed === 'object' ? parsed : null }
  } catch (err) {
    return { ok: false, data: null, error: err instanceof Error ? err.message : 'failed to read keys.json' }
  }
}

function writeKeysFile(data: Record<string, unknown>): void {
  const p = keysFilePath()
  if (!existsSync(crewcodeDir())) mkdirSync(crewcodeDir(), { recursive: true })
  const payload = { _comment: KEYS_FILE_HELP, ...(data ?? {}) }
  writeFileSync(p, JSON.stringify(payload, null, 2) + '\n', 'utf8')
}

let keysWatcher: FSWatcher | null = null
// File saves often fire multiple fs events (editors replace-on-save); debounce
// so we broadcast once per logical edit. Skip the echo from our own writes.
let lastBroadcast = 0

function broadcastKeysChanged(): void {
  const result = readKeysFile()
  lastBroadcast = Date.now()
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('keybinds:changed', { at: lastBroadcast, ...result })
  })
}

function startKeysWatcher(): void {
  if (keysWatcher) return
  const dir = crewcodeDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  try {
    let timer: ReturnType<typeof setTimeout> | null = null
    // Watch the directory so create/delete/rename of keys.json is caught too.
    keysWatcher = watch(dir, { persistent: false }, (_evt, filename) => {
      if (filename && filename.toString() !== 'keys.json') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(broadcastKeysChanged, 120)
    })
  } catch {
    // Watch is best-effort; the renderer still loads the file on startup.
  }
}

export function registerKeybindsIpc(): void {
  startKeysWatcher()

  ipcMain.handle('keybinds:read', () => readKeysFile())

  ipcMain.handle('keybinds:write', (_e, data: Record<string, unknown>) => {
    try {
      writeKeysFile(data)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'failed to write keys.json' }
    }
  })

  ipcMain.handle('keybinds:open', (_e, seed: Record<string, unknown>) => {
    try {
      if (!existsSync(keysFilePath())) writeKeysFile(seed ?? {})
      shell.openPath(keysFilePath()).catch(() => { /* no associated app — non-fatal */ })
      return { ok: true, path: keysFilePath() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'failed to open keys.json' }
    }
  })
}

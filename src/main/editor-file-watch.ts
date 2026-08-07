import electron from 'electron'
import { join, dirname, basename, isAbsolute, normalize, sep } from 'path'
import { watch, statSync, type FSWatcher } from 'fs'
import { isRemoteRoot } from './remote/ssh-target'

const { ipcMain, BrowserWindow } = electron

// Live-reload support for the code editor: the renderer registers the files it
// has open, and we notify it when those files change on disk (e.g. an agent
// rewrites them) so it can re-read instead of showing stale content.

interface WatchedFile {
  root: string
  rel: string
  refs: number       // how many editor views have this file open
  mtimeMs: number     // last seen mtime, to ignore spurious watch events
}

interface DirWatcher {
  watcher: FSWatcher
  files: number       // count of watched files living in this directory
}

const watchedFiles = new Map<string, WatchedFile>()   // keyed by absolute path
const dirWatchers   = new Map<string, DirWatcher>()    // keyed by absolute dir
const pendingChecks = new Map<string, NodeJS.Timeout>() // debounce per abs path

const DEBOUNCE_MS = 120

function safeUnder(root: string, target: string): boolean {
  const a = normalize(root)
  const b = normalize(target)
  return b === a || b.startsWith(a + sep)
}

function absFor(root: string, rel: string): string | null {
  // Disk watching only applies to local workspaces; remote (ssh://) roots have
  // no local fs events, so we skip them rather than fail.
  if (isRemoteRoot(root) || !root || !isAbsolute(root)) return null
  const target = join(root, rel)
  if (!safeUnder(root, target)) return null
  return target
}

function readMtime(abs: string): number {
  try { return statSync(abs).mtimeMs } catch { return -1 }
}

function emitChange(file: WatchedFile): void {
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('editor:fileChanged', { root: file.root, rel: file.rel })
  })
}

function scheduleCheck(abs: string): void {
  const existing = pendingChecks.get(abs)
  if (existing) clearTimeout(existing)
  pendingChecks.set(abs, setTimeout(() => {
    pendingChecks.delete(abs)
    const file = watchedFiles.get(abs)
    if (!file) return
    const mtime = readMtime(abs)
    if (mtime === -1) return            // deleted/unreadable — leave the buffer alone
    if (mtime === file.mtimeMs) return  // no real content change
    file.mtimeMs = mtime
    emitChange(file)
  }, DEBOUNCE_MS))
}

function ensureDirWatcher(dir: string): void {
  if (dirWatchers.has(dir)) { dirWatchers.get(dir)!.files++; return }
  let watcher: FSWatcher
  try {
    // Watch the directory (not the file) so replace-on-save and atomic renames,
    // which break single-file watchers, are still caught.
    watcher = watch(dir, { persistent: false }, (_evt, filename) => {
      if (!filename) return
      const abs = join(dir, basename(filename.toString()))
      if (watchedFiles.has(abs)) scheduleCheck(abs)
    })
  } catch {
    return // best-effort; manual close/reopen still works
  }
  dirWatchers.set(dir, { watcher, files: 1 })
}

function releaseDirWatcher(dir: string): void {
  const dw = dirWatchers.get(dir)
  if (!dw) return
  dw.files--
  if (dw.files <= 0) {
    try { dw.watcher.close() } catch { /* already closed */ }
    dirWatchers.delete(dir)
  }
}

function addWatch(root: string, rel: string): void {
  const abs = absFor(root, rel)
  if (!abs) return
  const existing = watchedFiles.get(abs)
  if (existing) { existing.refs++; return }
  watchedFiles.set(abs, { root, rel, refs: 1, mtimeMs: readMtime(abs) })
  ensureDirWatcher(dirname(abs))
}

function removeWatch(root: string, rel: string): void {
  const abs = absFor(root, rel)
  if (!abs) return
  const existing = watchedFiles.get(abs)
  if (!existing) return
  existing.refs--
  if (existing.refs <= 0) {
    watchedFiles.delete(abs)
    const pending = pendingChecks.get(abs)
    if (pending) { clearTimeout(pending); pendingChecks.delete(abs) }
    releaseDirWatcher(dirname(abs))
  }
}

export function stopAllEditorWatchers(): void {
  pendingChecks.forEach(t => clearTimeout(t))
  pendingChecks.clear()
  dirWatchers.forEach(dw => { try { dw.watcher.close() } catch { /* noop */ } })
  dirWatchers.clear()
  watchedFiles.clear()
}

export function registerEditorWatchIpc(): void {
  ipcMain.on('editorWatch:add', (_e, root: string, rel: string) => {
    if (typeof root === 'string' && typeof rel === 'string') addWatch(root, rel)
  })
  ipcMain.on('editorWatch:remove', (_e, root: string, rel: string) => {
    if (typeof root === 'string' && typeof rel === 'string') removeWatch(root, rel)
  })
}

import electron from 'electron'
import { join, basename, relative, isAbsolute, normalize, sep, dirname, extname } from 'path'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync, renameSync, copyFileSync } from 'fs'
import { execFile, spawnSync } from 'child_process'
import { IGNORE, MAX_ATTACHMENT_FILE_BYTES, MAX_ATTACHMENT_FILE_MB, MAX_FILE_BYTES } from './fs-constants'
import { isRemoteRoot } from './remote/ssh-target'
import {
  remoteMkdir, remoteMove, remoteDelete, remoteRename, remoteCopyFile,
} from './remote/remote-fs'
import { FilesystemService } from './filesystem-service'

const { ipcMain, dialog, BrowserWindow } = electron

export interface FsNode {
  name: string
  path: string         // absolute
  rel:  string         // relative to root
  kind: 'dir' | 'file'
  size?: number
}

function safeUnder(root: string, target: string): boolean {
  const a = normalize(root)
  const b = normalize(target)
  return b === a || b.startsWith(a + sep)
}

function mimeTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase()
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
    '.avif': 'image/avif',
  }
  return map[ext] ?? 'application/octet-stream'
}

export function registerFsIpc(): void {
  const service = new FilesystemService()
  ipcMain.handle('fs:readDir', (_e, root: string, sub: string = '') => service.readDir(root, sub))
  ipcMain.handle('fs:readFile', (_e, root: string, sub: string) => service.readFile(root, sub))

  ipcMain.handle('fs:readDataUrl', (_e, root: string, sub: string) => {
    if (isRemoteRoot(root)) return { error: 'binary previews unavailable on remote workspaces' }
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    const target = join(root, sub)
    if (!safeUnder(root, target)) return { error: 'path escapes root' }
    if (!existsSync(target))      return { error: 'file missing' }
    let st
    try { st = statSync(target) } catch { return { error: 'stat failed' } }
    if (st.isDirectory()) return { error: 'is a directory' }
    if (st.size > MAX_FILE_BYTES) return { error: 'file too large (>2MB)' }
    try {
      const mimeType = mimeTypeForPath(target)
      const dataUrl = `data:${mimeType};base64,${readFileSync(target).toString('base64')}`
      return { ok: true, dataUrl, name: basename(target), size: st.size, mimeType }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('fs:writeFile', (_e, root: string, sub: string, text: string) => service.writeFile(root, sub, text))

  ipcMain.handle('fs:mkdir', (_e, root: string, sub: string) => {
    if (isRemoteRoot(root)) return remoteMkdir(root, sub)
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    const target = join(root, sub)
    if (!safeUnder(root, target)) return { error: 'path escapes root' }
    try {
      mkdirSync(target, { recursive: true })
      return { ok: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('fs:move', (_e, root: string, srcRel: string, destDirRel: string) => {
    if (isRemoteRoot(root)) return remoteMove(root, srcRel, destDirRel)
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    const src = join(root, srcRel)
    if (!safeUnder(root, src)) return { error: 'source escapes root' }
    if (!existsSync(src))      return { error: 'source missing' }
    const destDir = destDirRel ? join(root, destDirRel) : root
    if (!safeUnder(root, destDir)) return { error: 'destination escapes root' }
    const dest = join(destDir, basename(src))
    if (!safeUnder(root, dest))    return { error: 'destination escapes root' }
    if (existsSync(dest))          return { error: `${basename(src)} already exists there` }
    try {
      renameSync(src, dest)
      return { ok: true, rel: relative(root, dest) }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('fs:delete', (_e, root: string, sub: string) => {
    if (isRemoteRoot(root)) return remoteDelete(root, sub)
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    const target = join(root, sub)
    if (!safeUnder(root, target)) return { error: 'path escapes root' }
    if (!existsSync(target))      return { error: 'path missing' }
    try {
      rmSync(target, { recursive: true, force: true })
      return { ok: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('fs:rename', (_e, root: string, sub: string, newName: string) => {
    if (isRemoteRoot(root)) return remoteRename(root, sub, newName)
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    const target = join(root, sub)
    if (!safeUnder(root, target)) return { error: 'path escapes root' }
    if (!existsSync(target))      return { error: 'path missing' }
    const dest = join(dirname(target), newName)
    if (!safeUnder(root, dest))   return { error: 'destination escapes root' }
    try {
      renameSync(target, dest)
      return { ok: true, rel: relative(root, dest) }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('fs:copyFile', (_e, root: string, sub: string) => {
    if (isRemoteRoot(root)) return remoteCopyFile(root, sub)
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    const target = join(root, sub)
    if (!safeUnder(root, target)) return { error: 'path escapes root' }
    if (!existsSync(target))      return { error: 'path missing' }
    const ext  = extname(target)
    const base = basename(target, ext)
    const dir  = dirname(target)
    let dest = join(dir, `${base} copy${ext}`)
    let n = 2
    while (existsSync(dest)) { dest = join(dir, `${base} copy ${n}${ext}`); n++ }
    try {
      copyFileSync(target, dest)
      return { ok: true, rel: relative(root, dest) }
    } catch (err) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('fs:listFiles', (_e, root: string) => service.listFiles(root))

  ipcMain.handle('attachments:pick', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'attach files',
      properties: ['openFile', 'multiSelections'],
    })
    return { canceled: result.canceled, filePaths: result.filePaths }
  })

  // Copy arbitrary bytes (from a File drop/paste or picked path) into the
  // workspace's `.crewcode/attachments/` dir so the rel-path attachment model
  // continues to work. Local workspaces only.
  ipcMain.handle('attachments:import', (
    _e, root: string, items: Array<{ name: string; data: ArrayBuffer | Uint8Array }>,
  ) => {
    if (isRemoteRoot(root)) return { error: 'attachments not supported on remote workspaces' }
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    if (!Array.isArray(items) || items.length === 0) return { rels: [] }

    const dir = join(root, '.crewcode', 'attachments')
    try { mkdirSync(dir, { recursive: true }) } catch (err) {
      return { error: (err as Error).message }
    }

    const rels: string[] = []
    for (const item of items) {
      if (!item || typeof item.name !== 'string' || !item.data) {
        return { error: 'invalid attachment payload' }
      }
      const buf: Buffer = item.data instanceof Uint8Array
        ? Buffer.from(item.data)
        : Buffer.from(new Uint8Array(item.data))
      if (buf.byteLength > MAX_ATTACHMENT_FILE_BYTES) {
        return { error: `${item.name} exceeds ${MAX_ATTACHMENT_FILE_MB}MB attachment limit` }
      }
      const safeName = item.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(0, 100) || 'file'
      const ts  = Date.now().toString(36)
      const rnd = Math.random().toString(36).slice(2, 8)
      const filename = `${ts}-${rnd}-${safeName}`
      const abs = join(dir, filename)
      if (!safeUnder(root, abs)) return { error: 'attachment path escapes root' }
      try {
        writeFileSync(abs, buf)
        rels.push(join('.crewcode', 'attachments', filename))
      } catch (err) {
        return { error: (err as Error).message }
      }
    }
    return { rels }
  })

  ipcMain.handle('fs:format', (_e, root: string, sub: string, text: string) => {
    if (isRemoteRoot(root)) return { error: 'format unavailable on remote workspaces' }
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    const target = join(root, sub)
    if (!safeUnder(root, target)) return { error: 'path escapes root' }

    // Detect prettier in PATH or local node_modules
    const prettierBin = (() => {
      const local = join(root, 'node_modules', '.bin', 'prettier')
      if (existsSync(local)) return local
      const which = spawnSync('which', ['prettier'], { encoding: 'utf8' })
      const bin = which.stdout?.trim()
      return bin || null
    })()

    if (!prettierBin) return { error: 'prettier not found' }

    return new Promise<{ ok?: boolean; text?: string; error?: string }>(resolve => {
      const child = execFile(
        prettierBin,
        ['--stdin-filepath', basename(target)],
        { cwd: root, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) resolve({ error: stderr?.trim() || err.message })
          else resolve({ ok: true, text: stdout })
        },
      )
      child.stdin?.write(text)
      child.stdin?.end()
    })
  })
}

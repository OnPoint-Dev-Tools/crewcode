import electron from 'electron'
import { posix } from 'path'
import type { SFTPWrapper, FileEntry } from 'ssh2'
import { getSftp, execRemote, connectRemote, disconnectRemote, disconnectAllRemotes } from './ssh-pool'
import { parseRemoteTarget, formatRemoteRoot, attrIsDir, type RemoteTarget } from './ssh-target'
import { IGNORE } from '../fs-constants'

const { ipcMain } = electron

export interface RemoteDirEntry {
  name: string
  kind: 'dir' | 'file'
}

interface RemoteSpec { host: string; user?: string; port?: number }

function buildTarget(spec: RemoteSpec, path: string): RemoteTarget | null {
  return parseRemoteTarget(formatRemoteRoot({ ...spec, path: path || '/' }))
}

export function registerRemoteIpc(): void {
  // Resolve the remote $HOME so the directory browser opens somewhere useful.
  ipcMain.handle('ssh:remoteHome', async (_e, spec: RemoteSpec) => {
    const t = buildTarget(spec, '/')
    if (!t) return { error: 'invalid host' }
    const r = await execRemote(t, 'echo "$HOME"').catch(e => ({ code: 1, stdout: '', stderr: String(e?.message ?? e) }))
    if (r.code !== 0) return { error: r.stderr.trim() || 'could not resolve home' }
    const home = r.stdout.trim()
    return { ok: true, path: home && home.startsWith('/') ? home : '/' }
  })

  // List directories (and files) at a remote path for the add-workspace picker.
  ipcMain.handle('ssh:listRemoteDir', async (_e, spec: RemoteSpec, path: string) => {
    const t = buildTarget(spec, path)
    if (!t) return { error: 'invalid host' }

    let sftp: SFTPWrapper
    try { sftp = await getSftp(t) }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) } }

    const list = await new Promise<FileEntry[] | { error: string }>(resolve => {
      sftp.readdir(t.path, (err, entries) => resolve(err ? { error: err.message } : entries))
    })
    if (!Array.isArray(list)) return list

    const entries: RemoteDirEntry[] = []
    for (const e of list) {
      if (e.filename.startsWith('.') || IGNORE.has(e.filename)) continue
      entries.push({ name: e.filename, kind: attrIsDir(e.attrs.mode) ? 'dir' : 'file' })
    }
    entries.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)))
    return { ok: true, path: t.path, parent: t.path === '/' ? null : posix.dirname(t.path), entries }
  })

  ipcMain.handle('ssh:connectRemote',    (_e, spec: RemoteSpec, path: string) => {
    const t = buildTarget(spec, path || '/')
    return t ? connectRemote(t) : Promise.resolve({ ok: false, error: 'invalid host' })
  })
  ipcMain.handle('ssh:disconnectRemote', (_e, connId: string) => { disconnectRemote(connId); return { ok: true } })
}

export { disconnectAllRemotes }

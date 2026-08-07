import { posix } from 'path'
import type { SFTPWrapper, Stats, FileEntry } from 'ssh2'
import { getSftp, execRemote } from './ssh-pool'
import { parseRemoteTarget, resolveRemote, attrIsDir, attrIsFile, type RemoteTarget } from './ssh-target'
import { IGNORE, MAX_FILE_BYTES } from '../fs-constants'
import type { FsNode } from '../fs'

// Wrap a path for safe interpolation into a remote shell command (recursive
// ops have no SFTP primitive, so they go through `exec`).
function sh(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

function target(root: string): RemoteTarget | { error: string } {
  const t = parseRemoteTarget(root)
  return t ?? { error: 'invalid remote root' }
}

async function statRemote(sftp: SFTPWrapper, abs: string): Promise<Stats | null> {
  return new Promise(resolve => sftp.stat(abs, (err, st) => resolve(err ? null : st)))
}

export async function remoteReadDir(root: string, sub = ''): Promise<{ nodes?: FsNode[]; error?: string }> {
  const t = target(root); if ('error' in t) return t
  const r = resolveRemote(t, sub); if ('error' in r) return r

  let sftp: SFTPWrapper
  try { sftp = await getSftp(t) } catch (e) { return { error: connErr(e) } }

  const list = await new Promise<FileEntry[] | { error: string }>(resolve => {
    sftp.readdir(r.abs, (err, entries) => resolve(err ? { error: err.message } : entries))
  })
  if (!Array.isArray(list)) return list

  const nodes: FsNode[] = []
  for (const entry of list) {
    const name = entry.filename
    if (IGNORE.has(name)) continue
    const abs = posix.join(r.abs, name)
    const isDir = attrIsDir(entry.attrs.mode)
    nodes.push({
      name,
      path: abs,
      rel:  posix.relative(t.path, abs),
      kind: isDir ? 'dir' : 'file',
      size: attrIsFile(entry.attrs.mode) ? entry.attrs.size : undefined,
    })
  }
  nodes.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)))
  return { nodes }
}

export async function remoteReadFile(root: string, sub: string): Promise<{ ok?: boolean; text?: string; name?: string; size?: number; error?: string }> {
  const t = target(root); if ('error' in t) return t
  const r = resolveRemote(t, sub); if ('error' in r) return r

  let sftp: SFTPWrapper
  try { sftp = await getSftp(t) } catch (e) { return { error: connErr(e) } }

  const st = await statRemote(sftp, r.abs)
  if (!st)                       return { error: 'file missing' }
  if (st.isDirectory())          return { error: 'is a directory' }
  if (st.size > MAX_FILE_BYTES)  return { error: 'file too large (>2MB)' }

  return new Promise(resolve => {
    sftp.readFile(r.abs, (err, buf) => {
      if (err) resolve({ error: err.message })
      else     resolve({ ok: true, text: buf.toString('utf8'), name: posix.basename(r.abs), size: st.size })
    })
  })
}

export async function remoteReadBuffer(root: string, sub: string, maxBytes: number): Promise<{ ok?: boolean; data?: Buffer; error?: string }> {
  const t = target(root); if ('error' in t) return t
  const r = resolveRemote(t, sub); if ('error' in r) return r

  let sftp: SFTPWrapper
  try { sftp = await getSftp(t) } catch (e) { return { error: connErr(e) } }

  const st = await statRemote(sftp, r.abs)
  if (!st) return { error: 'file missing' }
  if (st.isDirectory()) return { error: 'is a directory' }
  if (st.size > maxBytes) return { error: `file too large (>${Math.floor(maxBytes / 1024 / 1024)}MB)` }

  return new Promise(resolve => {
    sftp.readFile(r.abs, (err, data) => resolve(err ? { error: err.message } : { ok: true, data }))
  })
}

export async function remotePathExists(root: string, sub: string): Promise<boolean> {
  const t = target(root); if ('error' in t) return false
  const r = resolveRemote(t, sub); if ('error' in r) return false
  try {
    const sftp = await getSftp(t)
    return (await statRemote(sftp, r.abs)) !== null
  } catch {
    // Callers still use exclusive writes, so a connection/stat failure cannot
    // turn into an accidental overwrite.
    return false
  }
}

export async function remoteWriteBuffer(root: string, sub: string, data: Buffer): Promise<{ ok?: boolean; error?: string }> {
  const t = target(root); if ('error' in t) return t
  const r = resolveRemote(t, sub); if ('error' in r) return r

  let sftp: SFTPWrapper
  try { sftp = await getSftp(t) } catch (e) { return { error: connErr(e) } }

  await execRemote(t, `mkdir -p ${sh(posix.dirname(r.abs))}`).catch(() => undefined)
  return new Promise(resolve => {
    sftp.writeFile(r.abs, data, err => resolve(err ? { error: err.message } : { ok: true }))
  })
}

export async function remoteWriteBufferExclusive(root: string, sub: string, data: Buffer): Promise<{ ok?: boolean; error?: string }> {
  const t = target(root); if ('error' in t) return t
  const r = resolveRemote(t, sub); if ('error' in r) return r

  let sftp: SFTPWrapper
  try { sftp = await getSftp(t) } catch (e) { return { error: connErr(e) } }

  await execRemote(t, `mkdir -p ${sh(posix.dirname(r.abs))}`).catch(() => undefined)
  return new Promise(resolve => {
    sftp.writeFile(r.abs, data, { flag: 'wx' }, err => resolve(err ? { error: err.message } : { ok: true }))
  })
}

export async function remoteWriteFile(root: string, sub: string, text: string): Promise<{ ok?: boolean; error?: string }> {
  const t = target(root); if ('error' in t) return t
  const r = resolveRemote(t, sub); if ('error' in r) return r

  let sftp: SFTPWrapper
  try { sftp = await getSftp(t) } catch (e) { return { error: connErr(e) } }

  // SFTP has no recursive mkdir; ensure the parent exists before writing.
  await execRemote(t, `mkdir -p ${sh(posix.dirname(r.abs))}`).catch(() => undefined)
  return new Promise(resolve => {
    sftp.writeFile(r.abs, Buffer.from(text, 'utf8'), err => resolve(err ? { error: err.message } : { ok: true }))
  })
}

export async function remoteMkdir(root: string, sub: string): Promise<{ ok?: boolean; error?: string }> {
  const t = target(root); if ('error' in t) return t
  const r = resolveRemote(t, sub); if ('error' in r) return r
  const res = await execRemote(t, `mkdir -p ${sh(r.abs)}`).catch(e => ({ code: 1, stdout: '', stderr: connErr(e) }))
  return res.code === 0 ? { ok: true } : { error: res.stderr.trim() || 'mkdir failed' }
}

export async function remoteMove(root: string, srcRel: string, destDirRel: string): Promise<{ ok?: boolean; rel?: string; error?: string }> {
  const t = target(root); if ('error' in t) return t
  const src = resolveRemote(t, srcRel);              if ('error' in src) return src
  const dst = resolveRemote(t, destDirRel || '');    if ('error' in dst) return dst

  let sftp: SFTPWrapper
  try { sftp = await getSftp(t) } catch (e) { return { error: connErr(e) } }
  if (!(await statRemote(sftp, src.abs))) return { error: 'source missing' }

  const base = posix.basename(src.abs)
  const dest = posix.join(dst.abs, base)
  if (await statRemote(sftp, dest)) return { error: `${base} already exists there` }
  return new Promise(resolve => {
    sftp.rename(src.abs, dest, err => resolve(err ? { error: err.message } : { ok: true, rel: posix.relative(t.path, dest) }))
  })
}

export async function remoteDelete(root: string, sub: string): Promise<{ ok?: boolean; error?: string }> {
  const t = target(root); if ('error' in t) return t
  const r = resolveRemote(t, sub); if ('error' in r) return r
  if (r.abs === t.path) return { error: 'refusing to delete workspace root' }
  const res = await execRemote(t, `rm -rf ${sh(r.abs)}`).catch(e => ({ code: 1, stdout: '', stderr: connErr(e) }))
  return res.code === 0 ? { ok: true } : { error: res.stderr.trim() || 'delete failed' }
}

export async function remoteRename(root: string, sub: string, newName: string): Promise<{ ok?: boolean; rel?: string; error?: string }> {
  const t = target(root); if ('error' in t) return t
  const r = resolveRemote(t, sub); if ('error' in r) return r

  let sftp: SFTPWrapper
  try { sftp = await getSftp(t) } catch (e) { return { error: connErr(e) } }
  if (!(await statRemote(sftp, r.abs))) return { error: 'path missing' }

  const dest = posix.join(posix.dirname(r.abs), newName)
  const safe = resolveRemote(t, posix.relative(t.path, dest)); if ('error' in safe) return safe
  return new Promise(resolve => {
    sftp.rename(r.abs, dest, err => resolve(err ? { error: err.message } : { ok: true, rel: posix.relative(t.path, dest) }))
  })
}

export async function remoteCopyFile(root: string, sub: string): Promise<{ ok?: boolean; rel?: string; error?: string }> {
  const t = target(root); if ('error' in t) return t
  const r = resolveRemote(t, sub); if ('error' in r) return r

  let sftp: SFTPWrapper
  try { sftp = await getSftp(t) } catch (e) { return { error: connErr(e) } }

  const ext  = posix.extname(r.abs)
  const stem = posix.basename(r.abs, ext)
  const dir  = posix.dirname(r.abs)
  let dest = posix.join(dir, `${stem} copy${ext}`)
  let n = 2
  while (await statRemote(sftp, dest)) { dest = posix.join(dir, `${stem} copy ${n}${ext}`); n++ }

  const res = await execRemote(t, `cp -R ${sh(r.abs)} ${sh(dest)}`).catch(e => ({ code: 1, stdout: '', stderr: connErr(e) }))
  return res.code === 0 ? { ok: true, rel: posix.relative(t.path, dest) } : { error: res.stderr.trim() || 'copy failed' }
}

export async function remoteListFiles(root: string): Promise<{ files?: string[]; error?: string }> {
  const t = target(root); if ('error' in t) return t

  // Prefer git's tracked+untracked listing (respects .gitignore); fall back to
  // find with the same noise dirs pruned as the local walk.
  const git = await execRemote(t, `git -C ${sh(t.path)} ls-files --cached --others --exclude-standard`).catch(() => null)
  if (git && git.code === 0) {
    return { files: git.stdout.split('\n').map(l => l.trim()).filter(Boolean) }
  }

  const prunes = [...IGNORE].map(d => `-name ${sh(d)}`).join(' -o ')
  const find = await execRemote(
    t,
    `cd ${sh(t.path)} && find . \\( ${prunes} \\) -prune -o -type f -print | sed 's|^\\./||' | head -n 20000`,
  ).catch(e => ({ code: 1, stdout: '', stderr: connErr(e) }))
  if (find.code !== 0) return { error: find.stderr.trim() || 'listing failed' }
  return { files: find.stdout.split('\n').map(l => l.trim()).filter(Boolean) }
}

function connErr(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

import { execFile } from 'child_process'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from 'path'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { IGNORE, MAX_FILE_BYTES } from './fs-constants'
import { uniqueCopyName } from './fs-copy-name'
import { isRemoteRoot } from './remote/ssh-target'
import { remoteListFiles, remoteReadDir, remoteReadFile, remoteWriteFile } from './remote/remote-fs'

export interface FilesystemNode {
  name: string
  path: string
  rel: string
  kind: 'dir' | 'file'
  size?: number
}

function safeUnder(root: string, target: string): boolean {
  const normalizedRoot = normalize(root)
  const normalizedTarget = normalize(target)
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + sep)
}

/** Transport-neutral, workspace-sandboxed filesystem operations. */
export class FilesystemService {
  readDir(root: string, sub = ''): ReturnType<typeof remoteReadDir> | { nodes?: FilesystemNode[]; error?: string } {
    if (isRemoteRoot(root)) return remoteReadDir(root, sub)
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    const target = sub ? join(root, sub) : root
    if (!safeUnder(root, target)) return { error: 'path escapes root' }
    if (!existsSync(target)) return { error: 'path missing' }
    let entries: string[]
    try { entries = readdirSync(target) } catch (error) { return { error: (error as Error).message } }
    const nodes: FilesystemNode[] = []
    for (const name of entries) {
      if (IGNORE.has(name)) continue
      const absolute = join(target, name)
      let stat
      try { stat = statSync(absolute) } catch { continue }
      nodes.push({ name, path: absolute, rel: relative(root, absolute), kind: stat.isDirectory() ? 'dir' : 'file', size: stat.isFile() ? stat.size : undefined })
    }
    nodes.sort((a, b) => a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name))
    return { nodes }
  }

  readFile(root: string, sub: string): ReturnType<typeof remoteReadFile> | { ok?: boolean; text?: string; name?: string; size?: number; error?: string } {
    if (isRemoteRoot(root)) return remoteReadFile(root, sub)
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    const target = join(root, sub)
    if (!safeUnder(root, target)) return { error: 'path escapes root' }
    if (!existsSync(target)) return { error: 'file missing' }
    let stat
    try { stat = statSync(target) } catch { return { error: 'stat failed' } }
    if (stat.isDirectory()) return { error: 'is a directory' }
    if (stat.size > MAX_FILE_BYTES) return { error: 'file too large (>2MB)' }
    try { return { ok: true, text: readFileSync(target, 'utf8'), name: basename(target), size: stat.size } }
    catch (error) { return { error: (error as Error).message } }
  }

  async format(root: string, sub: string, text: string): Promise<{ ok?: boolean; text?: string; error?: string }> {
    if (isRemoteRoot(root)) return { error: 'format unavailable on SSH workspaces' }
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    const target = join(root, sub)
    if (!safeUnder(root, target)) return { error: 'path escapes root' }
    const localName = process.platform === 'win32' ? 'prettier.cmd' : 'prettier'
    const local = join(root, 'node_modules', '.bin', localName)
    const command = existsSync(local) ? local : 'prettier'
    return new Promise(resolve => {
      const child = execFile(command, ['--stdin-filepath', basename(target)], { cwd: root, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (error) resolve({ error: stderr?.trim() || ((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'prettier not found' : error.message) })
        else resolve({ ok: true, text: stdout })
      })
      child.stdin?.end(text)
    })
  }

  writeFile(root: string, sub: string, text: string): ReturnType<typeof remoteWriteFile> | { ok?: boolean; error?: string } {
    if (isRemoteRoot(root)) return remoteWriteFile(root, sub, text)
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    const target = join(root, sub)
    if (!safeUnder(root, target)) return { error: 'path escapes root' }
    try {
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, text, 'utf8')
      return { ok: true }
    } catch (error) { return { error: (error as Error).message } }
  }

  readDataUrl(root: string, sub: string): { ok?: boolean; dataUrl?: string; name?: string; size?: number; mimeType?: string; error?: string } {
    if (isRemoteRoot(root)) return { error: 'binary previews unavailable on remote workspaces' }
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    const target = join(root, sub)
    if (!safeUnder(root, target)) return { error: 'path escapes root' }
    if (!existsSync(target)) return { error: 'file missing' }
    let stat
    try { stat = statSync(target) } catch { return { error: 'stat failed' } }
    if (stat.isDirectory()) return { error: 'is a directory' }
    if (stat.size > MAX_FILE_BYTES) return { error: 'file too large (>2MB)' }
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
    }
    try {
      const mimeType = mimeTypes[extname(target).toLowerCase()] ?? 'application/octet-stream'
      return { ok: true, dataUrl: `data:${mimeType};base64,${readFileSync(target).toString('base64')}`, name: basename(target), size: stat.size, mimeType }
    } catch (error) { return { error: (error as Error).message } }
  }

  mkdir(root: string, sub: string): { ok?: boolean; error?: string } {
    if (isRemoteRoot(root)) return { error: 'directory creation unavailable on remote workspaces over web access' }
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    const target = join(root, sub)
    if (!safeUnder(root, target)) return { error: 'path escapes root' }
    try { mkdirSync(target, { recursive: true }); return { ok: true } }
    catch (error) { return { error: (error as Error).message } }
  }

  delete(root: string, sub: string): { ok?: boolean; error?: string } {
    if (isRemoteRoot(root)) return { error: 'delete unavailable on remote workspaces over web access' }
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    const target = join(root, sub)
    if (!safeUnder(root, target) || target === normalize(root)) return { error: 'path escapes root' }
    if (!existsSync(target)) return { error: 'path missing' }
    try { rmSync(target, { recursive: true, force: true }); return { ok: true } }
    catch (error) { return { error: (error as Error).message } }
  }

  rename(root: string, sub: string, newName: string): { ok?: boolean; rel?: string; error?: string } {
    if (isRemoteRoot(root)) return { error: 'rename unavailable on remote workspaces over web access' }
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    if (!newName || newName === '.' || newName === '..' || newName.includes('/') || newName.includes('\\')) return { error: 'invalid name' }
    const target = join(root, sub)
    const destination = join(dirname(target), newName)
    if (!safeUnder(root, target) || !safeUnder(root, destination) || target === normalize(root)) return { error: 'path escapes root' }
    if (!existsSync(target)) return { error: 'path missing' }
    if (existsSync(destination)) return { error: 'destination already exists' }
    try { renameSync(target, destination); return { ok: true, rel: relative(root, destination) } }
    catch (error) { return { error: (error as Error).message } }
  }

  move(root: string, srcRel: string, destDirRel: string): { ok?: boolean; rel?: string; error?: string } {
    if (isRemoteRoot(root)) return { error: 'move unavailable on remote workspaces over web access' }
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    if (!srcRel || srcRel === '.' || srcRel === '..') return { error: 'source missing' }
    const source = join(root, srcRel)
    if (!safeUnder(root, source) || source === normalize(root)) return { error: 'source escapes root' }
    if (!existsSync(source)) return { error: 'source missing' }
    let sourceStat
    try { sourceStat = statSync(source) } catch { return { error: 'stat failed' } }

    const destDir = destDirRel ? join(root, destDirRel) : root
    if (!safeUnder(root, destDir)) return { error: 'destination escapes root' }
    if (!existsSync(destDir)) return { error: 'destination missing' }
    let destStat
    try { destStat = statSync(destDir) } catch { return { error: 'destination missing' } }
    if (!destStat.isDirectory()) return { error: 'destination is not a directory' }

    if (sourceStat.isDirectory()) {
      const sourceNorm = normalize(source)
      const destNorm = normalize(destDir)
      if (destNorm === sourceNorm || destNorm.startsWith(sourceNorm + sep)) {
        return { error: 'cannot move a folder into itself' }
      }
    }

    const destination = join(destDir, basename(source))
    if (!safeUnder(root, destination) || destination === normalize(root)) return { error: 'destination escapes root' }
    if (existsSync(destination)) return { error: `${basename(source)} already exists there` }
    try {
      renameSync(source, destination)
      return { ok: true, rel: relative(root, destination) }
    } catch (error) {
      return { error: (error as Error).message }
    }
  }

  /**
   * Copy a file or folder under `root`.
   * Omit `destDirRel` to duplicate beside the source; pass `''` for the workspace root.
   */
  copyFile(root: string, sub: string, destDirRel?: string): { ok?: boolean; rel?: string; error?: string } {
    if (isRemoteRoot(root)) return { error: 'copy unavailable on remote workspaces over web access' }
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    if (!sub || sub === '.' || sub === '..') return { error: 'path missing' }
    const source = join(root, sub)
    if (!safeUnder(root, source) || source === normalize(root)) return { error: 'path escapes root' }
    if (!existsSync(source)) return { error: 'path missing' }
    let sourceStat
    try { sourceStat = statSync(source) } catch { return { error: 'stat failed' } }

    const destDir = destDirRel === undefined
      ? dirname(source)
      : destDirRel
        ? join(root, destDirRel)
        : root
    if (!safeUnder(root, destDir)) return { error: 'destination escapes root' }
    if (!existsSync(destDir)) return { error: 'destination missing' }
    let destStat
    try { destStat = statSync(destDir) } catch { return { error: 'destination missing' } }
    if (!destStat.isDirectory()) return { error: 'destination is not a directory' }

    if (sourceStat.isDirectory()) {
      const sourceNorm = normalize(source)
      const destNorm = normalize(destDir)
      if (destNorm === sourceNorm || destNorm.startsWith(sourceNorm + sep)) {
        return { error: 'cannot copy a folder into itself' }
      }
    }

    let name: string
    try {
      name = uniqueCopyName(basename(source), candidate => existsSync(join(destDir, candidate)))
    } catch (error) {
      return { error: (error as Error).message }
    }
    const destination = join(destDir, name)
    if (!safeUnder(root, destination) || destination === normalize(root)) return { error: 'destination escapes root' }
    try {
      cpSync(source, destination, { recursive: true, errorOnExist: true, force: false })
      return { ok: true, rel: relative(root, destination) }
    } catch (error) {
      return { error: (error as Error).message }
    }
  }

  async listFiles(root: string): Promise<{ files?: string[]; error?: string }> {
    if (isRemoteRoot(root)) return remoteListFiles(root)
    if (!root || !isAbsolute(root)) return { error: 'absolute root required' }
    if (!existsSync(root)) return { error: 'root missing' }
    const gitFiles = await new Promise<string[] | null>(resolve => {
      execFile('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        resolve(error ? null : stdout.split('\n').map(line => line.trim()).filter(Boolean))
      })
    })
    if (gitFiles) return { files: gitFiles }
    const files: string[] = []
    const walk = (dirRel: string): void => {
      const absoluteDir = dirRel ? join(root, dirRel) : root
      let entries: string[]
      try { entries = readdirSync(absoluteDir) } catch { return }
      for (const name of entries) {
        if (IGNORE.has(name)) continue
        const absolute = join(absoluteDir, name)
        let stat
        try { stat = statSync(absolute) } catch { continue }
        const rel = dirRel ? `${dirRel}/${name}` : name
        if (stat.isDirectory()) walk(rel)
        else if (stat.isFile()) files.push(rel)
        if (files.length > 20_000) return
      }
    }
    walk('')
    return { files }
  }
}

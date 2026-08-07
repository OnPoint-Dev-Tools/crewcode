import { join, basename, dirname, extname, posix } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { spawnSync } from 'child_process'
import { formatRemoteRoot } from './remote/ssh-target'

export type WorkspaceKind   = 'repo' | 'folder' | 'remote'
export type WorkspaceStatus = 'ready' | 'live' | 'plan' | 'idle' | 'error'

export interface RemoteInfo {
  host:  string
  user?: string
  port?: number
}

export interface StoredWorkspace {
  id:        string
  name:      string
  path:      string                 // local abs path, or an ssh:// URI when remote
  kind:      WorkspaceKind
  pinned:    boolean
  addedAt:   number
  folder?:   string | null
  remote?:   RemoteInfo | null      // present only for kind === 'remote'
}

interface StoreShape {
  workspaces: StoredWorkspace[]
}

function readStore(storePath: string): StoreShape {
  const p = storePath
  if (!existsSync(p)) return { workspaces: [] }
  try {
    const raw = readFileSync(p, 'utf8')
    const parsed = JSON.parse(raw) as StoreShape
    if (!Array.isArray(parsed.workspaces)) return { workspaces: [] }
    return parsed
  } catch {
    return { workspaces: [] }
  }
}

function writeStore(storePath: string, store: StoreShape): void {
  mkdirSync(dirname(storePath), { recursive: true })
  writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8')
}

function slugifyId(p: string): string {
  return basename(p).replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || `ws-${Date.now()}`
}

function detectKind(absPath: string): WorkspaceKind {
  return existsSync(join(absPath, '.git')) ? 'repo' : 'folder'
}

function gitBranch(cwd: string): string | null {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' })
  if (r.status !== 0) return null
  const out = r.stdout?.trim()
  return out && out !== 'HEAD' ? out : null
}

function gitDirty(cwd: string): number {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' })
  if (r.status !== 0) return 0
  return (r.stdout?.split('\n').filter(Boolean).length) ?? 0
}

export interface EnrichedWorkspace extends StoredWorkspace {
  branch: string | null
  dirty:  number
  status: WorkspaceStatus
  agents: string[]
  updated: string
  projectIconDataUrl?: string | null
}

function enrich(ws: StoredWorkspace): EnrichedWorkspace {
  // Remote workspaces can't be stat'd or git-probed with the local fs — their
  // git state is fetched lazily over SSH by the git surface. Treat them as
  // present/idle here so they don't render as broken.
  if (ws.kind === 'remote') {
    return {
      ...ws,
      folder:             ws.folder ?? null,
      remote:             ws.remote ?? null,
      branch:             null,
      dirty:              0,
      status:             'idle',
      agents:             [],
      updated:            relativeTime(ws.addedAt),
      projectIconDataUrl: null,
    }
  }

  const exists = existsSync(ws.path)
  // `kind` is captured at add time, so a folder that was later `git init`ed (or a
  // repo whose .git was removed) would keep reporting the stale value forever —
  // which silently disables every repo-gated feature for that workspace.
  const kind = exists ? detectKind(ws.path) : ws.kind
  const branch = exists && kind === 'repo' ? gitBranch(ws.path) : null
  const dirty  = exists && kind === 'repo' ? gitDirty(ws.path)  : 0
  return {
    ...ws,
    kind,
    folder:             ws.folder ?? null,
    remote:             null,
    branch,
    dirty,
    status:             exists ? 'idle' : 'error',
    agents:             [],
    updated:            relativeTime(ws.addedAt),
    projectIconDataUrl: exists ? resolveProjectIconDataUrl(ws.path) : null,
  }
}

const PROJECT_ICON_MAX_BYTES = 512 * 1024
const PROJECT_ICON_NAMES = [
  'favicon.svg',
  'favicon.png',
  'favicon.ico',
  'icon.svg',
  'icon.png',
  'icon.ico',
  'logo.svg',
  'logo.png',
  'apple-touch-icon.png',
  'icon.jpg',
  'icon.jpeg',
  'icon.webp',
] as const
const PROJECT_ICON_DIRS = ['', 'public', 'static', 'assets', 'build'] as const
const PROJECT_MANIFEST_NAMES = ['manifest.json', 'site.webmanifest'] as const
const PROJECT_HTML_ICON_NAMES = ['index.html', 'app.html'] as const

function resolveProjectIconDataUrl(root: string): string | null {
  const manifestIcon = resolveManifestIcon(root)
  if (manifestIcon) return manifestIcon

  const htmlIcon = resolveHtmlIcon(root)
  if (htmlIcon) return htmlIcon

  // Only scan a few conventional locations so workspace list rendering stays
  // cheap even when users pin many large repos.
  for (const dir of PROJECT_ICON_DIRS) {
    for (const name of PROJECT_ICON_NAMES) {
      const absPath = dir ? join(root, dir, name) : join(root, name)
      const dataUrl = readIconFileAsDataUrl(absPath)
      if (dataUrl) return dataUrl
    }
  }

  const packageJsonIcon = resolvePackageJsonIcon(root)
  if (packageJsonIcon) return packageJsonIcon

  return null
}

function resolveManifestIcon(root: string): string | null {
  for (const dir of PROJECT_ICON_DIRS) {
    for (const name of PROJECT_MANIFEST_NAMES) {
      const manifestPath = dir ? join(root, dir, name) : join(root, name)
      const icon = readManifestIconDataUrl(manifestPath)
      if (icon) return icon
    }
  }

  return null
}

function resolveHtmlIcon(root: string): string | null {
  for (const dir of PROJECT_ICON_DIRS) {
    for (const name of PROJECT_HTML_ICON_NAMES) {
      const htmlPath = dir ? join(root, dir, name) : join(root, name)
      const icon = readHtmlIconDataUrl(htmlPath)
      if (icon) return icon
    }
  }

  return null
}

function resolvePackageJsonIcon(root: string): string | null {
  const pkgPath = join(root, 'package.json')
  if (!existsSync(pkgPath)) return null

  try {
    const raw = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      icon?: unknown
      build?: { icon?: unknown } | unknown
    }
    const directIcon = typeof raw.icon === 'string' ? raw.icon : null
    const build = raw.build && typeof raw.build === 'object'
      ? raw.build as { icon?: unknown }
      : null
    const buildIcon = typeof build?.icon === 'string' ? build.icon : null
    const iconPath = directIcon ?? buildIcon
    if (!iconPath) return null
    return readIconFileAsDataUrl(join(root, iconPath))
  } catch {
    return null
  }
}

function readManifestIconDataUrl(manifestPath: string): string | null {
  if (!existsSync(manifestPath)) return null

  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as { icons?: unknown }
    const icons = Array.isArray(raw.icons) ? raw.icons : []
    const candidates = icons
      .map((icon) => {
        if (!icon || typeof icon !== 'object') return null
        const entry = icon as { src?: unknown; sizes?: unknown; purpose?: unknown }
        if (typeof entry.src !== 'string') return null
        return {
          src: entry.src,
          sizes: typeof entry.sizes === 'string' ? entry.sizes : '',
          purpose: typeof entry.purpose === 'string' ? entry.purpose : '',
        }
      })
      .filter((icon): icon is { src: string; sizes: string; purpose: string } => !!icon)
      .sort((a, b) => scoreManifestIcon(b) - scoreManifestIcon(a))

    for (const icon of candidates) {
      if (/^https?:\/\//i.test(icon.src)) continue
      const normalized = icon.src.replace(/^\.\//, '').replace(/^\//, '')
      const iconPath = join(dirname(manifestPath), normalized)
      const dataUrl = readIconFileAsDataUrl(iconPath)
      if (dataUrl) return dataUrl
    }
  } catch {
    return null
  }

  return null
}

function scoreManifestIcon(icon: { src: string; sizes: string; purpose: string }): number {
  const sizeScore = Math.max(
    ...icon.sizes
      .split(/\s+/)
      .map((part) => /^\d+x\d+$/i.test(part) ? Number(part.split('x')[0]) : 0),
    0,
  )
  const purposeBoost = /(?:^|\s)any(?:\s|$)/.test(icon.purpose) ? 10000 : 0
  return purposeBoost + sizeScore
}

function readHtmlIconDataUrl(htmlPath: string): string | null {
  if (!existsSync(htmlPath)) return null

  try {
    const html = readFileSync(htmlPath, 'utf8')
    const links = [...html.matchAll(/<link\b[^>]*>/gi)]
    const candidates: Array<{ href: string; score: number }> = []

    for (const match of links) {
      const tag = match[0]
      const rel = readHtmlAttr(tag, 'rel')?.toLowerCase() ?? ''
      const href = readHtmlAttr(tag, 'href')
      if (!href || /^https?:\/\//i.test(href) || href.startsWith('data:')) continue
      if (!/(?:^|\s)(icon|shortcut icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon)(?:\s|$)/.test(rel)) continue

      const sizes = readHtmlAttr(tag, 'sizes') ?? ''
      candidates.push({ href, score: scoreHtmlIcon(rel, sizes) })
    }

    candidates.sort((a, b) => b.score - a.score)
    for (const candidate of candidates) {
      const normalized = candidate.href.replace(/^\.\//, '').replace(/^\//, '')
      const iconPath = join(dirname(htmlPath), normalized)
      const dataUrl = readIconFileAsDataUrl(iconPath)
      if (dataUrl) return dataUrl
    }
  } catch {
    return null
  }

  return null
}

function readHtmlAttr(tag: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`${escaped}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = tag.match(pattern)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

function scoreHtmlIcon(rel: string, sizes: string): number {
  const relBoost = rel.includes('apple-touch-icon') ? 8000
    : rel.includes('shortcut icon') ? 6000
    : rel.includes('mask-icon') ? 2000
    : rel.includes('icon') ? 4000
    : 0
  const sizeScore = Math.max(
    ...sizes
      .split(/\s+/)
      .map((part) => /^\d+x\d+$/i.test(part) ? Number(part.split('x')[0]) : 0),
    0,
  )
  return relBoost + sizeScore
}

function readIconFileAsDataUrl(absPath: string): string | null {
  if (!existsSync(absPath)) return null

  try {
    const stat = statSync(absPath)
    if (!stat.isFile() || stat.size > PROJECT_ICON_MAX_BYTES) return null
    const mime = iconMimeType(absPath)
    if (!mime) return null
    const base64 = readFileSync(absPath).toString('base64')
    return `data:${mime};base64,${base64}`
  } catch {
    return null
  }
}

function iconMimeType(filePath: string): string | null {
  switch (extname(filePath).toLowerCase()) {
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.ico': return 'image/x-icon'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    default: return null
  }
}

function relativeTime(t: number): string {
  const diff = Date.now() - t
  const s = Math.floor(diff / 1000)
  if (s < 60)     return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60)    return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)    return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7)     return `${d}d ago`
  return `${Math.floor(d / 7)}w ago`
}



export interface AddRemoteWorkspaceOptions {
  host: string
  user?: string
  port?: number
  path: string
  name?: string
}

/** Transport-neutral workspace backend shared by Electron IPC and the web server. */
export class WorkspaceService {
  constructor(private readonly storeFilePath: string) {}

  list(): EnrichedWorkspace[] {
    return readStore(this.storeFilePath).workspaces.map(enrich)
  }

  add(absPath: string): { ok?: boolean; error?: string; workspace?: EnrichedWorkspace } {
    if (!absPath) return { error: 'no path' }
    if (!existsSync(absPath)) return { error: `path does not exist: ${absPath}` }
    if (!statSync(absPath).isDirectory()) return { error: 'not a directory' }
    const store = readStore(this.storeFilePath)
    const existing = store.workspaces.find(w => w.path === absPath)
    if (existing) return { ok: true, workspace: enrich(existing) }
    let id = slugifyId(absPath)
    while (store.workspaces.some(w => w.id === id)) id = `${id}-${Math.random().toString(36).slice(2, 6)}`
    const ws: StoredWorkspace = { id, name: basename(absPath), path: absPath, kind: detectKind(absPath), pinned: false, addedAt: Date.now() }
    store.workspaces.push(ws)
    writeStore(this.storeFilePath, store)
    return { ok: true, workspace: enrich(ws) }
  }

  addRemote(opts: AddRemoteWorkspaceOptions): { ok?: boolean; error?: string; workspace?: EnrichedWorkspace } {
    const host = opts?.host?.trim()
    const path = opts?.path?.trim()
    if (!host) return { error: 'host is required' }
    if (!path || !path.startsWith('/')) return { error: 'an absolute remote path is required' }
    const uri = formatRemoteRoot({ host, user: opts.user?.trim() || undefined, port: opts.port, path })
    const store = readStore(this.storeFilePath)
    const existing = store.workspaces.find(w => w.path === uri)
    if (existing) return { ok: true, workspace: enrich(existing) }
    let id = slugifyId(posix.basename(path) || host)
    while (store.workspaces.some(w => w.id === id)) id = `${id}-${Math.random().toString(36).slice(2, 6)}`
    const ws: StoredWorkspace = { id, name: opts.name?.trim() || `${host}:${posix.basename(path) || '/'}`, path: uri, kind: 'remote', pinned: false, addedAt: Date.now(), remote: { host, user: opts.user?.trim() || undefined, port: opts.port } }
    store.workspaces.push(ws)
    writeStore(this.storeFilePath, store)
    return { ok: true, workspace: enrich(ws) }
  }

  remove(id: string): { ok?: boolean; error?: string } {
    const store = readStore(this.storeFilePath)
    const next = store.workspaces.filter(w => w.id !== id)
    if (next.length === store.workspaces.length) return { error: 'not found' }
    writeStore(this.storeFilePath, { workspaces: next })
    return { ok: true }
  }

  pin(id: string, pinned: boolean): { ok?: boolean; error?: string } {
    return this.update(id, workspace => { workspace.pinned = pinned })
  }

  rename(id: string, name: string): { ok?: boolean; error?: string } {
    const trimmed = name?.trim()
    if (!trimmed) return { error: 'name is required' }
    return this.update(id, workspace => { workspace.name = trimmed })
  }

  setFolder(id: string, folder: string | null): { ok?: boolean; error?: string } {
    return this.update(id, workspace => { workspace.folder = folder?.trim() || null })
  }

  cloneRepo(url: string, parentDir: string, folderName?: string): { ok?: boolean; path?: string; error?: string } {
    if (!url?.trim()) return { error: 'repository url is required' }
    if (!parentDir?.trim()) return { error: 'destination directory is required' }
    if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) return { error: `destination is not a directory: ${parentDir}` }
    const target = folderName?.trim() ? join(parentDir, folderName.trim()) : join(parentDir, deriveRepoName(url))
    if (existsSync(target)) return { error: `path already exists: ${target}` }
    const result = spawnSync('git', ['clone', url, target], { encoding: 'utf8' })
    if (result.status !== 0) return { error: (result.stderr || result.stdout || 'git clone failed').trim() }
    return { ok: true, path: target }
  }

  initProject(parentDir: string, folderName: string, asGit: boolean): { ok?: boolean; path?: string; error?: string } {
    if (!parentDir?.trim()) return { error: 'parent directory is required' }
    if (!folderName?.trim()) return { error: 'folder name is required' }
    if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) return { error: `parent is not a directory: ${parentDir}` }
    const target = join(parentDir, folderName.trim())
    if (existsSync(target)) return { error: `path already exists: ${target}` }
    mkdirSync(target, { recursive: true })
    if (asGit) {
      const result = spawnSync('git', ['init'], { cwd: target, encoding: 'utf8' })
      if (result.status !== 0) return { error: (result.stderr || 'git init failed').trim() }
    }
    return { ok: true, path: target }
  }

  private update(id: string, change: (workspace: StoredWorkspace) => void): { ok?: boolean; error?: string } {
    const store = readStore(this.storeFilePath)
    const workspace = store.workspaces.find(item => item.id === id)
    if (!workspace) return { error: 'not found' }
    change(workspace)
    writeStore(this.storeFilePath, store)
    return { ok: true }
  }
}

function deriveRepoName(url: string): string {
  const trimmed = url.trim().replace(/\.git\/?$/, '').replace(/\/+$/, '')
  const last = trimmed.split(/[\/:]/).pop() ?? ''
  return last.replace(/[^a-z0-9_.-]+/gi, '-') || `repo-${Date.now()}`
}

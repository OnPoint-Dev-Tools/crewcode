import { posix } from 'path'

// A remote workspace root is encoded as an ssh:// URI so the existing fs:* IPC
// surface (which already passes `root` + `sub`) can stay byte-for-byte the same
// for local and remote alike. The renderer never has to know the difference —
// it just forwards whatever `root` the workspace carries.
//
//   ssh://[user@]host[:port]<abs-posix-path>
//
// e.g. ssh://cj@build-box:22/home/cj/projects/api
//      ssh://nas/srv/www                          (user/port from ssh config)

export interface RemoteTarget {
  user?: string
  host:  string
  port?: number
  /** Always an absolute POSIX path on the remote. */
  path:  string
  /** Stable connection key — pool entries are shared across workspaces. */
  connId: string
}

export function isRemoteRoot(root: string | undefined | null): boolean {
  return typeof root === 'string' && root.startsWith('ssh://')
}

/** Parse an ssh:// root. Returns null when `root` is not a remote URI. */
export function parseRemoteTarget(root: string): RemoteTarget | null {
  if (!isRemoteRoot(root)) return null

  // Strip scheme, then split authority from the path at the first slash. The
  // remote path is always absolute, so the slash that begins it is also the
  // path's leading separator — keep it.
  const rest      = root.slice('ssh://'.length)
  const slashIdx  = rest.indexOf('/')
  const authority = slashIdx === -1 ? rest : rest.slice(0, slashIdx)
  const path      = slashIdx === -1 ? '/'  : rest.slice(slashIdx)

  let user: string | undefined
  let hostPort = authority
  const at = authority.indexOf('@')
  if (at !== -1) {
    user     = authority.slice(0, at)
    hostPort = authority.slice(at + 1)
  }

  let host = hostPort
  let port: number | undefined
  const colon = hostPort.lastIndexOf(':')
  if (colon !== -1) {
    const maybePort = hostPort.slice(colon + 1)
    if (/^\d+$/.test(maybePort)) {
      host = hostPort.slice(0, colon)
      port = parseInt(maybePort, 10)
    }
  }
  if (!host) return null

  return { user, host, port, path: posix.normalize(path), connId: connKey(user, host, port) }
}

/** Build an ssh:// root URI from its parts. */
export function formatRemoteRoot(t: { user?: string; host: string; port?: number; path: string }): string {
  const auth = `${t.user ? `${t.user}@` : ''}${t.host}${t.port ? `:${t.port}` : ''}`
  const path = t.path.startsWith('/') ? t.path : `/${t.path}`
  return `ssh://${auth}${posix.normalize(path)}`
}

function connKey(user: string | undefined, host: string, port: number | undefined): string {
  return `${user ?? ''}@${host}:${port ?? 22}`
}

// SFTP readdir returns plain Attributes (mode bits only) — no Stats helper
// methods — so classify entries from the POSIX file-type mask directly.
const S_IFMT = 0o170000
export function attrIsDir(mode: number): boolean  { return (mode & S_IFMT) === 0o040000 }
export function attrIsFile(mode: number): boolean { return (mode & S_IFMT) === 0o100000 }

/**
 * Join a remote root + a renderer-supplied relative sub-path and confirm the
 * result stays inside the root. Mirrors fs.ts's safeUnder guard but with POSIX
 * semantics, since the main process may run on Windows while the target is unix.
 */
export function resolveRemote(target: RemoteTarget, sub = ''): { abs: string } | { error: string } {
  const base = target.path
  const abs  = sub ? posix.normalize(posix.join(base, sub)) : base
  if (abs !== base && !abs.startsWith(base.endsWith('/') ? base : base + '/')) {
    return { error: 'path escapes root' }
  }
  return { abs }
}

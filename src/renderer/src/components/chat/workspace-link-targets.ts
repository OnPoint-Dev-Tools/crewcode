const WINDOWS_DRIVE_RE = /^[a-zA-Z]:[\\/]/
const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

function stripQueryAndHash(value: string): string {
  const hash = value.indexOf('#')
  const query = value.indexOf('?')
  const cuts = [hash, query].filter(index => index >= 0)
  return cuts.length === 0 ? value : value.slice(0, Math.min(...cuts))
}

function decodePathComponent(value: string): string {
  try { return decodeURIComponent(value) } catch { return value }
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/')
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || WINDOWS_DRIVE_RE.test(value)
}

function comparisonKey(value: string): string {
  return WINDOWS_DRIVE_RE.test(value) ? value.toLowerCase() : value
}

function stripLineSuffix(value: string): string {
  return value.replace(/:\d+(?::\d+)?$/, '')
}

function collapseRelativePath(value: string): string | null {
  const out: string[] = []
  for (const part of value.split('/')) {
    if (!part || part === '.') continue
    // Generated-file links should never escape the workspace root.
    if (part === '..') return null
    out.push(part)
  }
  return out.length > 0 ? out.join('/') : null
}

function pathFromFileUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') return null
    let path = decodePathComponent(url.pathname)
    if (/^\/[a-zA-Z]:\//.test(path)) path = path.slice(1)
    return path
  } catch {
    return null
  }
}

function relativeToWorkspace(path: string, workspaceRoot?: string): string | null {
  const normalized = stripLineSuffix(normalizeSlashes(path.trim()))
  if (!normalized) return null

  if (isAbsolutePath(normalized)) {
    const root = workspaceRoot ? normalizeSlashes(workspaceRoot.trim()).replace(/\/+$/, '') : ''
    if (!root) return null
    const candidateKey = comparisonKey(normalized)
    const rootKey = comparisonKey(root)
    if (candidateKey === rootKey) return null
    if (!candidateKey.startsWith(`${rootKey}/`)) return null
    return collapseRelativePath(normalized.slice(root.length + 1))
  }

  return collapseRelativePath(normalized)
}

/**
 * Converts a markdown href from an agent reply into a workspace-relative file
 * path when it points at local generated code, otherwise returns null.
 */
export function workspaceFilePathFromHref(href: string, workspaceRoot?: string): string | null {
  const raw = href.trim().replace(/^<|>$/g, '')
  if (!raw || raw.startsWith('#') || raw.startsWith('//')) return null

  const fileUrlPath = /^file:/i.test(raw) ? pathFromFileUrl(raw) : null
  if (fileUrlPath) return relativeToWorkspace(fileUrlPath, workspaceRoot)

  if (!WINDOWS_DRIVE_RE.test(raw) && URI_SCHEME_RE.test(raw)) return null

  const withoutFragment = stripQueryAndHash(raw)
  if (!withoutFragment) return null
  return relativeToWorkspace(decodePathComponent(withoutFragment), workspaceRoot)
}

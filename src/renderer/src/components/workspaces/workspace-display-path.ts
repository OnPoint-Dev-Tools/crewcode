function slashNormalized(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Abbreviate only local paths rooted at the current user's home directory. */
export function workspaceDisplayPath(workspacePath: string, homePath: string): string {
  if (!workspacePath || !homePath || workspacePath.startsWith('ssh://') || workspacePath.startsWith('~')) {
    return workspacePath
  }

  const normalizedPath = slashNormalized(workspacePath)
  const normalizedHome = slashNormalized(homePath)
  const windowsPath = /^[A-Za-z]:\//.test(normalizedPath)
  const comparablePath = windowsPath ? normalizedPath.toLowerCase() : normalizedPath
  const comparableHome = windowsPath ? normalizedHome.toLowerCase() : normalizedHome

  if (comparablePath === comparableHome) return '~'
  if (!comparablePath.startsWith(`${comparableHome}/`)) return workspacePath
  return `~${normalizedPath.slice(normalizedHome.length)}`
}

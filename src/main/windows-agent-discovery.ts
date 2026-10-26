import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { win32 } from 'node:path'

/** Windows GUI launches can inherit PATH from before a CLI was installed. */
export function windowsAgentCandidates(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const appData = env.APPDATA || win32.join(home, 'AppData', 'Roaming')
  const localAppData = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local')
  const directories = [
    ...(env.PATH ?? env.Path ?? '').split(';').map(entry => entry.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean),
    win32.join(home, '.local', 'bin'),
    win32.join(appData, 'npm'),
    win32.join(localAppData, 'pnpm'),
    win32.join(localAppData, 'Yarn', 'bin'),
    win32.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'),
    win32.join(home, '.' + command, 'bin'),
    win32.join(home, '.volta', 'bin'),
    win32.join(home, '.bun', 'bin'),
    win32.join(home, '.cache', '.bun', 'bin'),
    ...(env.BUN_INSTALL ? [win32.join(env.BUN_INSTALL, 'bin')] : []),
    ...(env.NVM_SYMLINK ? [env.NVM_SYMLINK] : []),
    win32.join(home, '.cargo', 'bin'),
    win32.join(home, '.npm-global', 'bin'),
  ]
  // Prefer native executables, then npm batch shims; PowerShell scripts cannot
  // be launched as stdio child processes by Node.
  return [...new Set(directories)].flatMap(directory =>
    ['.exe', '.cmd', '.bat', ''].map(extension => win32.join(directory, command + extension)),
  )
}

export function detectWindowsAgentPath(command: string): string | null {
  return windowsAgentCandidates(command).find(candidate => existsSync(candidate)) ?? null
}

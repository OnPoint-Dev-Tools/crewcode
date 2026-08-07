import { existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

function getExecutableNames(platform: NodeJS.Platform, commandName: string): string[] {
  if (platform === 'win32') {
    return [`${commandName}.cmd`, `${commandName}.exe`, `${commandName}.bat`, commandName]
  }
  return [commandName]
}

function splitPath(pathEnv: string | null | undefined): string[] {
  if (!pathEnv) return []
  return pathEnv.split(delimiter).map((entry) => entry.trim()).filter(Boolean)
}

function parseVersionSegment(raw: string): number[] {
  return raw.replace(/^v/i, '').split('.').map((segment) => Number.parseInt(segment, 10)).map((segment) => (Number.isFinite(segment) ? segment : 0))
}

function compareVersionDesc(left: string, right: string): number {
  const leftParts = parseVersionSegment(left)
  const rightParts = parseVersionSegment(right)
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (rightParts[index] ?? 0) - (leftParts[index] ?? 0)
    if (delta !== 0) return delta
  }
  return right.localeCompare(left)
}

function findFirstExecutable(directories: string[], executableNames: string[]): string | null {
  for (const directory of directories) {
    for (const executableName of executableNames) {
      const candidate = join(directory, executableName)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function getVersionManagerDirectories(platform: NodeJS.Platform, homePath: string, executableNames: string[]): string[] {
  const directories = [
    join(homePath, '.volta', 'bin'),
    join(homePath, '.asdf', 'shims'),
    join(homePath, '.fnm', 'aliases', 'default', 'bin'),
    join(homePath, '.local', 'share', 'mise', 'shims'),
  ]

  const miseNodeVersionsDir = join(homePath, '.local', 'share', 'mise', 'installs', 'node')
  if (existsSync(miseNodeVersionsDir)) {
    const miseNodeDirectories = readdirSync(miseNodeVersionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionDesc)
      .map((entry) => join(miseNodeVersionsDir, entry, 'bin'))

    const firstMiseNodeMatch = findFirstExecutable(miseNodeDirectories, executableNames)
    if (firstMiseNodeMatch) {
      directories.unshift(dirname(firstMiseNodeMatch))
    }
  }

  const nvmVersionsDir = join(homePath, '.nvm', 'versions', 'node')
  if (existsSync(nvmVersionsDir)) {
    const nvmVersionDirectories = readdirSync(nvmVersionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionDesc)
      .map((entry) => join(nvmVersionsDir, entry, 'bin'))

    const firstNvmMatch = findFirstExecutable(nvmVersionDirectories, executableNames)
    if (firstNvmMatch) {
      directories.unshift(dirname(firstNvmMatch))
    }
  }

  if (platform === 'win32') {
    directories.push(join(homePath, 'AppData', 'Roaming', 'npm'))
    directories.push(join(homePath, 'AppData', 'Local', 'pnpm'))
    directories.push(join(homePath, 'AppData', 'Local', 'Yarn', 'bin'))
  } else {
    directories.push(join(homePath, '.local', 'bin'))
    if (platform === 'darwin') {
      directories.push(join(homePath, 'Library', 'pnpm'))
    } else {
      directories.push(join(homePath, '.local', 'share', 'pnpm'))
    }
    directories.push(join(homePath, '.yarn', 'bin'))
  }

  directories.push(join(homePath, '.bun', 'bin'))
  directories.push(join(homePath, '.cache', '.bun', 'bin'))
  directories.push(join(homePath, '.npm-global', 'bin'))
  directories.push(join(homePath, '.cargo', 'bin'))
  directories.push('/usr/local/bin')
  directories.push('/opt/homebrew/bin')
  return directories
}

function expandHome(path: string, homePath: string): string {
  return path === '~' || path.startsWith('~/') ? join(homePath, path.slice(2)) : path
}

function resolveFromLoginShell(commandName: string): string | null {
  if (process.platform === 'win32') return null
  const shell = process.env.SHELL || '/bin/bash'
  const result = spawnSync(shell, ['-lc', `command -v ${commandName}`], { encoding: 'utf8' })
  const resolved = result.stdout?.trim().split('\n').pop()?.trim()
  return resolved && existsSync(resolved) ? resolved : null
}

function resolveCommand(commandName: string, overridePath?: string | null, platform: NodeJS.Platform = process.platform, homePath: string = homedir()): string {
  if (overridePath) {
    const expanded = expandHome(overridePath, homePath)
    if (existsSync(expanded)) return expanded
  }

  const executableNames = getExecutableNames(platform, commandName)
  const pathEnv = process.env.PATH ?? process.env.Path ?? null
  const pathCandidate = findFirstExecutable(splitPath(pathEnv), executableNames)
  if (pathCandidate) return pathCandidate

  // Packaged desktop apps often miss shell-initialized PATH entries; ask the
  // login shell before falling back to static probes.
  const shellCandidate = resolveFromLoginShell(commandName)
  if (shellCandidate) return shellCandidate

  const versionManagerCandidate = findFirstExecutable(
    getVersionManagerDirectories(platform, homePath, executableNames),
    executableNames
  )
  return versionManagerCandidate ?? commandName
}

export function buildAgentCommandEnv(commandPath?: string | null, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const existingPath = process.env.PATH ?? process.env.Path ?? ''
  const homePath = homedir()
  const dirs = [
    commandPath && isAbsolute(commandPath) ? dirname(commandPath) : null,
    ...splitPath(existingPath),
    // npm/bun shims often use `#!/usr/bin/env node`; packaged apps need node's
    // install dir on PATH even when the shell was not the parent process.
    ...getVersionManagerDirectories(process.platform, homePath, getExecutableNames(process.platform, 'node')),
  ].filter((entry): entry is string => Boolean(entry))
  const uniquePath = Array.from(new Set(dirs)).join(delimiter)
  const env = { ...process.env, [pathKey]: uniquePath, PATH: uniquePath, ...extra }
  // Agent CLIs are external Node programs; don't leak Electron launcher flags.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return env
}

export function resolveCodexCommand(overridePath?: string | null): string {
  return resolveCommand('codex', overridePath)
}

export function resolveClaudeCommand(overridePath?: string | null): string {
  return resolveCommand('claude', overridePath)
}

export function resolveOpencodeCommand(overridePath?: string | null): string {
  const resolved = resolveCommand('opencode-cli', overridePath)
  return !overridePath && resolved === 'opencode-cli' ? resolveCommand('opencode') : resolved
}

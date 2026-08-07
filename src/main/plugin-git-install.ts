import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'fs'
import os from 'os'
import { basename, join } from 'path'

import {
  CREWCODE_PLUGIN_MANIFEST,
  type CrewCodePluginManifest,
  type InstalledPlugin,
  type PluginGitCandidate,
  type PluginGitSource,
} from '../shared/plugin-types'
import { pluginPermissionFingerprint, validatePluginManifest } from './plugin-contract'

const PLUGIN_SOURCES_FILE = 'plugin-sources.json'
const MAX_PLUGIN_FILES = 3_000
const MAX_PLUGIN_FILE_BYTES = 10 * 1024 * 1024
const MAX_PLUGIN_TOTAL_BYTES = 50 * 1024 * 1024
const GIT_TIMEOUT_MS = 60_000

interface PluginCheckoutStats {
  manifest: CrewCodePluginManifest
  fileCount: number
  totalBytes: number
}

interface PendingPluginInstall {
  candidate: PluginGitCandidate
  checkoutPath: string
}

const pendingInstalls = new Map<string, PendingPluginInstall>()

function git(args: string[], cwd: string, configPath?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        ...(configPath ? { GIT_CONFIG_GLOBAL: configPath } : {}),
      },
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message || 'git command failed').trim()))
        return
      }
      resolve(stdout.trim())
    })
  })
}

export function normalizePluginGitUrl(raw: string): string {
  const input = raw.trim()
  if (!input) throw new Error('repository URL is required')

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('enter a full public HTTPS repository URL')
  }
  if (url.protocol !== 'https:') throw new Error('plugin repositories must use public HTTPS URLs')
  if (url.username || url.password) throw new Error('repository URLs cannot contain credentials')
  if (url.search || url.hash) throw new Error('repository URLs cannot contain query parameters or fragments')
  if (!url.hostname || url.pathname === '/') throw new Error('repository URL must identify a repository')

  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString()
}

export function inspectPluginCheckout(checkoutPath: string): PluginCheckoutStats {
  const manifestPath = join(checkoutPath, CREWCODE_PLUGIN_MANIFEST)
  if (!existsSync(manifestPath)) throw new Error(`${CREWCODE_PLUGIN_MANIFEST} must be at the repository root`)
  if (existsSync(join(checkoutPath, '.gitmodules'))) throw new Error('plugin repositories cannot use Git submodules')

  let fileCount = 0
  let totalBytes = 0
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue
      if (name === 'node_modules') throw new Error('plugin repositories cannot include node_modules')
      const target = join(dir, name)
      const stat = lstatSync(target)
      if (stat.isSymbolicLink()) throw new Error(`plugin repositories cannot contain symbolic links: ${name}`)
      if (stat.isDirectory()) {
        walk(target)
        continue
      }
      if (!stat.isFile()) throw new Error(`plugin repositories cannot contain special files: ${name}`)
      fileCount += 1
      totalBytes += stat.size
      if (fileCount > MAX_PLUGIN_FILES) throw new Error(`plugin exceeds the ${MAX_PLUGIN_FILES.toLocaleString()} file limit`)
      if (stat.size > MAX_PLUGIN_FILE_BYTES) throw new Error(`plugin file exceeds the 10 MB limit: ${name}`)
      if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) throw new Error('plugin exceeds the 50 MB installed-size limit')
    }
  }
  walk(checkoutPath)

  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return {
    manifest: validatePluginManifest(raw, checkoutPath),
    fileCount,
    totalBytes,
  }
}

export function readPluginGitSources(crewcodeRoot: string): Record<string, PluginGitSource> {
  try {
    const raw = JSON.parse(readFileSync(join(crewcodeRoot, PLUGIN_SOURCES_FILE), 'utf8'))
    if (!raw || typeof raw !== 'object') return {}
    const sources: Record<string, PluginGitSource> = {}
    for (const [pluginId, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const source = value as Partial<PluginGitSource>
      if (
        typeof source.repositoryUrl !== 'string'
        || typeof source.revision !== 'string'
        || typeof source.installedAt !== 'number'
        || typeof source.updatedAt !== 'number'
      ) continue
      sources[pluginId] = source as PluginGitSource
    }
    return sources
  } catch {
    return {}
  }
}

function writePluginGitSources(crewcodeRoot: string, sources: Record<string, PluginGitSource>): void {
  mkdirSync(crewcodeRoot, { recursive: true })
  writeFileSync(join(crewcodeRoot, PLUGIN_SOURCES_FILE), `${JSON.stringify(sources, null, 2)}\n`, 'utf8')
}

export async function inspectPluginGitRepository(
  repositoryUrl: string,
  installedPlugins: InstalledPlugin[],
  expectedPluginId?: string,
): Promise<PluginGitCandidate> {
  const normalizedUrl = normalizePluginGitUrl(repositoryUrl)
  const stagingRoot = mkdtempSync(join(os.tmpdir(), 'crewcode-plugin-git-'))
  const checkoutPath = join(stagingRoot, 'checkout')
  const emptyConfigPath = join(stagingRoot, 'gitconfig')
  const emptyHooksPath = join(stagingRoot, 'hooks')
  writeFileSync(emptyConfigPath, '', 'utf8')
  mkdirSync(emptyHooksPath)

  await git([
    '-c', 'protocol.file.allow=never',
    '-c', `core.hooksPath=${emptyHooksPath}`,
    '-c', 'init.templateDir=',
    'clone',
    '--depth', '1',
    '--no-tags',
    '--single-branch',
    '--no-recurse-submodules',
    normalizedUrl,
    checkoutPath,
  ], stagingRoot, emptyConfigPath)

  // Git modes catch symlinks and submodules even on Windows checkouts where the
  // working tree may represent them as ordinary files or empty directories.
  const indexModes = await git(['ls-files', '--stage'], checkoutPath, emptyConfigPath)
  if (indexModes.split('\n').some(line => line.startsWith('120000 '))) {
    throw new Error('plugin repositories cannot contain symbolic links')
  }
  if (indexModes.split('\n').some(line => line.startsWith('160000 '))) {
    throw new Error('plugin repositories cannot contain Git submodules')
  }

  const revision = await git(['rev-parse', 'HEAD'], checkoutPath, emptyConfigPath)
  const { manifest, fileCount, totalBytes } = inspectPluginCheckout(checkoutPath)
  if (expectedPluginId && manifest.id !== expectedPluginId) {
    throw new Error(`repository manifest id "${manifest.id}" does not match installed plugin "${expectedPluginId}"`)
  }

  const installed = installedPlugins.find(plugin => plugin.id === manifest.id)
  if (installed && installed.source?.repositoryUrl !== normalizedUrl) {
    throw new Error(`plugin "${manifest.id}" is already installed from another source`)
  }

  const token = randomUUID()
  const candidate: PluginGitCandidate = {
    token,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    repositoryUrl: normalizedUrl,
    revision,
    permissions: manifest.permissions ?? [],
    mode: installed ? 'update' : 'install',
    currentVersion: installed?.manifest.version,
    currentRevision: installed?.source?.revision,
    permissionsChanged: installed
      ? pluginPermissionFingerprint(installed.manifest.permissions) !== pluginPermissionFingerprint(manifest.permissions)
      : false,
    updateAvailable: !installed || installed.source?.revision !== revision,
    fileCount,
    totalBytes,
  }
  pendingInstalls.set(token, { candidate, checkoutPath })
  return candidate
}

function timestampLabel(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export function commitPluginGitInstall(
  token: string,
  crewcodeRoot: string,
  pluginsRoot: string,
  beforeActivate: (pluginId: string) => void,
): { pluginId: string; backupPath?: string } {
  const pending = pendingInstalls.get(token)
  if (!pending) throw new Error('plugin review expired; inspect the repository again')
  pendingInstalls.delete(token)
  if (!pending.candidate.updateAvailable) throw new Error('plugin is already current')

  const { candidate, checkoutPath } = pending
  const target = join(pluginsRoot, candidate.id)
  const installTarget = join(pluginsRoot, `.installing-${candidate.id}-${token}`)
  if (existsSync(installTarget)) throw new Error('plugin staging destination already exists')
  if (candidate.mode === 'install' && existsSync(target)) throw new Error(`plugin "${candidate.id}" was installed while its review was open`)
  if (candidate.mode === 'update' && !existsSync(target)) throw new Error(`plugin "${candidate.id}" was removed while its review was open`)

  const sourcesBeforeInstall = readPluginGitSources(crewcodeRoot)
  if (candidate.mode === 'update') {
    const currentSource = sourcesBeforeInstall[candidate.id]
    if (
      !currentSource
      || currentSource.repositoryUrl !== candidate.repositoryUrl
      || currentSource.revision !== candidate.currentRevision
    ) {
      throw new Error(`plugin "${candidate.id}" changed while its update review was open`)
    }
  }

  mkdirSync(pluginsRoot, { recursive: true })
  cpSync(checkoutPath, installTarget, {
    recursive: true,
    filter: source => basename(source) !== '.git',
  })
  inspectPluginCheckout(installTarget)

  // Approval must be cleared before new files can replace an active revision.
  // A later metadata/write failure may be recoverable, stale approval is not.
  beforeActivate(candidate.id)

  let backupPath: string | undefined
  if (existsSync(target)) {
    const backupRoot = join(crewcodeRoot, 'plugin-backups')
    mkdirSync(backupRoot, { recursive: true })
    backupPath = join(backupRoot, `${candidate.id}-${timestampLabel()}`)
    renameSync(target, backupPath)
  }

  try {
    renameSync(installTarget, target)
  } catch (error) {
    if (backupPath && !existsSync(target)) renameSync(backupPath, target)
    throw error
  }

  const sources = readPluginGitSources(crewcodeRoot)
  const now = Date.now()
  const previous = sources[candidate.id]
  sources[candidate.id] = {
    repositoryUrl: candidate.repositoryUrl,
    revision: candidate.revision,
    installedAt: previous?.installedAt ?? now,
    updatedAt: now,
  }
  writePluginGitSources(crewcodeRoot, sources)
  return { pluginId: candidate.id, backupPath }
}

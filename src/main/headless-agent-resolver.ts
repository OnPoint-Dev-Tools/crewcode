import { existsSync, constants as fsConstants, promises as fsp } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { execFile, spawnSync } from 'child_process'
import { listModels } from './agents/model-detect'

const PROVIDER_COMMANDS: Record<string, string> = {
  pi: 'pi', opencode: 'opencode-cli', codex: 'codex', claude: 'claude',
  hermes: 'hermes', crewcoder: 'crewcoder', grok: 'grok', ollama: 'ollama',
}

const HEADLESS_AGENT_NAMES: Record<string, string> = {
  pi: 'pi', opencode: 'OpenCode', codex: 'Codex', claude: 'Claude Agent',
  hermes: 'Hermes', crewcoder: 'CrewCoder', grok: 'Grok Build', ollama: 'Ollama', openrouter: 'OpenRouter',
}

export interface HeadlessDetectedModel {
  id: string
  label: string
  provider: string
}

/** Same CLI/server discovery as desktop, using PATH and common install locations
 * instead of Electron path overrides. Empty results keep the renderer catalog. */
export async function listHeadlessAgentModels(provider: string): Promise<HeadlessDetectedModel[]> {
  const cliPath = provider === 'ollama' || provider === 'openrouter' ? null : resolveHeadlessAgentPath(provider)
  try {
    return await listModels(provider, cliPath)
  } catch {
    return []
  }
}

export interface HeadlessAgentInfo {
  id: string
  name: string
  cmd: string
  path: string | null
  defaultPath: string | null
  available: boolean
  transport: 'bridge'
  source: 'builtin'
  requiresApiKey?: boolean
}

/** Public, secret-free provider metadata for authenticated browser clients. */
export async function headlessAgentRegistry(): Promise<HeadlessAgentInfo[]> {
  return Promise.all(Object.entries(HEADLESS_AGENT_NAMES).map(async ([id, name]) => {
    const command = PROVIDER_COMMANDS[id] ?? ''
    const path = command ? await resolveHeadlessAgentPathForRegistry(id) : null
    const requiresApiKey = id === 'openrouter'
    return {
      id, name, cmd: command, path, defaultPath: path,
      // Hosted providers are selectable; bridge startup performs the server-side
      // key check without disclosing whether or what credential is configured.
      available: requiresApiKey || path !== null,
      transport: 'bridge', source: 'builtin', requiresApiKey,
    }
  }))
}

function candidatePaths(command: string): string[] {
  const pathEntries = (process.env.PATH ?? '').split(delimiter)
  const home = homedir()
  return [
    ...pathEntries.map(dir => join(dir, command)),
    join(home, '.local', 'bin', command), join(home, '.bun', 'bin', command),
    join(home, '.cache', '.bun', 'bin', command),
    join(home, '.cargo', 'bin', command), join(home, '.npm-global', 'bin', command),
    join(home, '.volta', 'bin', command), join(home, '.local', 'share', 'mise', 'shims', command),
  ]
}

async function executableExists(candidate: string): Promise<boolean> {
  try { await fsp.access(candidate, fsConstants.X_OK); return true } catch { return false }
}

function shellResolve(command: string, flag: '-lc' | '-ic'): Promise<string | null> {
  if (process.platform === 'win32') return Promise.resolve(null)
  const shell = process.env.SHELL || '/bin/sh'
  return new Promise(resolve => {
    execFile(shell, [flag, `command -v ${command}`], { encoding: 'utf8', timeout: 3_000, windowsHide: true }, (_error, stdout) => {
      const path = stdout?.trim().split('\n').pop()?.trim()
      resolve(path || null)
    })
  })
}

/** Registry discovery runs during automatic renderer refresh, so it uses only
 * asynchronous filesystem and child-process APIs. */
async function resolveHeadlessAgentPathForRegistry(provider: string): Promise<string | null> {
  const command = PROVIDER_COMMANDS[provider]
  if (!command) return null
  for (const candidate of candidatePaths(command)) if (candidate && await executableExists(candidate)) return candidate
  for (const flag of ['-lc', '-ic'] as const) {
    const resolved = await shellResolve(command, flag)
    if (resolved && await executableExists(resolved)) return resolved
  }
  return null
}

/** Resolve provider CLIs without importing Electron's desktop registry. */
export function resolveHeadlessAgentPath(provider: string): string | null {
  const command = PROVIDER_COMMANDS[provider]
  if (!command) return null
  for (const candidate of candidatePaths(command)) if (candidate && existsSync(candidate)) return candidate
  if (process.platform !== 'win32') {
    for (const flag of ['-lc', '-ic'] as const) {
      const result = spawnSync(process.env.SHELL || '/bin/sh', [flag, `command -v ${command}`], { encoding: 'utf8', timeout: 3_000 })
      const resolved = result.stdout?.trim().split('\n').pop()?.trim()
      if (resolved && existsSync(resolved)) return resolved
    }
  }
  return null
}

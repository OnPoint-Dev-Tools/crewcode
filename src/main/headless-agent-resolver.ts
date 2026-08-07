import { existsSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { spawnSync } from 'child_process'

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

/** Dynamic discovery that is safe in a headless process. Unsupported provider
 * CLIs return an empty list so the shared renderer uses its curated catalog. */
export async function listHeadlessAgentModels(provider: string): Promise<HeadlessDetectedModel[]> {
  if (provider !== 'ollama') return []
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return []
    const payload = await response.json() as { models?: Array<{ name?: unknown }> }
    return (payload.models ?? [])
      .map(model => typeof model.name === 'string' ? model.name.trim() : '')
      .filter(Boolean)
      .map(id => ({ id, label: id, provider: 'ollama' }))
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
export function headlessAgentRegistry(): HeadlessAgentInfo[] {
  return Object.entries(HEADLESS_AGENT_NAMES).map(([id, name]) => {
    const command = PROVIDER_COMMANDS[id] ?? ''
    const path = command ? resolveHeadlessAgentPath(id) : null
    const requiresApiKey = id === 'openrouter'
    return {
      id, name, cmd: command, path, defaultPath: path,
      // Hosted providers are selectable; bridge startup performs the server-side
      // key check without disclosing whether or what credential is configured.
      available: requiresApiKey || path !== null,
      transport: 'bridge', source: 'builtin', requiresApiKey,
    }
  })
}

/** Resolve provider CLIs without importing Electron's desktop registry. */
export function resolveHeadlessAgentPath(provider: string): string | null {
  const command = PROVIDER_COMMANDS[provider]
  if (!command) return null
  const pathEntries = (process.env.PATH ?? '').split(delimiter)
  const home = homedir()
  const candidates = [
    ...pathEntries.map(dir => join(dir, command)),
    join(home, '.local', 'bin', command), join(home, '.bun', 'bin', command),
    join(home, '.cargo', 'bin', command), join(home, '.npm-global', 'bin', command),
    join(home, '.volta', 'bin', command), join(home, '.local', 'share', 'mise', 'shims', command),
  ]
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  if (process.platform !== 'win32') {
    const result = spawnSync(process.env.SHELL || '/bin/sh', ['-lc', `command -v ${command}`], { encoding: 'utf8', timeout: 3_000 })
    const resolved = result.stdout?.trim().split('\n').pop()?.trim()
    if (resolved && existsSync(resolved)) return resolved
  }
  return null
}

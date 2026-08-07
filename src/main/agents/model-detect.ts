import { spawnSync, spawn } from 'child_process'
import { existsSync, readFileSync, readdirSync } from 'fs'
import { delimiter, dirname, isAbsolute, join } from 'path'
import os from 'os'
import { net } from 'electron'
import { getSpawnArgsForWindows } from '../win32-utils'
import { registerContextWindow } from './model-context'

export interface DetectedModel {
  id:            string                  // canonical id used by the CLI (e.g. "openai/gpt-5.4")
  label:         string                  // friendly label shown in the picker
  provider:      string                  // upstream LLM provider (google, anthropic, openai, …)
  contextWindow?: number                 // provider-reported context window, when available
}

const cache: Record<string, { ts: number; models: DetectedModel[] }> = {}
const TTL_MS = 60_000
const THINKING_SUFFIX = /:(off|low|medium|high|xhigh)$/i

interface PiSettingsModelScope {
  defaultProvider?: unknown
  enabledModels?: unknown
}

interface PiModelScope {
  defaultProvider?: string
  enabledModels: string[]
}

function miseNodeBins(home: string): string[] {
  const root = join(home, '.local', 'share', 'mise', 'installs', 'node')
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(root, entry.name, 'bin'))
  } catch {
    return []
  }
}

function modelDetectEnv(commandPath?: string | null): NodeJS.ProcessEnv {
  const home = os.homedir()
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const existingPath = process.env.PATH ?? process.env.Path ?? ''
  const dirs = [
    commandPath && isAbsolute(commandPath) ? dirname(commandPath) : null,
    ...existingPath.split(delimiter),
    join(home, '.local', 'share', 'mise', 'shims'),
    ...miseNodeBins(home),
    join(home, '.asdf', 'shims'),
    join(home, '.volta', 'bin'),
    join(home, '.fnm', 'aliases', 'default', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cache', '.bun', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.cargo', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ].filter((entry): entry is string => Boolean(entry))
  const uniquePath = Array.from(new Set(dirs)).join(delimiter)
  return { ...process.env, [pathKey]: uniquePath, PATH: uniquePath }
}

function runCommand(command: string, args: string[], timeout = 20_000): { stdout: string; stderr: string; status: number | null; error?: Error } {
  const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, args)
  const r = spawnSync(spawnCmd, spawnArgs, {
    encoding:  'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: modelDetectEnv(command),
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status, error: r.error }
}

export function parseContextWindowToken(value: string | undefined): number | undefined {
  const raw = value?.trim()
  if (!raw) return undefined
  const match = raw.match(/^(\d+(?:\.\d+)?)([km])?$/i)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  const multiplier = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1
  return Math.round(amount * multiplier)
}

export function registerDetectedModelContextWindows(models: DetectedModel[]): void {
  for (const model of models) {
    registerContextWindow(model.id, model.contextWindow)
    registerContextWindow(model.label, model.contextWindow)
  }
}

function piSettingsPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR || join(os.homedir(), '.pi', 'agent'), 'settings.json')
}

function readPiModelScope(): PiModelScope {
  try {
    const settings = JSON.parse(readFileSync(piSettingsPath(), 'utf8')) as PiSettingsModelScope
    const raw = settings.enabledModels
    const entries = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
    return {
      defaultProvider: typeof settings.defaultProvider === 'string' ? settings.defaultProvider : undefined,
      enabledModels: entries
        .flatMap(entry => String(entry).split(','))
        .map(entry => entry.trim().replace(THINKING_SUFFIX, ''))
        .filter(Boolean),
    }
  } catch {
    return { enabledModels: [] }
  }
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function compactModelRef(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function matchesModelPattern(model: DetectedModel, pattern: string): boolean {
  const normalized = pattern.replace(THINKING_SUFFIX, '').trim()
  if (!normalized) return false
  const id = model.id
  const label = model.label
  const provider = model.provider
  if (normalized.includes('*') || normalized.includes('?')) {
    const glob = globToRegExp(normalized)
    return glob.test(id) || glob.test(label) || glob.test(provider)
  }
  const exact = normalized.toLowerCase()
  if (id.toLowerCase() === exact || label.toLowerCase() === exact || provider.toLowerCase() === exact) return true
  if (normalized.includes('/')) return false
  const compactPattern = compactModelRef(normalized)
  return compactModelRef(id).includes(compactPattern) || compactModelRef(label).includes(compactPattern)
}

export function modelsFromPiEnabledModelPatterns(patterns: string[], defaultProvider?: string): DetectedModel[] {
  const out: DetectedModel[] = []
  const seen = new Set<string>()
  for (const pattern of patterns) {
    const id = pattern.trim().replace(THINKING_SUFFIX, '')
    if (!id || id.includes('*') || id.includes('?')) return []
    const slash = id.indexOf('/')
    const provider = slash > 0 ? id.slice(0, slash) : (defaultProvider ?? 'pi')
    const label = slash > 0 ? id.slice(slash + 1) : id
    const model: DetectedModel = { id, label, provider }
    if (seen.has(model.id)) continue
    seen.add(model.id)
    out.push(model)
  }
  return out
}

export function applyPiEnabledModelScope(models: DetectedModel[], patterns: string[]): DetectedModel[] {
  const normalizedPatterns = patterns.map(pattern => pattern.trim()).filter(Boolean)
  if (normalizedPatterns.length === 0) return models
  const scoped: DetectedModel[] = []
  const seen = new Set<string>()
  for (const pattern of normalizedPatterns) {
    for (const model of models) {
      if (seen.has(model.id) || !matchesModelPattern(model, pattern)) continue
      scoped.push(model)
      seen.add(model.id)
    }
  }
  // If settings got stale, keep Pi usable instead of showing an empty picker.
  return scoped.length > 0 ? scoped : models
}

export function parsePiListing(stdout: string): DetectedModel[] {
  const lines = stdout.split('\n')
  const out: DetectedModel[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    // Skip the header row
    if (/^provider\s+model\b/i.test(line)) continue
    // Skip pi banner / status lines that don't look like a tabular row
    const cols = line.split(/\s{2,}|\t+/).filter(Boolean)
    if (cols.length < 2) continue
    const provider = cols[0]
    const modelId  = cols[1]
    if (!/^[a-z0-9_.\-/:~]+$/i.test(modelId)) continue
    out.push({
      id:            `${provider}/${modelId}`,
      label:         modelId,
      provider,
      contextWindow: parseContextWindowToken(cols[2]),
    })
  }
  return out
}

function outputWithModelTable(r: { stdout: string; stderr: string }): string {
  if (/^provider\s+model\b/im.test(r.stdout)) return r.stdout
  if (/^provider\s+model\b/im.test(r.stderr)) return r.stderr
  return `${r.stdout}\n${r.stderr}`
}

function detectPi(piPath: string): DetectedModel[] {
  const scope = readPiModelScope()
  const scopedModels = modelsFromPiEnabledModelPatterns(scope.enabledModels, scope.defaultProvider)
  if (scopedModels.length > 0) return scopedModels

  // Use Pi's canonical model-listing command so CrewCode mirrors the models Pi
  // itself exposes after auth/custom model filtering. Fall back to offline only
  // if normal startup checks make the command fail in a constrained environment.
  for (const args of [['--list-models'], ['--offline', '--list-models']]) {
    const r = runCommand(piPath, args, 30_000)
    if (r.error) {
      process.stderr.write(`[CrewCode] pi ${args.join(' ')} spawn error: ${r.error.message}\n`)
      continue
    }
    if (r.status !== 0) {
      process.stderr.write(`[CrewCode] pi ${args.join(' ')} exit ${r.status}: ${(r.stderr || r.stdout).slice(0, 400)}\n`)
      continue
    }
    const models = parsePiListing(outputWithModelTable(r))
    if (models.length > 0) {
      // Mirror Pi's saved /scoped-models list so CrewCode's picker matches Ctrl+P.
      return applyPiEnabledModelScope(models, scope.enabledModels)
    }
  }
  return []
}

function parseOpencodeListing(stdout: string): DetectedModel[] {
  const lines = stdout.split('\n')
  const out: DetectedModel[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    // opencode tends to print "providerID/modelID" or two-column entries
    const slashMatch = line.match(/^([a-z0-9_-]+)\/([a-z0-9_.\-/:]+)\s*$/i)
    if (slashMatch) {
      out.push({ id: `${slashMatch[1]}/${slashMatch[2]}`, label: slashMatch[2], provider: slashMatch[1] })
      continue
    }
    const cols = line.split(/\s{2,}|\t+/).filter(Boolean)
    if (cols.length >= 2 && /^[a-z0-9_-]+$/i.test(cols[0]) && /^[a-z0-9_.\-/:]+$/i.test(cols[1])) {
      out.push({ id: `${cols[0]}/${cols[1]}`, label: cols[1], provider: cols[0] })
    }
  }
  return out
}

function detectOpencode(opencodePath: string): DetectedModel[] {
  for (const args of [['models'], ['models', 'list'], ['--list-models']]) {
    const r = runCommand(opencodePath, args, 8_000)
    if (r.status === 0 && r.stdout) {
      const parsed = parseOpencodeListing(r.stdout)
      if (parsed.length > 0) return parsed
    }
    if (r.error) process.stderr.write(`[CrewCode] opencode models spawn error: ${r.error.message}\n`)
  }
  return []
}

function detectClaude(claudePath: string): DetectedModel[] {
  const help = runCommand(claudePath, ['--help'], 8_000)
  if (help.error) {
    process.stderr.write(`[CrewCode] claude --help spawn error: ${help.error.message}\n`)
    return []
  }
  if (help.status !== 0) return []

  const output = help.stdout || help.stderr
  const advertisedAliases = new Set(
    (output.match(/'([^']+)'/g) ?? [])
      .map(value => value.replace(/'/g, '').trim().toLowerCase())
      .filter(Boolean),
  )

  // Claude Code does not expose a stable non-interactive model-list command.
  // Avoid scraping the executable: it includes legacy internal model ids that
  // are not the current /model picker choices.
  const models: DetectedModel[] = [
   { id: 'claude-opus-5',        label: 'Claude Opus 5 (latest)',       provider: 'anthropic', contextWindow: 1_000_000 },
    { id: 'claude-sonnet-5',      label: 'Claude Sonnet 5 (latest)',     provider: 'anthropic', contextWindow: 1_000_000 },
    { id: 'claude-haiku-4-5',       label: 'Claude Haiku 4.5 (latest)',      provider: 'anthropic', contextWindow: 200_000 },
    { id: 'claude-opus-4-8',        label: 'Claude Opus 4.8',       provider: 'anthropic', contextWindow: 500_000 },
    { id: 'claude-sonnet-4-6',        label: 'Claude Opus 4.6',       provider: 'anthropic', contextWindow: 500_000 },
  ]

  if (advertisedAliases.has('fable')) {
    models.push({ id: 'claude-fable-5', label: 'Fable 5', provider: 'anthropic', contextWindow: 500_000 })
  }

  return models
}

// Codex doesn't ship a `--list-models` flag; the canonical source is `model/list`
// over the app-server JSON-RPC. We spawn `codex app-server`, do the minimum
// handshake (initialize → initialized → model/list), then tear the process down.
// Result is cached the same way pi/opencode are so the picker stays snappy.
function detectCodex(codexPath: string): Promise<DetectedModel[]> {
  return new Promise<DetectedModel[]>((resolve) => {
    let settled = false
    const finish = (models: DetectedModel[]) => {
      if (settled) return
      settled = true
      try { proc.kill() } catch { /* ignore */ }
      resolve(models)
    }

    let proc: ReturnType<typeof spawn>
    try {
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(codexPath, ['app-server'])
      proc = spawn(spawnCmd, spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: modelDetectEnv(codexPath) })
    } catch (err) {
      process.stderr.write(`[CrewCode] codex app-server spawn failed: ${(err as Error).message}\n`)
      resolve([])
      return
    }

    let stderrTail = ''
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => { stderrTail = (stderrTail + chunk).slice(-1000) })

    proc.on('error', (err) => {
      process.stderr.write(`[CrewCode] codex app-server error: ${err.message}\n`)
      finish([])
    })
    proc.on('close', () => { finish([]) })

    const timeout = setTimeout(() => {
      if (stderrTail) process.stderr.write(`[CrewCode] codex app-server timeout: ${stderrTail.slice(-400)}\n`)
      finish([])
    }, 8000)

    let buf = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let parsed: { id?: number; result?: Record<string, unknown>; error?: { message?: string } }
        try {
          parsed = JSON.parse(line)
        } catch { continue }
        if (parsed.id === 1 && parsed.result) {
          // initialize response — emit initialized + model/list
          proc.stdin?.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
          proc.stdin?.write(JSON.stringify({ method: 'model/list', id: 2, params: { limit: 100, includeHidden: false } }) + '\n')
        } else if (parsed.id === 2) {
          clearTimeout(timeout)
          if (parsed.error) {
            process.stderr.write(`[CrewCode] codex model/list error: ${parsed.error.message ?? ''}\n`)
            finish([])
            return
          }
          const data = (parsed.result?.data as Array<{ id?: string; model?: string; displayName?: string; hidden?: boolean }> | undefined) ?? []
          const models: DetectedModel[] = []
          for (const m of data) {
            const id = m.id ?? m.model
            if (!id || m.hidden) continue
            models.push({ id, label: m.displayName ?? id, provider: 'codex' })
          }
          finish(models)
        }
      }
    })

    proc.stdin?.write(JSON.stringify({
      method: 'initialize',
      id:     1,
      params: { clientInfo: { name: 'crewcode', title: 'CrewCode', version: '0.1.0' } },
    }) + '\n')
  })
}

// Hermes doesn't ship a `--list-models` flag — its model picker (`hermes
// model`) is interactive. The user's curated picks live in ~/.hermes/models.json
// (the same file the hermes UI writes when you add a model). Parse that to
// populate the picker; if it's missing we fall back to an empty list and the
// user can still drive selection via /model inside chat.
interface HermesModelEntry {
  id?:        string
  name?:      string
  provider?:  string
  model?:     string
  baseUrl?:   string
}

function detectHermesFromJson(): DetectedModel[] {
  const path = join(os.homedir(), '.hermes', 'models.json')
  if (!existsSync(path)) return []
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch { return [] }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const out: DetectedModel[] = []
  for (const entry of parsed as HermesModelEntry[]) {
    const rawModel = entry.model
    if (!rawModel || typeof rawModel !== 'string') continue
    const slash = rawModel.indexOf('/')
    let provider: string
    let bareModel: string
    if (entry.provider && entry.provider !== 'auto') {
      provider  = entry.provider
      bareModel = rawModel
    } else if (slash > 0) {
      provider  = rawModel.slice(0, slash)
      bareModel = rawModel.slice(slash + 1)
    } else {
      provider  = 'hermes'
      bareModel = rawModel
    }
    out.push({
      id:       `${provider}:${bareModel}`,
      label:    entry.name ?? bareModel,
      provider,
    })
  }
  return out
}

// Spawn `hermes acp`, do the ACP handshake, capture the available_models from
// the session/new response (this is the same list hermes shows IDE clients
// like Zed) and shut it down. The user-curated models.json only has whatever
// the user manually added; the ACP response includes the provider's full
// curated catalog (curated_models_for_provider in hermes_cli/models.py).
function detectHermesFromAcp(hermesPath: string): Promise<DetectedModel[]> {
  return new Promise<DetectedModel[]>((resolve) => {
    let settled = false
    const finish = (models: DetectedModel[]) => {
      if (settled) return
      settled = true
      try { proc.kill() } catch { /* ignore */ }
      resolve(models)
    }

    let proc: ReturnType<typeof spawn>
    try {
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(hermesPath, ['acp'])
      proc = spawn(spawnCmd, spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: modelDetectEnv(hermesPath) })
    } catch (err) {
      process.stderr.write(`[CrewCode] hermes acp spawn failed: ${(err as Error).message}\n`)
      resolve([])
      return
    }

    proc.on('error', (err) => { process.stderr.write(`[CrewCode] hermes acp error: ${err.message}\n`); finish([]) })
    proc.on('close', () => finish([]))
    const timer = setTimeout(() => finish([]), 12_000)

    // Hermes pours INFO logs into stderr during startup ("Plugin discovery
    // complete…"). If we don't drain the pipe it fills ~64KB and hermes
    // blocks, the JSON-RPC response on stdout never lands, we time out, and
    // the picker falls back to models.json. Discard stderr explicitly.
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.resume()

    let buf = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        let msg: { id?: number; result?: { models?: { availableModels?: Array<{ modelId?: string; name?: string; description?: string }> } } }
        try { msg = JSON.parse(line) } catch { continue }
        if (msg.id === 1 && msg.result) {
          proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: os.homedir(), mcpServers: [] } }) + '\n')
        } else if (msg.id === 2 && msg.result) {
          clearTimeout(timer)
          const available = msg.result.models?.availableModels ?? []
          const out: DetectedModel[] = []
          for (const m of available) {
            const id = m.modelId
            if (!id) continue
            // ACP encodes choice ids as `provider:model`. Pull the provider out
            // for grouping; fall back to "hermes" if there's no colon.
            const colon = id.indexOf(':')
            const provider = colon > 0 ? id.slice(0, colon) : 'hermes'
            out.push({ id, label: m.name ?? id, provider })
          }
          finish(out)
        }
      }
    })

    proc.stdin?.write(JSON.stringify({
      jsonrpc: '2.0',
      id:      1,
      method:  'initialize',
      params:  { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } },
    }) + '\n')
  })
}

async function detectHermes(hermesPath: string | null): Promise<DetectedModel[]> {
  const fromJson = detectHermesFromJson()
  if (!hermesPath) return fromJson
  const fromAcp = await detectHermesFromAcp(hermesPath)
  if (fromAcp.length === 0) return fromJson
  // Merge: ACP gives the curated catalog for the active provider, models.json
  // adds anything the user manually configured beyond that. De-dup by id.
  const seen = new Set(fromAcp.map(m => m.id))
  const out = [...fromAcp]
  for (const m of fromJson) if (!seen.has(m.id)) out.push(m)
  return out
}

// CrewCoder deliberately exposes the same hermes-compatible model extension:
// session/new returns models.availableModels with provider:model ids.
function detectCrewCoderModels(crewCoderPath: string | null): Promise<DetectedModel[]> {
  if (!crewCoderPath) return Promise.resolve([])
  return new Promise<DetectedModel[]>((resolve) => {
    let settled = false
    let proc: ReturnType<typeof spawn>
    const finish = (models: DetectedModel[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { proc.kill() } catch { /* already closed */ }
      resolve(models)
    }

    try {
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(crewCoderPath, ['acp'])
      proc = spawn(spawnCmd, spawnArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: modelDetectEnv(crewCoderPath),
      })
    } catch (err) {
      process.stderr.write(`[CrewCode] crewcoder acp spawn failed: ${(err as Error).message}\n`)
      resolve([])
      return
    }

    proc.on('error', err => {
      process.stderr.write(`[CrewCode] crewcoder acp error: ${err.message}\n`)
      finish([])
    })
    proc.on('close', () => finish([]))
    const timer = setTimeout(() => finish([]), 12_000)

    // Keep draining stderr even though CrewCoder reserves stdout for ACP. This
    // prevents a future diagnostic burst from backpressuring model discovery.
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.resume()

    let buffer = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        let message: { id?: number; result?: { models?: { availableModels?: Array<{ modelId?: string; name?: string }> } } }
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 1 && message.result) {
          proc.stdin?.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'session/new',
            params: { cwd: os.homedir(), mcpServers: [] },
          })}\n`)
        } else if (message.id === 2 && message.result) {
          const models: DetectedModel[] = []
          for (const entry of message.result.models?.availableModels ?? []) {
            const id = entry.modelId?.trim()
            if (!id) continue
            const separator = id.indexOf(':')
            models.push({
              id,
              label: entry.name?.trim() || id,
              provider: separator > 0 ? id.slice(0, separator) : 'crewcoder',
            })
          }
          finish(models)
        }
      }
    })

    proc.stdin?.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
    })}\n`)
  })
}

// Grok Build reports its catalog on the ACP `initialize` response itself
// (_meta.modelState), so discovery needs no session — one handshake, no cwd,
// and no session file written to ~/.grok/sessions just to list models.
function detectGrokModels(grokPath: string | null): Promise<DetectedModel[]> {
  if (!grokPath) return Promise.resolve([])
  return new Promise<DetectedModel[]>((resolve) => {
    let settled = false
    let proc: ReturnType<typeof spawn>
    const finish = (models: DetectedModel[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { proc.kill() } catch { /* already closed */ }
      resolve(models)
    }

    try {
      // Discovery must not inherit the user's global permission mode either;
      // dontAsk is the safest possible mode for a handshake-only process.
      const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(grokPath, ['--permission-mode', 'dontAsk', 'agent', 'stdio'])
      proc = spawn(spawnCmd, spawnArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: modelDetectEnv(grokPath),
      })
    } catch (err) {
      process.stderr.write(`[CrewCode] grok agent stdio spawn failed: ${(err as Error).message}\n`)
      resolve([])
      return
    }

    proc.on('error', err => {
      process.stderr.write(`[CrewCode] grok agent stdio error: ${err.message}\n`)
      finish([])
    })
    proc.on('close', () => finish([]))
    const timer = setTimeout(() => finish([]), 12_000)

    proc.stderr?.setEncoding('utf8')
    proc.stderr?.resume()

    let buffer = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        let message: {
          id?: number
          result?: { _meta?: { modelState?: { availableModels?: Array<{ modelId?: string; name?: string }> } } }
        }
        try { message = JSON.parse(line) } catch { continue }
        if (message.id !== 1 || !message.result) continue
        const models: DetectedModel[] = []
        for (const entry of message.result._meta?.modelState?.availableModels ?? []) {
          const id = entry.modelId?.trim()
          if (!id) continue
          models.push({ id, label: entry.name?.trim() || id, provider: 'grok' })
        }
        finish(models)
      }
    })

    proc.stdin?.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      },
    })}\n`)
  })
}

// Ollama lists its locally-pulled models over HTTP, not the CLI — query the
// running server's /api/tags (default 127.0.0.1:11434, OLLAMA_HOST override).
async function detectOllama(): Promise<DetectedModel[]> {
  const raw  = process.env.OLLAMA_HOST || '127.0.0.1:11434'
  const base = /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : `http://${raw.replace(/\/+$/, '')}`
  try {
    const r = await net.fetch(`${base}/api/tags`)
    if (!r.ok) return []
    const json = await r.json() as { models?: Array<{ name?: string; model?: string }> }
    const out: DetectedModel[] = []
    for (const m of json.models ?? []) {
      const id = (m.name ?? m.model ?? '').trim()
      if (id) out.push({ id, label: id, provider: 'ollama' })
    }
    return out
  } catch {
    // Server not running / unreachable — picker falls back to the catalog.
    return []
  }
}


// OpenRouter publishes its full model catalog over HTTP (no key required).
async function detectOpenrouter(): Promise<DetectedModel[]> {
  try {
    const r = await net.fetch('https://openrouter.ai/api/v1/models')
    if (!r.ok) return []
    const json = await r.json() as { data?: Array<{ id?: string; name?: string; context_length?: number; top_provider?: { context_length?: number } }> }
    const out: DetectedModel[] = []
    for (const m of json.data ?? []) {
      const id = (m.id ?? '').trim()
      if (!id) continue
      const contextWindow = m.context_length ?? m.top_provider?.context_length
      // ids look like "openai/gpt-4o" — use the vendor prefix as the provider
      // so the picker shows the right vendor logo.
      const provider = id.includes('/') ? id.slice(0, id.indexOf('/')) : 'openrouter'
      out.push({ id, label: m.name?.trim() || id, provider, contextWindow })
    }
    return out
  } catch (err) {
    process.stderr.write(`[CrewCode] openrouter model catalog failed: ${(err as Error).message}\n`)
    return []
  }
}

export async function listModels(provider: string, cliPath: string | null): Promise<DetectedModel[]> {
  const cached = cache[provider]
  // Pi's list is filtered by ~/.pi/agent/settings.json enabledModels. Users can
  // edit that outside CrewCode, so don't reuse a process-local cache here.
  if (provider !== 'pi' && cached && Date.now() - cached.ts < TTL_MS) {
    registerDetectedModelContextWindows(cached.models)
    return cached.models
  }

  let models: DetectedModel[] = []
  if (provider === 'hermes')          models = await detectHermes(cliPath)
  else if (provider === 'crewcoder')  models = await detectCrewCoderModels(cliPath)
  else if (provider === 'grok')       models = await detectGrokModels(cliPath)
  else if (provider === 'ollama')     models = await detectOllama()
  else if (provider === 'openrouter') models = await detectOpenrouter()
  else if (!cliPath)                  models = []
  else if (provider === 'pi')       models = detectPi(cliPath)
  else if (provider === 'opencode') models = detectOpencode(cliPath)
  else if (provider === 'codex')    models = await detectCodex(cliPath)
  else if (provider === 'claude')   models = detectClaude(cliPath)

  registerDetectedModelContextWindows(models)

  // Do not pin transient startup/network failures; packaged apps may ask before
  // networking is ready, and the composer should retry instead of staying on the fallback list.
  if (provider !== 'pi' && models.length > 0) cache[provider] = { ts: Date.now(), models }
  return models
}

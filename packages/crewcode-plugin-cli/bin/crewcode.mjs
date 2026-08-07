#!/usr/bin/env node
import { createHash } from 'crypto'
import { fileURLToPath, pathToFileURL } from 'url'
import { createReadStream, createWriteStream } from 'fs'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir, homedir } from 'os'
import { dirname, join, relative, resolve, sep } from 'path'
import { spawnSync } from 'child_process'
import { createGzip } from 'zlib'

const API_VERSION = '0.1'
const MANIFEST = 'crewcode.plugin.json'
const TEMPLATE_ALIASES = new Map([
  ['static', 'static-panel-template'],
  ['static-panel', 'static-panel-template'],
  ['panel', 'static-panel-template'],
  ['typescript', 'typescript-panel-template'],
  ['typescript-panel', 'typescript-panel-template'],
  ['react', 'typescript-panel-template'],
  ['ts-react', 'typescript-panel-template'],
  ['mock-agent', 'mock-agent-provider'],
  ['http-agent', 'company-agent-http-adapter'],
  ['openai-agent', 'openai-compatible-provider'],
  ['exec-agent', 'github-copilot-cli-provider'],
  ['mcp', 'mcp-server-template'],
  ['browser-action', 'browser-docs-grabber'],
  ['git-lens', 'git-risk-lens'],
  ['graph', 'codebase-graph-lite'],
  ['handoff', 'handoff-pack'],
  ['mission', 'mission-ci-widget'],
  ['mission-widget', 'mission-ci-widget'],
  ['radar', 'repo-radar'],
  ['watchdog', 'terminal-watchdog-lite'],
  ['terminal-watcher', 'terminal-watchdog-lite'],
])
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', '.turbo', 'dist'])
const SKIP_FILES = new Set(['.DS_Store'])
const VALID_PERMISSIONS = new Set([
  'workspace:read', 'workspace:write', 'git:read', 'git:write', 'terminal:spawn', 'terminal:read',
  'agent:prompt', 'agent:provider', 'browser:read', 'mcp:server', 'network:fetch', 'secrets:read',
])
const CONTRIBUTION_KEYS = [
  'commands', 'tabs', 'sidebarPanels', 'statusItems', 'editorActions', 'chatActions', 'chatHeaderItems',
  'mcpServers', 'agentProviders', 'gitLenses', 'missionWidgets', 'terminalWatchers', 'browserActions',
]

function packageRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

// Derived from disk, not hardcoded: the old static list had drifted and hid 5
// of the 14 shipped templates.
function listTemplates() {
  const root = join(packageRoot(), 'templates', 'plugins')
  if (!existsSync(root)) return []
  const aliasesFor = new Map()
  for (const [alias, target] of TEMPLATE_ALIASES) {
    if (!aliasesFor.has(target)) aliasesFor.set(target, [])
    aliasesFor.get(target).push(alias)
  }
  const out = []
  for (const name of readdirSync(root).sort()) {
    const manifestPath = join(root, name, MANIFEST)
    if (!existsSync(manifestPath)) continue
    let description = ''
    try { description = String(readJson(manifestPath).description || '') } catch { /* unreadable */ }
    out.push({ name, aliases: aliasesFor.get(name) || [], description })
  }
  return out
}

function formatTemplates() {
  return listTemplates().map(t => {
    const alias = t.aliases.length ? `  (${t.aliases.join(', ')})` : ''
    const desc = t.description ? `\n      ${t.description}` : ''
    return `  ${t.name}${alias}${desc}`
  }).join('\n')
}

function usage() {
  return `crewcode plugin <command> [options]

Commands:
  create <id> [--template static-panel] [--out <dir>] [--name <name>] [--force]
  dev [pluginDir] [--copy] [--watch] [--build]
  package [pluginDir] [--out <dir>] [--no-build]
  list

Templates:
${formatTemplates()}
`
}

export function listCommand() {
  const templates = listTemplates()
  console.log(`${templates.length} templates available:\n`)
  console.log(formatTemplates())
  return { ok: true, templates: templates.map(t => t.name) }
}

function parseArgs(argv) {
  const args = []
  const flags = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (!item.startsWith('--')) { args.push(item); continue }
    const raw = item.slice(2)
    if (raw.startsWith('no-')) { flags.set(raw.slice(3), false); continue }
    const eq = raw.indexOf('=')
    if (eq !== -1) { flags.set(raw.slice(0, eq), raw.slice(eq + 1)); continue }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { flags.set(raw, next); i += 1 }
    else flags.set(raw, true)
  }
  return { args, flags }
}

function pluginHome() {
  return process.env.CREWCODE_PLUGINS_DIR || join(homedir(), '.crewcode', 'plugins')
}

function titleFromId(id) {
  return id.split(/[-_.]+/).filter(Boolean).map(part => part[0]?.toUpperCase() + part.slice(1)).join(' ')
}

function validatePluginId(id) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error(`invalid plugin id "${id}"`)
}

function templateDir(name) {
  const resolvedName = TEMPLATE_ALIASES.get(name) || name
  const dir = join(packageRoot(), 'templates', 'plugins', resolvedName)
  if (!existsSync(join(dir, MANIFEST))) throw new Error(`unknown template "${name}"`)
  return dir
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function safeInside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.includes(`..${sep}`))
}

function validateManifest(pluginDir) {
  const manifestPath = join(pluginDir, MANIFEST)
  if (!existsSync(manifestPath)) throw new Error(`missing ${MANIFEST}`)
  const manifest = readJson(manifestPath)
  validatePluginId(String(manifest.id || ''))
  if (!manifest.name || typeof manifest.name !== 'string') throw new Error('manifest.name must be a non-empty string')
  if (!manifest.version || typeof manifest.version !== 'string') throw new Error('manifest.version must be a non-empty string')
  const apiVersion = manifest.crewcode?.apiVersion || API_VERSION
  if (apiVersion !== API_VERSION) throw new Error(`unsupported crewcode.apiVersion "${apiVersion}"; supported: ${API_VERSION}`)
  for (const permission of manifest.permissions || []) {
    if (!VALID_PERMISSIONS.has(permission)) throw new Error(`unknown permission "${permission}"`)
  }
  const contributes = manifest.contributes || {}
  for (const key of Object.keys(contributes)) {
    if (!CONTRIBUTION_KEYS.includes(key)) throw new Error(`unknown contributes.${key}`)
  }
  for (const key of ['tabs', 'sidebarPanels']) {
    for (const panel of contributes[key] || []) {
      if (!panel.entry || typeof panel.entry !== 'string') throw new Error(`contributes.${key} entry required`)
      if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|[\\/])/.test(panel.entry)) throw new Error(`contributes.${key} entry must be relative`)
      const entryPath = resolve(pluginDir, panel.entry)
      if (!safeInside(pluginDir, entryPath)) throw new Error(`contributes.${key} entry escapes plugin folder`)
      if (!existsSync(entryPath)) throw new Error(`panel entry missing: ${panel.entry}`)
    }
  }
  return manifest
}

function copyTemplate(src, dest, force) {
  if (existsSync(dest)) {
    if (!force) throw new Error(`destination exists: ${dest}`)
    rmSync(dest, { recursive: true, force: true })
  }
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true, filter: source => !source.includes(`${sep}node_modules${sep}`) })
}

function rewriteCreatedProject(dest, id, name) {
  const manifestPath = join(dest, MANIFEST)
  const manifest = readJson(manifestPath)
  manifest.$schema = 'https://crewcode-plugins.cortex-ai.icu/schemas/crewcode.plugin.schema.json'
  manifest.id = id
  manifest.name = name
  if (manifest.contributes?.tabs) {
    for (const tab of manifest.contributes.tabs) if (typeof tab.title === 'string') tab.title = name
  }
  if (manifest.contributes?.sidebarPanels) {
    for (const panel of manifest.contributes.sidebarPanels) if (typeof panel.title === 'string') panel.title = name
  }
  writeJson(manifestPath, manifest)

  const packagePath = join(dest, 'package.json')
  if (existsSync(packagePath)) {
    const pkg = readJson(packagePath)
    pkg.name = id
    writeJson(packagePath, pkg)
  }
}

export function createPlugin(argv) {
  const { args, flags } = parseArgs(argv)
  const id = args[0]
  if (!id) throw new Error('plugin id required')
  validatePluginId(id)
  const name = String(flags.get('name') || titleFromId(id))
  const template = String(flags.get('template') || 'static-panel')
  const outRoot = resolve(String(flags.get('out') || process.cwd()))
  const dest = resolve(outRoot, id)
  copyTemplate(templateDir(template), dest, flags.get('force') === true)
  rewriteCreatedProject(dest, id, name)
  validateManifest(dest)
  return { ok: true, path: dest, id, name, template }
}

function installPlugin(pluginDir, copyMode) {
  const manifest = validateManifest(pluginDir)
  const root = pluginHome()
  const dest = join(root, manifest.id)
  mkdirSync(root, { recursive: true })
  rmSync(dest, { recursive: true, force: true })
  if (copyMode) {
    cpSync(pluginDir, dest, { recursive: true, filter: source => !source.includes(`${sep}node_modules${sep}`) })
    return { manifest, dest, mode: 'copy' }
  }
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(resolve(pluginDir), dest, type)
  return { manifest, dest, mode: 'link' }
}

function runPackageScript(pluginDir, script, inherit = true) {
  if (!existsSync(join(pluginDir, 'package.json'))) return { ran: false, status: 0 }
  const pkg = readJson(join(pluginDir, 'package.json'))
  if (!pkg.scripts?.[script]) return { ran: false, status: 0 }
  const result = spawnSync('npm', ['run', script], { cwd: pluginDir, stdio: inherit ? 'inherit' : 'pipe', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`npm run ${script} failed`)
  return { ran: true, status: result.status }
}

export function devPlugin(argv) {
  const { args, flags } = parseArgs(argv)
  const pluginDir = resolve(args[0] || process.cwd())
  if (flags.get('build') === true) runPackageScript(pluginDir, 'build')
  const installed = installPlugin(pluginDir, flags.get('copy') === true)
  if (flags.get('watch') === true) {
    runPackageScript(pluginDir, 'dev')
  }
  return { ok: true, pluginId: installed.manifest.id, path: installed.dest, mode: installed.mode }
}

function collectPackageFiles(root) {
  const files = []
  function walk(dir) {
    for (const name of readdirSync(dir)) {
      if (SKIP_FILES.has(name)) continue
      const abs = join(dir, name)
      const rel = relative(root, abs).replace(/\\/g, '/')
      const st = lstatSync(abs)
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue
        walk(abs)
      } else if (st.isFile()) {
        files.push({ abs, rel, mode: st.mode & 0o777, size: st.size })
      }
    }
  }
  walk(root)
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  return files
}

function tarHeader(name, size, mode, mtime = 0) {
  const buf = Buffer.alloc(512, 0)
  const write = (text, offset, length) => buf.write(String(text).slice(0, length), offset, length, 'utf8')
  write(name, 0, 100)
  write(mode.toString(8).padStart(7, '0') + '\0', 100, 8)
  write('0000000\0', 108, 8)
  write('0000000\0', 116, 8)
  write(size.toString(8).padStart(11, '0') + '\0', 124, 12)
  write(Math.floor(mtime).toString(8).padStart(11, '0') + '\0', 136, 12)
  buf.fill(0x20, 148, 156)
  write('0', 156, 1)
  write('ustar\0', 257, 6)
  write('00', 263, 2)
  let sum = 0
  for (const byte of buf) sum += byte
  write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return buf
}

function writeTarGz(root, files, outFile) {
  const tempTar = join(mkdtempSync(join(tmpdir(), 'crewcode-plugin-package-')), 'plugin.tar')
  const out = createWriteStream(tempTar)
  for (const file of files) {
    out.write(tarHeader(`package/${file.rel}`, file.size, file.mode))
    out.write(readFileSync(file.abs))
    const pad = (512 - (file.size % 512)) % 512
    if (pad) out.write(Buffer.alloc(pad, 0))
  }
  out.write(Buffer.alloc(1024, 0))
  out.end()
  return new Promise((resolvePromise, rejectPromise) => {
    out.on('error', rejectPromise)
    out.on('finish', () => {
      const gz = createGzip({ mtime: 0 })
      const input = createReadStream(tempTar)
      const output = createWriteStream(outFile)
      input.pipe(gz).pipe(output)
      output.on('finish', () => {
        rmSync(dirname(tempTar), { recursive: true, force: true })
        resolvePromise()
      })
      output.on('error', rejectPromise)
    })
  })
}

export async function packagePlugin(argv) {
  const { args, flags } = parseArgs(argv)
  const pluginDir = resolve(args[0] || process.cwd())
  if (flags.get('build') !== false) runPackageScript(pluginDir, 'build')
  const manifest = validateManifest(pluginDir)
  const files = collectPackageFiles(pluginDir)
  const outRoot = resolve(String(flags.get('out') || join(pluginDir, 'dist')))
  mkdirSync(outRoot, { recursive: true })
  const base = `${manifest.id}-${manifest.version}.crewcode-plugin.tgz`
  const outFile = join(outRoot, base)
  await writeTarGz(pluginDir, files, outFile)
  const sha256 = createHash('sha256').update(readFileSync(outFile)).digest('hex')
  writeJson(join(outRoot, `${base}.json`), { id: manifest.id, version: manifest.version, file: base, sha256, files: files.map(f => f.rel) })
  return { ok: true, path: outFile, sha256, files: files.length }
}

export async function main(argv = process.argv.slice(2)) {
  const [group, command, ...rest] = argv
  if (group !== 'plugin' || !command || command === '--help' || command === '-h') {
    console.log(usage())
    return { ok: true }
  }
  if (command === 'create') return createPlugin(rest)
  if (command === 'dev') return devPlugin(rest)
  if (command === 'package') return packagePlugin(rest)
  if (command === 'list') return listCommand()
  throw new Error(`unknown command: crewcode plugin ${command}`)
}

// npm symlinks `bin` entries, so process.argv[1] is the symlink path while
// import.meta.url is the real one — string-comparing `file://` + argv[1] never
// matched and main() silently never ran for globally installed users. realpath
// resolves the symlink; pathToFileURL gets Windows' file:///C:/ form right.
function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}

if (isDirectRun()) {
  main().then(result => {
    if (result?.path) console.log(result.path)
  }).catch(err => {
    console.error(err.message)
    process.exit(1)
  })
}

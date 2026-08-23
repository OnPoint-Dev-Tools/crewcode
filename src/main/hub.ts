import { homedir } from 'os'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { startHubServer } from './hub-server'

export interface HubCliOptions {
  host: string
  port: number
  dataDir: string
  publicOrigin?: string
}

function usage(): string {
  return `CrewCode self-hosted Hub

Usage:
  crewcode hub [options]

Options:
  --host <address>       Bind address (default: 127.0.0.1)
  --port <number>        TCP port, 0 chooses an available port (default: 3774)
  --data-dir <path>      Hub state directory (default: ~/.crewcode/hub)
  --public-origin <url>  Final HTTPS browser origin (required for network binds)
  --help                 Show this help

Examples:
  crewcode hub
  crewcode hub --host 0.0.0.0 --public-origin https://crewcode.example

The public origin is cryptographically bound to passkeys. Choose the final LAN,
Tailscale, or user-controlled HTTPS name before creating the owner passkey.`
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

export function normalizeHubOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`invalid public origin: ${value}`) }
  const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`invalid public origin: ${value}; use HTTPS or loopback HTTP with no path`)
  }
  return url.origin
}

export function parseHubOptions(argv: string[], cwd = process.cwd()): HubCliOptions | { help: true } {
  const args = argv[0] === 'hub' ? argv.slice(1) : argv
  if (args.includes('--help') || args.includes('-h')) return { help: true }
  let host = '127.0.0.1'
  let port = 3774
  let dataDir = join(homedir(), '.crewcode', 'hub')
  let publicOrigin: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--host') host = valueAfter(args, index++, arg)
    else if (arg === '--port') {
      const raw = valueAfter(args, index++, arg)
      port = Number(raw)
      if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`invalid port: ${raw}`)
    } else if (arg === '--data-dir') dataDir = resolve(cwd, valueAfter(args, index++, arg))
    else if (arg === '--public-origin') publicOrigin = normalizeHubOrigin(valueAfter(args, index++, arg))
    else throw new Error(`unknown option: ${arg}`)
  }
  if ((host === '0.0.0.0' || host === '::') && !publicOrigin) throw new Error('--public-origin is required for network Hub binds')
  return { host, port, dataDir, publicOrigin }
}

export function terminalLink(label: string, url: string, isTerminal = Boolean(process.stdout.isTTY)): string {
  return isTerminal ? `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007` : url
}

function defaultWebRoot(): string | undefined {
  const candidates = [resolve(__dirname, '../renderer'), resolve(__dirname, '../../out/renderer')]
  return candidates.find(candidate => existsSync(join(candidate, 'index.html')))
}

export async function runHub(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseHubOptions(argv)
  if ('help' in parsed) { console.log(usage()); return }
  const hub = await startHubServer({ ...parsed, webRoot: defaultWebRoot() })
  console.log(`CrewCode Hub listening on ${hub.url}`)
  console.log(`Hub browser origin: ${hub.publicOrigin}`)
  if (hub.bootstrapUrl) {
    console.log(`Create the first owner passkey (single use, expires in 10 minutes):\n${terminalLink('Open owner passkey setup', hub.bootstrapUrl)}`)
    if (process.stdout.isTTY) console.log(`If the link is not clickable, copy this URL:\n${hub.bootstrapUrl}`)
  }
  else console.log('Hub owner is configured. Sign in with a registered passkey.')
  if (parsed.host === '0.0.0.0' || parsed.host === '::') console.warn('Network access is enabled. Terminate TLS at the configured public origin.')
  const shutdown = (): void => { void hub.close().finally(() => process.exit(0)) }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (require.main === module) {
  void runHub().catch(error => {
    console.error((error as Error).message)
    process.exitCode = 1
  })
}

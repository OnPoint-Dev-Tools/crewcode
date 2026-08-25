import { homedir } from 'os'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { startHubServer } from './hub-server'
import { configureTailscaleServe } from './hub-mobile-access'
import QRCode from 'qrcode'

export interface HubCliOptions {
  host: string
  port: number
  dataDir: string
  publicOrigin?: string
  mobile: boolean
  tailscale: boolean
  tailscaleReplace: boolean
}

function usage(): string {
  return `CrewCode self-hosted Hub

Usage:
  crewcode hub [options]
  crewcode hub mobile [--tailscale] [options]

Options:
  --host <address>       Bind address (default: 127.0.0.1)
  --port <number>        TCP port, 0 chooses an available port (default: 3774)
  --data-dir <path>      Hub state directory (default: ~/.crewcode/hub)
  --public-origin <url>  Final HTTPS browser origin (generic reverse proxy/domain)
  --tailscale            Configure Tailscale Serve HTTPS for the fixed Hub port
  --tailscale-replace    Explicitly replace an existing Tailscale Serve config
  --help                 Show this help

Examples:
  crewcode hub
  crewcode hub mobile --tailscale
  crewcode hub mobile --public-origin https://crewcode.example

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
  const rawArgs = argv[0] === 'hub' ? argv.slice(1) : argv
  const mobile = rawArgs[0] === 'mobile'
  const args = mobile ? rawArgs.slice(1) : rawArgs
  if (args.includes('--help') || args.includes('-h')) return { help: true }
  let host = '127.0.0.1'
  let port = 3774
  let dataDir = join(homedir(), '.crewcode', 'hub')
  let publicOrigin: string | undefined
  let tailscale = false
  let tailscaleReplace = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--host') host = valueAfter(args, index++, arg)
    else if (arg === '--port') {
      const raw = valueAfter(args, index++, arg)
      port = Number(raw)
      if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`invalid port: ${raw}`)
    } else if (arg === '--data-dir') dataDir = resolve(cwd, valueAfter(args, index++, arg))
    else if (arg === '--public-origin') publicOrigin = normalizeHubOrigin(valueAfter(args, index++, arg))
    else if (arg === '--tailscale') tailscale = true
    else if (arg === '--tailscale-replace') { tailscale = true; tailscaleReplace = true }
    else throw new Error(`unknown option: ${arg}`)
  }
  if (tailscale && publicOrigin) throw new Error('choose either --tailscale or --public-origin, not both')
  if (mobile && !tailscale && !publicOrigin) tailscale = true
  if ((host === '0.0.0.0' || host === '::') && !publicOrigin) throw new Error('--public-origin is required for network Hub binds')
  return { host, port, dataDir, publicOrigin, mobile, tailscale, tailscaleReplace }
}

export function terminalLink(label: string, url: string, isTerminal = Boolean(process.stdout.isTTY)): string {
  return isTerminal ? `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007` : url
}

export function mobileQrTarget(publicOrigin: string, bootstrapUrl?: string): { url: string; containsCredential: boolean } {
  return bootstrapUrl
    ? { url: bootstrapUrl, containsCredential: true }
    : { url: publicOrigin, containsCredential: false }
}

function defaultWebRoot(): string | undefined {
  const candidates = [resolve(__dirname, '../renderer'), resolve(__dirname, '../../out/renderer')]
  return candidates.find(candidate => existsSync(join(candidate, 'index.html')))
}

export async function runHub(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseHubOptions(argv)
  if ('help' in parsed) { console.log(usage()); return }
  if (parsed.tailscale) parsed.publicOrigin = configureTailscaleServe(parsed.port, { replace: parsed.tailscaleReplace }).publicOrigin
  const hub = await startHubServer({ ...parsed, webRoot: defaultWebRoot() })
  console.log(`CrewCode Hub listening on ${hub.url}`)
  console.log(`Hub browser origin: ${hub.publicOrigin}`)
  if (hub.bootstrapUrl) {
    console.log(`Create the first owner passkey (single use, expires in 10 minutes):\n${terminalLink('Open owner passkey setup', hub.bootstrapUrl)}`)
    if (parsed.mobile || parsed.publicOrigin?.startsWith('https://')) {
      // Initial owner registration necessarily carries the short-lived bootstrap
      // secret. Label it distinctly; after setup, every normal mobile QR returns
      // to containing only the stable, credential-free Hub origin.
      const qr = mobileQrTarget(hub.publicOrigin, hub.bootstrapUrl)
      console.log(`Scan once to create the Hub owner (contains a one-time 10-minute setup credential):\n${await QRCode.toString(qr.url, { type: 'terminal', small: true })}${qr.url}`)
    } else if (process.stdout.isTTY) console.log(`If the link is not clickable, copy this URL:\n${hub.bootstrapUrl}`)
  } else {
    console.log('Hub owner is configured. Sign in with a registered passkey.')
    if (parsed.mobile || parsed.publicOrigin?.startsWith('https://')) {
      const qr = mobileQrTarget(hub.publicOrigin)
      console.log(`Scan to open CrewCode on your phone (URL only; no credential is embedded):\n${await QRCode.toString(qr.url, { type: 'terminal', small: true })}${qr.url}`)
    }
  }
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

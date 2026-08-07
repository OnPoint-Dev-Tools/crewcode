import { homedir } from 'os'
import { join, resolve } from 'path'
import { existsSync } from 'fs'
import { startRemoteAccessServer } from './remote-access-server'
import { resolveHeadlessAgentPath } from './headless-agent-resolver'

interface ServeOptions {
  host: string
  port: number
  dataDir: string
  webRoot?: string
  allowedWorkspaceRoots?: string[]
}

function usage(): string {
  return `CrewCode remote server

Usage:
  crewcode [serve] [options]

Options:
  --host <address>   Bind address (default: 127.0.0.1)
  --port <number>    TCP port, 0 chooses an available port (default: 3773)
  --data-dir <path>  Server state directory (default: ~/.crewcode)
  --web-root <path>  Built renderer directory
  --workspace-root <path>  Allow browser projects under this host directory (repeatable; default: home)
  --help             Show this help

Examples:
  crewcode
  crewcode serve --port 3773
  crewcode serve --host 0.0.0.0

Binding to 0.0.0.0 exposes privileged development operations to your network.
Use the printed one-time pairing URL and prefer a trusted LAN or tailnet.`
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

export function parseServeOptions(argv: string[], cwd = process.cwd()): ServeOptions | { help: true } {
  const args = argv[0] === 'serve' ? argv.slice(1) : argv
  if (args.includes('--help') || args.includes('-h')) return { help: true }
  let host = '127.0.0.1'
  let port = 3773
  let dataDir = join(homedir(), '.crewcode')
  let webRoot: string | undefined
  const allowedWorkspaceRoots: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--host') host = valueAfter(args, index++, arg)
    else if (arg === '--port') {
      const raw = valueAfter(args, index++, arg)
      port = Number(raw)
      if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`invalid port: ${raw}`)
    } else if (arg === '--data-dir') dataDir = resolve(cwd, valueAfter(args, index++, arg))
    else if (arg === '--web-root') webRoot = resolve(cwd, valueAfter(args, index++, arg))
    else if (arg === '--workspace-root') allowedWorkspaceRoots.push(resolve(cwd, valueAfter(args, index++, arg)))
    else throw new Error(`unknown option: ${arg}`)
  }
  return { host, port, dataDir, webRoot, allowedWorkspaceRoots: allowedWorkspaceRoots.length ? allowedWorkspaceRoots : undefined }
}

function defaultWebRoot(): string | undefined {
  const candidates = [
    resolve(__dirname, '../renderer'),
    resolve(__dirname, '../../out/renderer'),
  ]
  return candidates.find(candidate => existsSync(join(candidate, 'index.html')))
}

export async function runHeadless(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseServeOptions(argv)
  if ('help' in parsed) {
    console.log(usage())
    return
  }
  // Provider session/key stores use the same data root as workspace state in
  // headless mode; set it before the first agent request reaches those modules.
  process.env.CREWCODE_DATA_DIR = parsed.dataDir
  const server = await startRemoteAccessServer({ ...parsed, webRoot: parsed.webRoot ?? defaultWebRoot(), resolveAgentPath: resolveHeadlessAgentPath })
  console.log(`CrewCode server listening on ${server.url}`)
  console.log(`Pair this browser (single use):\n${server.pairingUrl}`)
  if (parsed.host === '0.0.0.0' || parsed.host === '::') {
    console.warn('Network access is enabled. Only share this URL on a trusted network.')
  }
  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (require.main === module) {
  void runHeadless().catch(error => {
    console.error((error as Error).message)
    process.exitCode = 1
  })
}

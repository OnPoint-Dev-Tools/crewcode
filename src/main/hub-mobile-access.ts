import { spawnSync } from 'child_process'

export interface TailscaleStatus {
  BackendState?: string
  MagicDNSSuffix?: string
  Self?: { DNSName?: string; Online?: boolean }
  Health?: string[]
}

export function tailscaleHttpsOrigin(status: TailscaleStatus): string {
  if (status.BackendState !== 'Running' || status.Self?.Online !== true) {
    const health = status.Health?.find(Boolean)
    throw new Error(`Tailscale is not connected${health ? `: ${health}` : '; run `tailscale up` and sign in first'}`)
  }
  const hostname = String(status.Self.DNSName ?? '').replace(/\.$/, '').toLowerCase()
  if (!hostname || !hostname.includes('.') || !/^[a-z0-9.-]+$/.test(hostname)) {
    throw new Error('Tailscale MagicDNS hostname is unavailable; enable MagicDNS and HTTPS certificates in the tailnet')
  }
  return `https://${hostname}`
}

export interface CommandResult { status: number | null; stdout: string; stderr: string; error?: Error }
export type RunCommand = (command: string, args: string[]) => CommandResult

const runCommand: RunCommand = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

function checked(result: CommandResult, action: string): string {
  if (result.error) throw new Error(`${action}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${action}: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`)
  return result.stdout
}

export function configureTailscaleServe(port: number, options: { replace?: boolean; run?: RunCommand } = {}): { publicOrigin: string; changed: boolean } {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Tailscale mobile access requires a fixed Hub port')
    const run = options.run ?? runCommand
    const rawStatus = checked(run('tailscale', ['status', '--json']), 'could not inspect Tailscale status')
    let status: TailscaleStatus
    try { status = JSON.parse(rawStatus) as TailscaleStatus } catch { throw new Error('Tailscale returned invalid status JSON') }
    const publicOrigin = tailscaleHttpsOrigin(status)
  
    const serveStatus = checked(run('tailscale', ['serve', 'status', '--json']), 'could not inspect Tailscale Serve')
    let existing: unknown = null
    try { existing = JSON.parse(serveStatus || '{}') } catch { existing = serveStatus.trim() }
    const configured = typeof existing === 'object' && existing !== null && Object.keys(existing as object).length > 0
    if (configured) {
      const hostname = new URL(publicOrigin).hostname
      const web = (existing as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }).Web
      const proxy = web?.[`${hostname}:443`]?.Handlers?.['/']?.Proxy
      const expected = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
      if (proxy && expected.has(proxy)) return { publicOrigin, changed: false }
      if (!options.replace) {
        throw new Error('Tailscale Serve already has a different configuration. Refusing to overwrite it; inspect `tailscale serve status` or rerun with --tailscale-replace after confirming replacement is safe')
      }
      checked(run('tailscale', ['serve', 'reset']), 'could not reset Tailscale Serve')
    }
    checked(run('tailscale', ['serve', '--bg', '--yes', String(port)]), 'could not configure Tailscale Serve')
    return { publicOrigin, changed: true }
}

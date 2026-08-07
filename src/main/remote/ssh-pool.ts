import { Client } from 'ssh2'
import type { SFTPWrapper, ConnectConfig, ClientChannel } from 'ssh2'
import { readFileSync } from 'fs'
import net from 'net'
import os from 'os'
import { webContents } from 'electron'
import type { RemoteTarget } from './ssh-target'
import { agentSocket, resolveSshHost, defaultIdentityFiles } from '../ssh'
import { makeHostVerifier } from './host-keys'

export type RemoteStatus = 'connecting' | 'connected' | 'error' | 'closed'

interface PoolEntry {
  client:    Client
  sftp:      SFTPWrapper | null
  ready:     Promise<void>
  status:    RemoteStatus
  lastError: string | null
}

const pool = new Map<string, PoolEntry>()

// Connection state is broadcast to every renderer so any surface (workspace
// row, editor banner) can reflect "connecting / connected / error" the way
// VSCode's remote indicator does.
function broadcast(connId: string, status: RemoteStatus, error: string | null): void {
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send('remote:status', { connId, status, error })
  }
}

function buildConnectConfig(target: RemoteTarget): ConnectConfig {
  const cfg = resolveSshHost(target.host)

  // Precedence mirrors OpenSSH: explicit URI parts win, then ssh config, then
  // sensible defaults. The config's HostName lets aliases resolve to real hosts.
  const host = cfg?.hostname || target.host
  const port = target.port ?? (cfg?.port ? parseInt(cfg.port, 10) : undefined) ?? 22
  const user = target.user || cfg?.user || os.userInfo().username

  const connect: ConnectConfig = {
    host,
    port,
    username:          user,
    readyTimeout:      15_000,
    keepaliveInterval: 20_000,
    // Trust-on-first-use host-key pinning: the first key seen for a host is
    // pinned, later connections must match it or the handshake fails. Prevents
    // a network attacker from silently MITM'ing remote workspaces.
    hostVerifier:      makeHostVerifier(`${host}:${port}`, (id) =>
      console.error(`[ssh] host key changed for ${id} — refusing connection (possible MITM or server rekey). Remove it from ~/.crewcode/known-hosts.json to re-trust.`)),
  }

  // Agent auth is the primary path — the SSH Keys modal loads keys into the
  // agent, and it transparently handles passphrase-protected keys.
  const sock = agentSocket()
  if (sock) connect.agent = sock

  // Fall back to identity files only when there's no agent. Encrypted keys
  // without a passphrase will simply fail this method and ssh2 moves on.
  if (!sock) {
    const keyPaths = cfg?.identityFile ? [cfg.identityFile] : defaultIdentityFiles()
    const keys: Buffer[] = []
    for (const p of keyPaths) {
      try { keys.push(readFileSync(p)) } catch { /* unreadable — skip */ }
    }
    if (keys.length === 1) connect.privateKey = keys[0]
    // ssh2 takes a single privateKey; with multiple, the agent path is expected.
    else if (keys.length > 1) connect.privateKey = keys[0]
  }

  return connect
}

function openConnection(target: RemoteTarget): PoolEntry {
  const client = new Client()
  const entry: PoolEntry = { client, sftp: null, status: 'connecting', lastError: null, ready: Promise.resolve() }

  entry.ready = new Promise<void>((resolve, reject) => {
    client.on('ready', () => {
      entry.status = 'connected'
      broadcast(target.connId, 'connected', null)
      resolve()
    })
    client.on('error', (err: Error) => {
      entry.status    = 'error'
      entry.lastError = err.message
      broadcast(target.connId, 'error', err.message)
      reject(err)
    })
    client.on('close', () => {
      // Drop the entry so the next access reconnects from scratch.
      if (pool.get(target.connId) === entry) pool.delete(target.connId)
      if (entry.status !== 'error') broadcast(target.connId, 'closed', null)
    })

    broadcast(target.connId, 'connecting', null)
    try {
      client.connect(buildConnectConfig(target))
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })

  return entry
}

function getEntry(target: RemoteTarget): PoolEntry {
  let entry = pool.get(target.connId)
  if (!entry || entry.status === 'error' || entry.status === 'closed') {
    entry = openConnection(target)
    pool.set(target.connId, entry)
  }
  return entry
}

/** Acquire the shared SFTP session for a target, connecting if necessary. */
export async function getSftp(target: RemoteTarget): Promise<SFTPWrapper> {
  const entry = getEntry(target)
  await entry.ready
  if (entry.sftp) return entry.sftp
  entry.sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    entry.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)))
  })
  return entry.sftp
}

export interface ExecResult { code: number | null; stdout: string; stderr: string }

/** Run a command over the pooled connection (used for git over SSH). */
export async function execRemote(target: RemoteTarget, command: string): Promise<ExecResult> {
  const entry = getEntry(target)
  await entry.ready
  return new Promise<ExecResult>((resolve, reject) => {
    entry.client.exec(command, (err, stream) => {
      if (err) { reject(err); return }
      let stdout = '', stderr = ''
      stream.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
      stream.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
      stream.on('close', (code: number | null) => resolve({ code, stdout, stderr }))
    })
  })
}

/**
 * Open a long-lived exec channel over the pooled connection. Unlike execRemote
 * (which buffers to completion), this hands back the raw duplex channel so a
 * provider bridge can stream a JSON protocol over the remote process's stdio.
 */
export async function execRemoteStream(target: RemoteTarget, command: string): Promise<ClientChannel> {
  const entry = getEntry(target)
  await entry.ready
  return new Promise<ClientChannel>((resolve, reject) => {
    entry.client.exec(command, (err, stream) => {
      if (err) { reject(err); return }
      resolve(stream)
    })
  })
}

export interface ForwardHandle {
  localPort: number
  close(): void
}

/**
 * Open an SSH local port forward: bind a 127.0.0.1 port on this machine and
 * tunnel every connection to 127.0.0.1:<remotePort> on the host over the pooled
 * connection. Used for HTTP-server agents (opencode) that listen on the host.
 */
export async function forwardRemotePort(target: RemoteTarget, remotePort: number): Promise<ForwardHandle> {
  const entry = getEntry(target)
  await entry.ready
  const server = net.createServer((socket) => {
    entry.client.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (err, stream) => {
      if (err) { socket.destroy(); return }
      socket.pipe(stream).pipe(socket)
      socket.on('error', () => { try { stream.end() } catch { /* closing */ } })
      stream.on('error', () => socket.destroy())
    })
  })
  const localPort = await new Promise<number>((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else { server.close(); reject(new Error('failed to bind local forward port')) }
    })
  })
  return { localPort, close: () => { try { server.close() } catch { /* already closed */ } } }
}

/** Probe a target by establishing (or reusing) its connection. */
export async function connectRemote(target: RemoteTarget): Promise<{ ok: boolean; error?: string }> {
  try {
    await getSftp(target)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function disconnectRemote(connId: string): void {
  const entry = pool.get(connId)
  if (!entry) return
  try { entry.client.end() } catch { /* already closing */ }
  pool.delete(connId)
}

export function disconnectAllRemotes(): void {
  for (const [, entry] of pool) {
    try { entry.client.end() } catch { /* ignore */ }
  }
  pool.clear()
}

export function remoteStatusOf(connId: string): RemoteStatus | null {
  return pool.get(connId)?.status ?? null
}

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import os from 'os'

// Trust-on-first-use host-key pinning for the ssh2 connection pool. The first
// time we see a host we record the sha256 of its public key; every later
// connection must present the same key or the handshake is rejected. This is
// the OpenSSH known_hosts model and closes the "accept any key forever" hole
// without adding first-connect friction. Pins live in ~/.crewcode/known-hosts.json
// (0600), keyed by "host:port".

type KnownHosts = Record<string, string> // "host:port" -> sha256 hex of the host key

function storePath(): string {
  const dir = join(os.homedir(), '.crewcode')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, 'known-hosts.json')
}

function read(): KnownHosts {
  const p = storePath()
  if (!existsSync(p)) return {}
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as KnownHosts) : {}
  } catch {
    return {}
  }
}

function write(store: KnownHosts): void {
  const p = storePath()
  writeFileSync(p, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  try { chmodSync(p, 0o600) } catch { /* no-op on Windows */ }
}

/**
 * Build an ssh2 `hostVerifier`. Returns true when the presented key matches the
 * pinned fingerprint (or is the first key seen for this host, which it pins).
 * Returns false — failing the handshake — when a previously pinned host presents
 * a different key, the signal of a possible MITM or an unannounced server rekey.
 */
export function makeHostVerifier(hostId: string, onMismatch?: (hostId: string) => void): (key: Buffer) => boolean {
  return (key: Buffer): boolean => {
    const fingerprint = createHash('sha256').update(key).digest('hex')
    const store = read()
    const pinned = store[hostId]
    if (!pinned) {
      store[hostId] = fingerprint
      write(store)
      return true
    }
    if (pinned === fingerprint) return true
    onMismatch?.(hostId)
    return false
  }
}

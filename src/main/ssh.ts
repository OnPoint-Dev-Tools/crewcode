import { ipcMain, shell } from 'electron'
import { spawn, spawnSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import os from 'os'

export interface SshConfigHost {
  host:        string                     // alias from "Host" directive
  hostname?:   string                     // resolved HostName
  user?:       string
  port?:       string
  identityFile?: string
}

export interface SshKeyFile {
  name:    string   // filename, e.g. id_ed25519
  path:    string   // absolute path
  type:    string   // ed25519 / rsa / ecdsa / unknown
  loaded:  boolean  // currently in ssh-agent?
  fingerprint?: string
  comment?:    string
}

function sshDir(): string {
  return join(os.homedir(), '.ssh')
}

// ─── ssh-agent resolution ─────────────────────────────────────────────────────
// A GUI-launched Electron app often has no SSH_AUTH_SOCK, so ssh-add fails with
// "Could not open a connection to your authentication agent." We locate a live
// agent (or start our own) and export the socket so spawned git inherits it too.

let resolvedSock: string | null = null
let managedPid: number | null = null   // pid of an agent we started, so we can reap it

/** exit 2 = cannot connect; 0 (keys) / 1 (empty) both mean the agent is reachable. */
function socketAlive(sock: string): boolean {
  const r = spawnSync('ssh-add', ['-l'], { encoding: 'utf8', env: { ...process.env, SSH_AUTH_SOCK: sock } })
  return r.status === 0 || r.status === 1
}

function candidateSocks(): string[] {
  const out: string[] = []
  if (process.env.SSH_AUTH_SOCK) out.push(process.env.SSH_AUTH_SOCK)
  const xdg = process.env.XDG_RUNTIME_DIR
  if (xdg) {
    // gnome-keyring, gcr, and the systemd user ssh-agent.service all publish here.
    out.push(join(xdg, 'keyring', 'ssh'), join(xdg, 'gcr', 'ssh'),
             join(xdg, 'ssh-agent.socket'), join(xdg, 'openssh_agent'))
  }
  return out
}

function startManagedAgent(): { sock?: string; error?: string } {
  const r = spawnSync('ssh-agent', ['-s'], { encoding: 'utf8' })
  if (r.status !== 0) return { error: r.stderr?.trim() || 'failed to start ssh-agent' }
  const out  = r.stdout ?? ''
  const sock = out.match(/SSH_AUTH_SOCK=([^;]+)/)
  const pid  = out.match(/SSH_AGENT_PID=(\d+)/)
  if (!sock) return { error: 'could not parse ssh-agent output' }
  if (pid) managedPid = parseInt(pid[1], 10)
  return { sock: sock[1] }
}

/** Reap a CrewCode-started agent on quit so we don't leak orphan processes. */
export function killManagedSshAgent(): void {
  if (managedPid === null) return
  try { process.kill(managedPid) } catch { /* already gone */ }
  managedPid = null
}

/** Resolve a reachable ssh-agent socket, starting a managed one if needed.
 *  Caches the result and mutates process.env so spawned git can sign via the agent. */
function ensureAgent(): { env: NodeJS.ProcessEnv; error?: string } {
  // Windows uses the OpenSSH Authentication Agent service (named pipe) — no sock.
  if (process.platform === 'win32') return { env: process.env }
  if (resolvedSock && existsSync(resolvedSock)) return { env: process.env }

  for (const sock of candidateSocks()) {
    if (existsSync(sock) && socketAlive(sock)) {
      resolvedSock = sock
      process.env.SSH_AUTH_SOCK = sock
      return { env: process.env }
    }
  }
  const started = startManagedAgent()
  if (started.sock) {
    resolvedSock = started.sock
    process.env.SSH_AUTH_SOCK = started.sock
    return { env: process.env }
  }
  return { env: process.env, error: started.error ?? 'no ssh-agent available' }
}

/**
 * Best-effort SSH config parser. Honors Host blocks and the four directives
 * we actually surface in the UI. Wildcards / Match / Include are passed
 * through as-is via the raw host name.
 */
function parseSshConfig(): SshConfigHost[] {
  const cfgPath = join(sshDir(), 'config')
  if (!existsSync(cfgPath)) return []
  let raw: string
  try { raw = readFileSync(cfgPath, 'utf8') } catch { return [] }

  const hosts: SshConfigHost[] = []
  let current: SshConfigHost | null = null

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^(\S+)\s+(.+)$/)
    if (!match) continue
    const key   = match[1].toLowerCase()
    const value = match[2].trim()
    if (key === 'host') {
      if (current) hosts.push(current)
      current = { host: value }
    } else if (current) {
      if      (key === 'hostname')     current.hostname = value
      else if (key === 'user')         current.user = value
      else if (key === 'port')         current.port = value
      else if (key === 'identityfile') current.identityFile = value.replace(/^~/, os.homedir())
    }
  }
  if (current) hosts.push(current)
  // Drop wildcard-only entries from the user-facing list — they exist but
  // don't represent a single host to connect to.
  return hosts.filter(h => !/[*?]/.test(h.host))
}

function detectKeyType(name: string): string {
  if (name.includes('ed25519')) return 'ed25519'
  if (name.includes('rsa'))     return 'rsa'
  if (name.includes('ecdsa'))   return 'ecdsa'
  if (name.includes('dsa'))     return 'dsa'
  return 'unknown'
}

function listPrivateKeys(): SshKeyFile[] {
  const dir = sshDir()
  if (!existsSync(dir)) return []
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }

  // Heuristic: anything that has a corresponding .pub sibling and isn't
  // itself .pub is a private key. Also include the conventional names.
  const out: SshKeyFile[] = []
  for (const name of names) {
    if (name.endsWith('.pub')) continue
    if (name === 'config' || name === 'known_hosts' || name === 'authorized_keys') continue
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
    } catch { continue }
    const hasPub = existsSync(full + '.pub')
    const conventional = /^id_(rsa|dsa|ecdsa|ed25519)/.test(name)
    if (!hasPub && !conventional) continue
    out.push({
      name,
      path: full,
      type: detectKeyType(name),
      loaded: false,
    })
  }
  return out
}

function loadedFingerprints(): string[] {
  const { env } = ensureAgent()
  const r = spawnSync('ssh-add', ['-l'], { encoding: 'utf8', env })
  if (r.status !== 0) return []  // no agent / no keys — same exit code, both fine
  return r.stdout.split(/\r?\n/).map(line => {
    const m = line.match(/^\d+\s+(\S+)\s+/)
    return m ? m[1] : ''
  }).filter(Boolean)
}

function publicKeyFingerprint(privatePath: string): string | undefined {
  const pub = privatePath + '.pub'
  if (!existsSync(pub)) return undefined
  const r = spawnSync('ssh-keygen', ['-lf', pub], { encoding: 'utf8' })
  if (r.status !== 0) return undefined
  const m = r.stdout.match(/^\d+\s+(\S+)\s+(.+?)\s+\((\w+)\)/)
  return m ? m[1] : undefined
}

function publicKeyComment(privatePath: string): string | undefined {
  const pub = privatePath + '.pub'
  if (!existsSync(pub)) return undefined
  try {
    const text = readFileSync(pub, 'utf8').trim()
    // public key files are "<type> <base64> <comment>"
    const parts = text.split(/\s+/)
    return parts.length >= 3 ? parts.slice(2).join(' ') : undefined
  } catch {
    return undefined
  }
}

function listKeys(): SshKeyFile[] {
  const keys = listPrivateKeys()
  const loaded = new Set(loadedFingerprints())
  return keys.map(k => {
    const fp = publicKeyFingerprint(k.path)
    return {
      ...k,
      fingerprint: fp,
      comment:     publicKeyComment(k.path),
      loaded:      fp ? loaded.has(fp) : false,
    }
  })
}

/** True when the private key is passphrase-protected. `ssh-keygen -y -P ''`
 *  derives the public key with an empty passphrase and only fails on encrypted keys. */
function keyIsEncrypted(path: string): boolean {
  const r = spawnSync('ssh-keygen', ['-y', '-P', '', '-f', path], { encoding: 'utf8' })
  return r.status !== 0
}

function addKey(path: string, passphrase?: string): Promise<{ ok: boolean; error?: string; needsPassphrase?: boolean }> {
  return new Promise(resolve => {
    const { env: agentEnv, error: agentErr } = ensureAgent()
    if (agentErr) { resolve({ ok: false, error: agentErr }); return }

    // Encrypted key with no passphrase yet: ask the renderer for one instead of
    // letting ssh-add exec the (often missing) system ssh-askpass binary.
    if (!passphrase && keyIsEncrypted(path)) {
      resolve({ ok: false, error: 'key is passphrase-protected', needsPassphrase: true })
      return
    }

    const env: NodeJS.ProcessEnv = { ...agentEnv }
    let askDir: string | null = null
    if (passphrase && process.platform !== 'win32') {
      // ssh-add can't read a passphrase from stdin; it execs SSH_ASKPASS when no
      // tty is present. The helper only echoes an env var, so the secret never
      // touches disk — it lives transiently in the spawned process environment.
      askDir = mkdtempSync(join(os.tmpdir(), 'crewcode-ask-'))
      const askPath = join(askDir, 'askpass.sh')
      writeFileSync(askPath, '#!/bin/sh\nprintf "%s\\n" "$CREWCODE_SSH_PASSPHRASE"\n', { mode: 0o700 })
      env.SSH_ASKPASS         = askPath
      env.SSH_ASKPASS_REQUIRE = 'force'        // OpenSSH 8.4+: use askpass even with a tty
      env.DISPLAY             = env.DISPLAY || ':0'  // older ssh-add gates askpass on DISPLAY
      env.CREWCODE_SSH_PASSPHRASE = passphrase
    } else {
      // No passphrase path: never fall back to the system ssh-askpass (frequently
      // absent), which is what produced the "/usr/lib/ssh/ssh-askpass: No such
      // file" error. Fail fast instead.
      env.SSH_ASKPASS_REQUIRE = 'never'
    }

    const cleanup = (): void => { if (askDir) { try { rmSync(askDir, { recursive: true, force: true }) } catch { /* best effort */ } } }
    const child = spawn('ssh-add', [path], { env })
    let stderr = ''
    child.stderr?.on('data', b => { stderr += b.toString('utf8') })
    child.on('exit', code => {
      cleanup()
      if (code === 0) resolve({ ok: true })
      else {
        const msg = stderr.trim() || `ssh-add exited ${code}`
        // Distinguish "needs a passphrase" so the renderer can prompt for one.
        const needsPass = !passphrase && /passphrase|incorrect|enter passphrase|load key|askpass/i.test(msg)
        resolve({ ok: false, error: msg, ...(needsPass ? { needsPassphrase: true } : {}) })
      }
    })
    child.on('error', err => { cleanup(); resolve({ ok: false, error: err.message }) })
    // Close stdin so ssh-add doesn't sit waiting on a tty that will never come.
    child.stdin?.end()
  })
}

function removeKey(path: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise(resolve => {
    const { env } = ensureAgent()
    const child = spawn('ssh-add', ['-d', path], { env })
    let stderr = ''
    child.stderr?.on('data', b => { stderr += b.toString('utf8') })
    child.on('exit', code => {
      if (code === 0) resolve({ ok: true })
      else            resolve({ ok: false, error: stderr.trim() || `ssh-add -d exited ${code}` })
    })
    child.on('error', err => resolve({ ok: false, error: err.message }))
  })
}

function openConfig(): { ok: boolean; error?: string } {
  const cfg = join(sshDir(), 'config')
  if (!existsSync(cfg)) return { ok: false, error: `${cfg} does not exist` }
  shell.openPath(cfg).then(err => {
    if (err) console.error('[ssh] openPath failed:', err)
  })
  return { ok: true }
}

/**
 * Probes reachability with a no-op remote command. BatchMode=yes prevents
 * password prompts hanging the renderer — auth must work via agent or key.
 * `target` accepts "user@host", "user@host:port", or a config alias.
 */
function testConnection(target: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  return new Promise(resolve => {
    let host = target.trim()
    if (!host) { resolve({ ok: false, error: 'empty host' }); return }
    const args: string[] = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=6',
      '-o', 'StrictHostKeyChecking=accept-new',
    ]
    const portMatch = host.match(/^(.+):(\d+)$/)
    if (portMatch) {
      host = portMatch[1]
      args.push('-p', portMatch[2])
    }
    args.push(host, 'true')

    const t0 = Date.now()
    const { env } = ensureAgent()
    const child = spawn('ssh', args, { env })
    let stderr = ''
    child.stderr?.on('data', b => { stderr += b.toString('utf8') })
    child.on('exit', code => {
      const ms = Date.now() - t0
      if (code === 0) resolve({ ok: true, latencyMs: ms })
      else            resolve({ ok: false, error: stderr.trim().split('\n').pop() || `ssh exited ${code}` })
    })
    child.on('error', err => resolve({ ok: false, error: err.message }))
  })
}

/** Resolve (and export) a usable ssh-agent at startup so spawned git can sign
 *  commits via the agent without the user opening SSH settings first. */
export function resolveSshAgentAtStartup(): void {
  ensureAgent()
}

/** Reachable ssh-agent socket path (unix) for ssh2 agent auth, or undefined.
 *  On Windows, ssh2 talks to the named-pipe agent via the literal 'pageant'
 *  string only for PuTTY; OpenSSH's pipe is exposed through SSH_AUTH_SOCK too. */
export function agentSocket(): string | undefined {
  const { env } = ensureAgent()
  return env.SSH_AUTH_SOCK || undefined
}

/** Resolve a Host alias from ~/.ssh/config to concrete connection parameters.
 *  Returns undefined when the alias isn't present so callers can fall back to
 *  treating the string as a literal hostname. */
export function resolveSshHost(alias: string): SshConfigHost | undefined {
  return parseSshConfig().find(h => h.host === alias)
}

/** Default identity files OpenSSH would try when no IdentityFile is configured. */
export function defaultIdentityFiles(): string[] {
  const dir = sshDir()
  return ['id_ed25519', 'id_ecdsa', 'id_rsa']
    .map(n => join(dir, n))
    .filter(p => existsSync(p))
}

export function registerSshIpc(): void {
  ipcMain.handle('ssh:listConfig',  () => parseSshConfig())
  ipcMain.handle('ssh:listKeys',    () => listKeys())
  ipcMain.handle('ssh:addKey',      (_e, path: string, passphrase?: string) => addKey(path, passphrase))
  ipcMain.handle('ssh:removeKey',   (_e, path: string) => removeKey(path))
  ipcMain.handle('ssh:openConfig',  () => openConfig())
  ipcMain.handle('ssh:test',        (_e, target: string) => testConnection(target))
}

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, timingSafeEqual } from 'crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { hostname, platform } from 'os'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'
import type { BrainAccessScope } from '../shared/hub-relay-types'
import { startBrainRelay } from './hub-brain-relay'

export const HUB_ENROLLMENT_TTL_MS = 10 * 60_000
export const HUB_HEARTBEAT_INTERVAL_MS = 30_000
export const HUB_MACHINE_ONLINE_WINDOW_MS = 90_000

interface PendingEnrollment {
  id: string
  userId: string
  secretDigest: Buffer
  expiresAt: number
}

export interface MachineCredentialFile {
  version: 1
  hubOrigin: string
  machineId: string
  token: string
  publicKey: string
  privateKey: string
  enrolledAt: number
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export class HubEnrollmentIssuer {
  private readonly pending = new Map<string, PendingEnrollment>()

  constructor(private readonly now: () => number = Date.now) {}

  issue(userId: string): { token: string; expiresAt: number } {
    this.prune()
    const id = randomBytes(16).toString('hex')
    const secret = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + HUB_ENROLLMENT_TTL_MS
    this.pending.set(id, { id, userId, secretDigest: digest(secret), expiresAt })
    return { token: `${id}.${secret}`, expiresAt }
  }

  consume(token: string): { userId: string } | null {
    this.prune()
    const separator = token.indexOf('.')
    if (separator < 1) return null
    const id = token.slice(0, separator)
    const secret = token.slice(separator + 1)
    const pending = this.pending.get(id)
    if (!pending) return null
    // A presented enrollment is one-shot even when its secret is wrong. This
    // prevents online guessing against a known enrollment id.
    this.pending.delete(id)
    const supplied = digest(secret)
    if (supplied.length !== pending.secretDigest.length || !timingSafeEqual(supplied, pending.secretDigest)) return null
    if (pending.expiresAt <= this.now()) return null
    return { userId: pending.userId }
  }

  private prune(): void {
    const now = this.now()
    for (const [id, pending] of this.pending) if (pending.expiresAt <= now) this.pending.delete(id)
  }
}

export function normalizeHubUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`invalid Hub URL: ${value}`) }
  const loopbackHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
  if ((!loopbackHttp && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Hub URL must be an HTTPS origin, or loopback HTTP for local testing')
  }
  return url.origin
}

export function defaultBrainDataDir(): string {
  return join(homedir(), '.crewcode', 'brain')
}

export function machineCredentialPath(dataDir: string): string {
  return join(dataDir, 'hub-machine.json')
}

export function writeMachineCredential(path: string, credential: MachineCredentialFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try { chmodSync(dirname(path), 0o700) } catch { /* Windows has no POSIX modes */ }
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(credential, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    linkSync(temporary, path)
    try { chmodSync(path, 0o600) } catch { /* Windows has no POSIX modes */ }
  } finally {
    try { rmSync(temporary, { force: true }) } catch { /* best effort */ }
  }
}

export function readMachineCredential(path: string): MachineCredentialFile {
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    throw new Error(`could not read machine credential ${path}: ${(error as Error).message}`)
  }
  if (!value || typeof value !== 'object') throw new Error(`invalid machine credential ${path}`)
  const item = value as Partial<MachineCredentialFile>
  if (item.version !== 1 || typeof item.hubOrigin !== 'string' || typeof item.machineId !== 'string' || typeof item.token !== 'string' || typeof item.publicKey !== 'string' || typeof item.privateKey !== 'string' || typeof item.enrolledAt !== 'number') {
    throw new Error(`invalid machine credential ${path}`)
  }
  if (!/^[a-f0-9]{32}$/.test(item.machineId) || !Number.isFinite(item.enrolledAt)) throw new Error(`invalid machine credential ${path}`)
  const separator = item.token.indexOf('.')
  const secret = separator > 0 ? item.token.slice(separator + 1) : ''
  if (item.token.slice(0, separator) !== item.machineId || !/^[A-Za-z0-9_-]+$/.test(secret) || Buffer.from(secret, 'base64url').length !== 32) {
    throw new Error(`invalid machine credential ${path}`)
  }
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(item.privateKey, 'base64url'), type: 'pkcs8', format: 'der' })
    const publicKey = createPublicKey({ key: Buffer.from(item.publicKey, 'base64url'), type: 'spki', format: 'der' })
    const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
    const supplied = publicKey.export({ type: 'spki', format: 'der' })
    if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519' || !Buffer.from(derived).equals(Buffer.from(supplied))) throw new Error('machine key mismatch')
  } catch {
    throw new Error(`invalid machine credential ${path}`)
  }
  return { version: 1, hubOrigin: normalizeHubUrl(item.hubOrigin), machineId: item.machineId, token: item.token, publicKey: item.publicKey, privateKey: item.privateKey, enrolledAt: item.enrolledAt }
}

export interface BrainCliOptions {
  dataDir: string
  hubOrigin?: string
  token?: string
  name: string
  allowedWorkspaceRoots: string[]
  allowedScopes: BrainAccessScope[]
}

function valueAfter(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

export function parseBrainOptions(argv: string[], command: 'enroll' | 'brain', cwd = process.cwd()): BrainCliOptions | { help: true } {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true }
  let dataDir = defaultBrainDataDir()
  let hubOrigin: string | undefined
  let token: string | undefined
  let name = hostname()
  const allowedWorkspaceRoots: string[] = []
  const allowedScopes: BrainAccessScope[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--data-dir') dataDir = resolve(cwd, valueAfter(argv, index++, arg))
    else if (arg === '--hub') hubOrigin = normalizeHubUrl(valueAfter(argv, index++, arg))
    else if (arg === '--token') token = valueAfter(argv, index++, arg)
    else if (arg === '--name') name = valueAfter(argv, index++, arg).trim()
    else if (arg === '--workspace-root' && command === 'brain') allowedWorkspaceRoots.push(resolve(cwd, valueAfter(argv, index++, arg)))
    else if (arg === '--allow-scope' && command === 'brain') {
      const scope = valueAfter(argv, index++, arg) as BrainAccessScope
      if (scope !== 'workspace:read' && scope !== 'workspace:write' && scope !== 'terminal' && scope !== 'agent') throw new Error(`invalid Brain scope: ${scope}`)
      if (!allowedScopes.includes(scope)) allowedScopes.push(scope)
    }
    else throw new Error(`unknown option: ${arg}`)
  }
  if (!name || name.length > 80) throw new Error('machine name must contain 1 to 80 characters')
  if (command === 'enroll' && !hubOrigin) throw new Error('enroll requires --hub')
  return { dataDir, hubOrigin, token, name, allowedWorkspaceRoots, allowedScopes }
}

class HubRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function hubRequest(origin: string, path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${origin}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } })
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new HubRequestError(response.status, typeof body.error === 'string' ? body.error : `Hub request failed: ${response.status}`)
  return body
}

export async function enrollMachine(options: BrainCliOptions, now = Date.now): Promise<MachineCredentialFile> {
  if (!options.hubOrigin || !options.token) throw new Error('Hub origin and enrollment token are required')
  const credentialPath = machineCredentialPath(options.dataDir)
  if (existsSync(credentialPath)) throw new Error(`machine credential already exists at ${credentialPath}; revoke the old machine, then remove or move this file before enrolling again`)
  const keyPair = generateKeyPairSync('ed25519')
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
  const result = await hubRequest(options.hubOrigin, '/api/v1/hub/machines/enroll', {
    method: 'POST',
    body: JSON.stringify({ enrollmentToken: options.token, publicKey, name: options.name, platform: platform(), version: process.env.npm_package_version ?? null }),
  })
  if (typeof result.machineId !== 'string' || typeof result.token !== 'string') throw new Error('Hub returned an invalid machine credential')
  const credential: MachineCredentialFile = { version: 1, hubOrigin: options.hubOrigin, machineId: result.machineId, token: result.token, publicKey, privateKey, enrolledAt: now() }
  writeMachineCredential(credentialPath, credential)
  return credential
}

export async function sendHeartbeat(credential: MachineCredentialFile): Promise<void> {
  await hubRequest(credential.hubOrigin, '/api/v1/hub/machines/heartbeat', {
    method: 'POST',
    headers: { authorization: `Bearer ${credential.token}` },
    body: JSON.stringify({ platform: platform(), version: process.env.npm_package_version ?? null }),
  })
}

async function hiddenEnrollmentToken(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('interactive terminal required; use --token only for controlled automation')
  }
  process.stdout.write('Enrollment token: ')
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')
  return await new Promise<string>((resolve, reject) => {
    let value = ''
    const finish = (error?: Error): void => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
      error ? reject(error) : resolve(value.trim())
    }
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') { finish(); return }
        if (character === '\u0003') { finish(new Error('enrollment cancelled')); return }
        if (character === '\u007f' || character === '\b') { value = value.slice(0, -1); continue }
        value += character
      }
    }
    process.stdin.on('data', onData)
  })
}

function brainUsage(command: 'enroll' | 'brain'): string {
  if (command === 'enroll') return `CrewCode machine enrollment\n\nUsage:\n  crewcode enroll --hub <https-origin> [--name <name>] [--data-dir <path>]\n\nThe enrollment token is requested without echo in an interactive terminal. It is\nsingle-use and expires after ten minutes. --token is available only for controlled\nautomation because command-line arguments may be exposed in process lists/history.`
  return `CrewCode outbound Brain relay\n\nUsage:\n  crewcode brain [--data-dir <path>] [--workspace-root <path>] [--allow-scope <scope>]\n\nScopes (repeatable): workspace:read, workspace:write, terminal, agent.\nThe Brain grants no remote RPC scope by default. Workspace roots and scopes are\nBrain-local authorization; signing in to the Hub cannot widen them.`
}

export async function runBrainCommand(command: 'enroll' | 'brain', argv: string[]): Promise<void> {
  const parsed = parseBrainOptions(argv, command)
  if ('help' in parsed) { console.log(brainUsage(command)); return }
  if (command === 'enroll') {
    parsed.token ||= await hiddenEnrollmentToken()
    if (!parsed.token) throw new Error('enrollment token is required')
    const credential = await enrollMachine(parsed)
    console.log(`Enrolled machine ${credential.machineId} with ${credential.hubOrigin}.`)
    console.log(`Credential stored at ${machineCredentialPath(parsed.dataDir)}.`)
    console.log('Run `crewcode brain` with explicit workspace roots and scopes to enable the outbound relay.')
    return
  }

  if (parsed.allowedScopes.length > 0 && parsed.allowedWorkspaceRoots.length === 0) {
    throw new Error('remote scopes require at least one explicit --workspace-root')
  }
  const credential = readMachineCredential(machineCredentialPath(parsed.dataDir))
  let stopped = false
  let activeRelay: Awaited<ReturnType<typeof startBrainRelay>> | null = null
  let wake: (() => void) | undefined
  const shutdown = (): void => {
    stopped = true
    wake?.()
    void activeRelay?.close()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  console.log(`CrewCode Brain connecting outbound to ${credential.hubOrigin}.`)
  console.log(parsed.allowedScopes.length
    ? `Brain-local grants: ${parsed.allowedScopes.join(', ')} under ${parsed.allowedWorkspaceRoots.join(', ')}.`
    : 'Brain-local grants: none. Hub users can connect, but all privileged RPC is denied.')

  while (!stopped) {
    try {
      await sendHeartbeat(credential)
      activeRelay = await startBrainRelay({
        credential,
        dataDir: parsed.dataDir,
        allowedWorkspaceRoots: parsed.allowedWorkspaceRoots,
        allowedScopes: parsed.allowedScopes,
      })
      console.log('Authenticated outbound relay connected.')
      const heartbeat = setInterval(() => {
        void sendHeartbeat(credential).catch(error => {
          console.error(`Heartbeat failed: ${(error as Error).message}`)
          if (error instanceof HubRequestError && error.status === 401) void activeRelay?.close()
        })
      }, HUB_HEARTBEAT_INTERVAL_MS)
      await activeRelay.closed
      clearInterval(heartbeat)
      activeRelay = null
    } catch (error) {
      console.error(`Brain relay failed: ${(error as Error).message}`)
      if (error instanceof HubRequestError && error.status === 401) {
        console.error('Machine authority was rejected or revoked; Brain is stopping.')
        return
      }
    }
    if (!stopped) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 5_000)
      wake = () => { clearTimeout(timer); resolve() }
    })
    wake = undefined
  }
}

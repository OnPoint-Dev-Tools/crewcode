import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, timingSafeEqual } from 'crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { hostname, platform } from 'os'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'
import type { BrainAccessScope } from '../shared/hub-relay-types'
import { startBrainRelay } from './hub-brain-relay'
import { BrainAuthorizationPolicy, brainAuthorizationPolicyPath } from './brain-authorization-policy'

export const HUB_ENROLLMENT_TTL_MS = 10 * 60_000
export const HUB_HEARTBEAT_INTERVAL_MS = 30_000
export const HUB_MACHINE_ONLINE_WINDOW_MS = 90_000

interface PendingEnrollment {
  id: string
  userId: string
  secretDigest: Buffer
  expiresAt: number
}

interface PendingDeviceEnrollment {
  id: string
  secretDigest: Buffer
  userCode: string
  publicKey: string
  name: string
  platform: string | null
  version: string | null
  createdAt: number
  expiresAt: number
  state: 'pending' | 'approved' | 'rejected'
  credential?: { machineId: string; token: string }
}

export interface DeviceEnrollmentSummary {
  id: string
  userCode: string
  name: string
  platform: string | null
  version: string | null
  publicKeyFingerprint: string
  createdAt: number
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

export class HubDeviceEnrollmentIssuer {
  private readonly pending = new Map<string, PendingDeviceEnrollment>()
  private readonly alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  constructor(private readonly now: () => number = Date.now, private readonly maxPending = 20) {}

  request(input: { publicKey: string; name: string; platform: string | null; version: string | null }): {
    requestToken: string; requestId: string; userCode: string; expiresAt: number
  } {
    this.prune()
    if (this.pending.size >= this.maxPending) throw new Error('too many pending device enrollments')
    const id = randomBytes(16).toString('hex')
    const secret = randomBytes(32).toString('base64url')
    let code = ''
    do {
      const bytes = randomBytes(8)
      code = `${[...bytes.subarray(0, 4)].map(value => this.alphabet[value % this.alphabet.length]).join('')}-${[...bytes.subarray(4)].map(value => this.alphabet[value % this.alphabet.length]).join('')}`
    } while ([...this.pending.values()].some(item => item.userCode === code))
    const createdAt = this.now()
    const expiresAt = createdAt + HUB_ENROLLMENT_TTL_MS
    this.pending.set(id, {
      id, secretDigest: digest(secret), userCode: code,
      publicKey: input.publicKey, name: input.name, platform: input.platform, version: input.version,
      createdAt, expiresAt, state: 'pending',
    })
    return { requestToken: `${id}.${secret}`, requestId: id, userCode: code, expiresAt }
  }

  list(): DeviceEnrollmentSummary[] {
    this.prune()
    return [...this.pending.values()].filter(item => item.state === 'pending').map(item => ({
      id: item.id, userCode: item.userCode, name: item.name, platform: item.platform, version: item.version,
      publicKeyFingerprint: createHash('sha256').update(Buffer.from(item.publicKey, 'base64url')).digest('hex').match(/.{1,4}/g)?.slice(0, 4).join(':') ?? '',
      createdAt: item.createdAt, expiresAt: item.expiresAt,
    }))
  }

  pendingRequest(id: string): PendingDeviceEnrollment | null {
    this.prune()
    const item = this.pending.get(id)
    return item?.state === 'pending' ? item : null
  }

  approve(id: string, credential: { machineId: string; token: string }): boolean {
    const item = this.pendingRequest(id)
    if (!item) return false
    item.state = 'approved'; item.credential = credential
    return true
  }

  reject(id: string): boolean {
    const item = this.pendingRequest(id)
    if (!item) return false
    item.state = 'rejected'
    return true
  }

  poll(requestToken: string): { status: 'pending' | 'rejected' } | { status: 'approved'; machineId: string; token: string } | null {
    this.prune()
    const separator = requestToken.indexOf('.')
    if (separator < 1) return null
    const id = requestToken.slice(0, separator)
    const item = this.pending.get(id)
    if (!item) return null
    const supplied = digest(requestToken.slice(separator + 1))
    if (supplied.length !== item.secretDigest.length || !timingSafeEqual(supplied, item.secretDigest)) {
      this.pending.delete(id)
      return null
    }
    if (item.state === 'pending') return { status: 'pending' }
    this.pending.delete(id)
    if (item.state === 'rejected') return { status: 'rejected' }
    return item.credential ? { status: 'approved', ...item.credential } : null
  }

  private prune(): void {
    const at = this.now()
    for (const [id, item] of this.pending) if (item.expiresAt <= at) this.pending.delete(id)
  }
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

export function loadMachineCredentialIfPresent(path: string): MachineCredentialFile | null {
  if (!existsSync(path)) return null
  return readMachineCredential(path)
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

export function createMachineIdentity(): { publicKey: string; privateKey: string } {
  const keyPair = generateKeyPairSync('ed25519')
  return {
    publicKey: keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
    privateKey: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url'),
  }
}

function persistEnrolledMachine(options: BrainCliOptions, identity: { publicKey: string; privateKey: string }, result: Record<string, unknown>, now: () => number): MachineCredentialFile {
  if (!options.hubOrigin || typeof result.machineId !== 'string' || typeof result.token !== 'string') throw new Error('Hub returned an invalid machine credential')
  const credential: MachineCredentialFile = { version: 1, hubOrigin: options.hubOrigin, machineId: result.machineId, token: result.token, ...identity, enrolledAt: now() }
  writeMachineCredential(machineCredentialPath(options.dataDir), credential)
  return credential
}

function ensureEnrollmentDestination(options: BrainCliOptions): void {
  const credentialPath = machineCredentialPath(options.dataDir)
  if (existsSync(credentialPath)) throw new Error(`machine credential already exists at ${credentialPath}; revoke the old machine, then remove or move this file before enrolling again`)
}

export async function enrollMachine(options: BrainCliOptions, now = Date.now): Promise<MachineCredentialFile> {
  if (!options.hubOrigin || !options.token) throw new Error('Hub origin and enrollment token are required')
  ensureEnrollmentDestination(options)
  const identity = createMachineIdentity()
  const result = await hubRequest(options.hubOrigin, '/api/v1/hub/machines/enroll', {
    method: 'POST',
    body: JSON.stringify({ enrollmentToken: options.token, publicKey: identity.publicKey, name: options.name, platform: platform(), version: process.env.npm_package_version ?? null }),
  })
  return persistEnrolledMachine(options, identity, result, now)
}

export async function enrollMachineByApproval(options: BrainCliOptions, controls: {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onPending?: (details: { userCode: string; publicKeyFingerprint: string; expiresAt: number; verificationUrl: string }) => void
} = {}): Promise<MachineCredentialFile> {
  if (!options.hubOrigin) throw new Error('Hub origin is required')
  ensureEnrollmentDestination(options)
  const identity = createMachineIdentity()
  const now = controls.now ?? Date.now
  const sleep = controls.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const requested = await hubRequest(options.hubOrigin, '/api/v1/hub/device-enrollments/request', {
    method: 'POST',
    body: JSON.stringify({ publicKey: identity.publicKey, name: options.name, platform: platform(), version: process.env.npm_package_version ?? null }),
  })
  if (typeof requested.requestToken !== 'string' || typeof requested.userCode !== 'string' || typeof requested.expiresAt !== 'number') {
    throw new Error('Hub returned an invalid device enrollment request')
  }
  controls.onPending?.({
    userCode: requested.userCode,
    publicKeyFingerprint: createHash('sha256').update(Buffer.from(identity.publicKey, 'base64url')).digest('hex').match(/.{1,4}/g)?.slice(0, 4).join(':') ?? '',
    expiresAt: requested.expiresAt,
    verificationUrl: options.hubOrigin,
  })
  while (now() < requested.expiresAt) {
    const result = await hubRequest(options.hubOrigin, '/api/v1/hub/device-enrollments/poll', {
      method: 'POST', body: JSON.stringify({ requestToken: requested.requestToken }),
    })
    if (result.status === 'approved') return persistEnrolledMachine(options, identity, result, now)
    if (result.status !== 'pending') throw new Error('Hub returned an invalid device enrollment status')
    await sleep(Math.min(2_000, Math.max(0, requested.expiresAt - now())))
  }
  throw new Error('device enrollment expired before owner approval')
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
  if (command === 'enroll') return `CrewCode machine enrollment\n\nUsage:\n  crewcode enroll --hub <https-origin> [--name <name>] [--data-dir <path>]\n\nBy default, the PC prints a short code and waits for approval in the authenticated\nphone/Hub dashboard. --token keeps the legacy one-time token flow for controlled\nautomation only because command-line arguments may be exposed in process history.`
  return `CrewCode outbound Brain relay\n\nUsage:\n  crewcode brain [--data-dir <path>] [--workspace-root <path>] [--allow-scope <scope>]\n\nScopes (repeatable): workspace:read, workspace:write, terminal, agent.\nThe Brain grants no remote RPC scope by default. Workspace roots and scopes are\nBrain-local authorization; signing in to the Hub cannot widen them.`
}

export async function runBrainCommand(command: 'enroll' | 'brain', argv: string[]): Promise<void> {
  const parsed = parseBrainOptions(argv, command)
  if ('help' in parsed) { console.log(brainUsage(command)); return }
  if (command === 'enroll') {
    const credential = parsed.token
      ? await enrollMachine(parsed)
      : await enrollMachineByApproval(parsed, { onPending: details => {
          console.log(`Approve this machine in the Hub dashboard:\n${details.verificationUrl}`)
          console.log(`Code: ${details.userCode}`)
          console.log(`Public-key fingerprint: ${details.publicKeyFingerprint}`)
          console.log('Waiting for owner approval…')
        } })
    console.log(`Enrolled machine ${credential.machineId} with ${credential.hubOrigin}.`)
    console.log(`Credential stored at ${machineCredentialPath(parsed.dataDir)}.`)
    console.log('Run `crewcode brain` with explicit workspace roots and scopes to enable the outbound relay.')
    return
  }

  if (parsed.allowedScopes.length > 0 && parsed.allowedWorkspaceRoots.length === 0) {
    throw new Error('remote scopes require at least one explicit --workspace-root')
  }
  const credential = readMachineCredential(machineCredentialPath(parsed.dataDir))
  const authorization = new BrainAuthorizationPolicy(brainAuthorizationPolicyPath(parsed.dataDir), parsed.allowedWorkspaceRoots, parsed.allowedScopes).current()
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
  console.log(authorization.scopes.length
    ? `Brain-local grants: ${authorization.scopes.join(', ')} under ${authorization.roots.join(', ')}.`
    : 'Brain-local grants: none. Hub users can connect, but all privileged RPC is denied.')

  while (!stopped) {
    try {
      await sendHeartbeat(credential)
      activeRelay = await startBrainRelay({
        credential,
        dataDir: parsed.dataDir,
        allowedWorkspaceRoots: authorization.roots,
        allowedScopes: authorization.scopes,
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

if (require.main === module) {
  const argv = process.argv.slice(2)
  const command = argv[0] === 'enroll' || argv[0] === 'brain' ? argv.shift() as 'enroll' | 'brain' : 'brain'
  void runBrainCommand(command, argv).catch(error => {
    console.error((error as Error).message)
    process.exitCode = 1
  })
}

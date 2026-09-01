import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import WebSocket from 'ws'
import type { BrainDesktopConnection, BrainDesktopStatus } from '../shared/brain-desktop-types'
import { CREWCODE_REMOTE_PROTOCOL_VERSION, type CrewCodeRemoteResponse } from '../shared/remote-access-types'
import {
  brainDesktopConnectionPath,
  brainDesktopPreferencesPath,
  readBrainDesktopConnection,
  readBrainDesktopEnabled,
  writeBrainDesktopEnabled,
} from './brain-desktop-rendezvous'
import { defaultBrainDataDir, loadMachineCredentialIfPresent, machineCredentialPath, normalizeHubUrl } from './hub-machine-enrollment'

const START_TIMEOUT_MS = 12_000
const POLL_MS = 150

export interface BrainDesktopServiceOptions {
  dataDir?: string
  desktopDataDir: string
  packaged: boolean
  executable: string
  brainEntry: string
  spawnProcess?: (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess
  fetchImpl?: typeof fetch
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function conversationFileName(scope: string): string {
  return `agent-conversations.${createHash('sha256').update(scope).digest('hex').slice(0, 24)}.json`
}

/** Seed aliases so an existing desktop `thread:` replay continues through Brain's `web:` namespace. */
function seedBrainConversationAliases(desktopDataDir: string, runtimeDir: string): void {
  const sources = [join(desktopDataDir, 'agent-conversations.json')]
  const sourceDirectory = join(desktopDataDir, 'conversations')
  if (existsSync(sourceDirectory)) {
    for (const name of readdirSync(sourceDirectory)) {
      if (name.startsWith('agent-conversations.') && name.endsWith('.json')) sources.push(join(sourceDirectory, name))
    }
  }
  const destinationDirectory = join(runtimeDir, 'conversations')
  mkdirSync(destinationDirectory, { recursive: true, mode: 0o700 })
  for (const source of sources) {
    if (!existsSync(source)) continue
    let conversations: Record<string, unknown>
    try {
      const parsed = JSON.parse(readFileSync(source, 'utf8')) as { conversations?: Record<string, unknown> }
      conversations = parsed.conversations && typeof parsed.conversations === 'object' ? parsed.conversations : {}
    } catch { continue }
    for (const [scope, messages] of Object.entries(conversations)) {
      if (!scope.startsWith('thread:') || !Array.isArray(messages)) continue
      const brainScope = `web:${scope.slice('thread:'.length)}`
      const destination = join(destinationDirectory, conversationFileName(brainScope))
      if (!existsSync(destination)) {
        writeFileSync(destination, JSON.stringify({ conversations: { [brainScope]: messages } }), { encoding: 'utf8', mode: 0o600 })
      }
    }
  }
}

/**
 * Seeds a new Brain runtime once. Existing Brain-owned state always wins; this
 * avoids turning every desktop launch into a two-way filesystem replication
 * race. After attachment, both desktop and web write only to the Brain store.
 */
export function seedBrainRuntime(desktopDataDir: string, brainDataDir: string): void {
  const runtimeDir = join(brainDataDir, 'runtime')
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  for (const name of ['workspaces.json', 'agent-sessions.json', 'agent-keys.json', 'agent-conversations.json']) {
    const source = join(desktopDataDir, name)
    const target = join(runtimeDir, name)
    if (existsSync(source) && !existsSync(target)) copyFileSync(source, target)
  }
  for (const name of ['transcripts', 'conversations']) {
    const source = join(desktopDataDir, name)
    const target = join(runtimeDir, name)
    if (existsSync(source) && !existsSync(target)) cpSync(source, target, { recursive: true, errorOnExist: false })
  }
  seedBrainConversationAliases(desktopDataDir, runtimeDir)
}

export class BrainDesktopService {
  private readonly dataDir: string
  private readonly connectionPath: string
  private readonly preferencesPath: string
  private readonly fetchImpl: typeof fetch
  private readonly spawnProcess: NonNullable<BrainDesktopServiceOptions['spawnProcess']>
  private readonly eventListeners = new Set<(event: unknown) => void>()
  private eventSocket: WebSocket | null = null
  private requestSequence = 0

  constructor(private readonly options: BrainDesktopServiceOptions) {
    this.dataDir = options.dataDir ?? defaultBrainDataDir()
    this.connectionPath = brainDesktopConnectionPath(this.dataDir)
    this.preferencesPath = brainDesktopPreferencesPath(this.dataDir)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.spawnProcess = options.spawnProcess ?? spawn
  }

  async initialize(): Promise<BrainDesktopStatus> {
    if (!readBrainDesktopEnabled(this.preferencesPath)) return this.status()
    const live = await this.liveConnection()
    if (!live && existsSync(machineCredentialPath(this.dataDir))) {
      try { await this.start() } catch { /* status reports the actionable failure */ }
    }
    return this.status()
  }

  async status(probeHub = false): Promise<BrainDesktopStatus> {
    const enabled = readBrainDesktopEnabled(this.preferencesPath)
    let hubOrigin: string | undefined
    let hubBrowserOrigin: string | undefined
    let hubReachable: boolean | undefined
    let enrollmentError: string | undefined
    try {
      hubOrigin = loadMachineCredentialIfPresent(machineCredentialPath(this.dataDir))?.hubOrigin
    } catch (cause) {
      enrollmentError = `Machine enrollment could not be read: ${(cause as Error).message}`
    }
    const enrolled = !!hubOrigin
    if (hubOrigin && probeHub) {
      const observed = await this.probeHub(hubOrigin)
      hubReachable = observed.reachable
      hubBrowserOrigin = observed.browserOrigin
    }
    const connection = await this.liveConnection()
    return {
      enabled,
      enrolled,
      ...(hubOrigin ? { hubOrigin } : {}),
      ...(hubBrowserOrigin ? { hubBrowserOrigin } : {}),
      ...(hubReachable !== undefined ? { hubReachable } : {}),
      running: !!connection,
      attached: enabled && !!connection,
      ...(!enrolled ? { error: enrollmentError ?? 'Enroll this machine with a CrewCode Hub before enabling desktop Brain continuity.' } : {}),
    }
  }

  private async probeHub(enrollmentOrigin: string): Promise<{ reachable: boolean; browserOrigin?: string }> {
    try {
      const response = await this.fetchImpl(`${enrollmentOrigin}/api/v1/hub/status`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (!response.ok) return { reachable: false }
      const body = await response.json() as { service?: string; publicOrigin?: string }
      if (body.service !== 'crewcode-hub') return { reachable: false }
      if (typeof body.publicOrigin !== 'string') return { reachable: true }
      return { reachable: true, browserOrigin: normalizeHubUrl(body.publicOrigin) }
    } catch {
      return { reachable: false }
    }
  }

  async setEnabled(enabled: boolean): Promise<BrainDesktopStatus> {
    writeBrainDesktopEnabled(this.preferencesPath, enabled)
    if (enabled) await this.start()
    return this.status()
  }

  async start(): Promise<BrainDesktopConnection> {
    const existing = await this.liveConnection()
    if (existing) { void this.ensureEventSocket(); return existing }
    if (!existsSync(machineCredentialPath(this.dataDir))) {
      throw new Error('Enroll this machine with a CrewCode Hub before starting the background Brain.')
    }
    seedBrainRuntime(this.options.desktopDataDir, this.dataDir)
    const args = this.options.packaged
      ? ['brain', '--data-dir', this.dataDir, '--desktop-background']
      : [this.options.brainEntry, 'brain', '--data-dir', this.dataDir, '--desktop-background']
    const env = { ...process.env }
    if (!this.options.packaged) env.ELECTRON_RUN_AS_NODE = '1'
    const child = this.spawnProcess(this.options.executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    })
    child.unref()
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      const connection = await this.liveConnection()
      if (connection) { void this.ensureEventSocket(); return connection }
      await delay(POLL_MS)
    }
    throw new Error('The background Brain did not publish a live desktop connection before startup timed out.')
  }

  async stop(disable = true): Promise<BrainDesktopStatus> {
    if (disable) writeBrainDesktopEnabled(this.preferencesPath, false)
    const connection = readBrainDesktopConnection(this.connectionPath)
    if (connection) {
      try {
        await this.fetchImpl(`${connection.url}/api/v1/desktop/stop`, {
          method: 'POST',
          headers: { authorization: `Bearer ${connection.controlToken}` },
        })
      } catch { /* process may already be gone */ }
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline && await this.probe(connection)) await delay(POLL_MS)
    }
    this.eventSocket?.close()
    this.eventSocket = null
    return this.status()
  }

  async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const connection = await this.liveConnection()
    if (!connection || !readBrainDesktopEnabled(this.preferencesPath)) throw new Error('The desktop Brain is not attached.')
    if (method.startsWith('desktop.')) {
      const response = await this.fetchImpl(`${connection.url}/api/v1/desktop/control`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.controlToken}` },
        body: JSON.stringify({ method: method.slice('desktop.'.length), params }),
      })
      const body = await response.json() as { ok?: boolean; result?: T; error?: { message?: string } }
      if (!response.ok || !body.ok) throw new Error(body.error?.message ?? `Brain desktop control failed with ${response.status}`)
      return body.result as T
    }
    const id = `desktop-${Date.now().toString(36)}-${(++this.requestSequence).toString(36)}`
    const response = await this.fetchImpl(`${connection.url}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${connection.sessionToken}` },
      body: JSON.stringify({ protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id, method, params }),
    })
    const body = await response.json() as CrewCodeRemoteResponse<T>
    if (!response.ok || !body.ok) throw new Error(!body.ok ? body.error.message : `Brain RPC failed with ${response.status}`)
    if (body.id !== id || body.protocolVersion !== CREWCODE_REMOTE_PROTOCOL_VERSION) throw new Error('Brain returned a mismatched RPC response.')
    return body.result
  }

  async uploadAttachment(root: string, name: string, body: Uint8Array): Promise<{ rel?: string; error?: string }> {
    const connection = await this.liveConnection()
    if (!connection || !readBrainDesktopEnabled(this.preferencesPath)) return { error: 'The desktop Brain is not attached.' }
    const response = await this.fetchImpl(`${connection.url}/api/v1/attachments?root=${encodeURIComponent(root)}&name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${connection.sessionToken}` },
      body: Buffer.from(body),
    })
    const result = await response.json() as { rel?: string; error?: { message?: string } }
    return response.ok && result.rel ? { rel: result.rel } : { error: result.error?.message ?? `Attachment upload failed with ${response.status}.` }
  }

  subscribe(listener: (event: unknown) => void): () => void {
    this.eventListeners.add(listener)
    void this.ensureEventSocket()
    return () => {
      this.eventListeners.delete(listener)
      if (this.eventListeners.size === 0) {
        this.eventSocket?.close()
        this.eventSocket = null
      }
    }
  }

  private async liveConnection(): Promise<BrainDesktopConnection | null> {
    const connection = readBrainDesktopConnection(this.connectionPath)
    return connection && await this.probe(connection) ? connection : null
  }

  private async probe(connection: BrainDesktopConnection): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${connection.url}/api/v1/desktop/status`, {
        headers: { authorization: `Bearer ${connection.controlToken}` },
        signal: AbortSignal.timeout(1_000),
      })
      if (!response.ok) return false
      const body = await response.json() as { ok?: boolean; pid?: number }
      return body.ok === true && body.pid === connection.pid
    } catch {
      return false
    }
  }

  private async ensureEventSocket(): Promise<void> {
    if (this.eventSocket || this.eventListeners.size === 0) return
    const connection = await this.liveConnection()
    if (!connection || !readBrainDesktopEnabled(this.preferencesPath)) return
    const socket = new WebSocket(connection.url.replace(/^http/, 'ws') + '/api/v1/events', ['crewcode.v1', connection.sessionToken])
    this.eventSocket = socket
    socket.on('message', raw => {
      let event: unknown
      try { event = JSON.parse(raw.toString()) } catch { return }
      for (const listener of this.eventListeners) listener(event)
    })
    socket.on('error', () => undefined)
    socket.on('close', () => {
      if (this.eventSocket !== socket) return
      this.eventSocket = null
      if (this.eventListeners.size > 0) setTimeout(() => { void this.ensureEventSocket() }, 1_000)
    })
  }
}

import {
  CREWCODE_REMOTE_PROTOCOL_VERSION,
  type CrewCodeRemoteRequest,
  type CrewCodeRemoteResponse,
} from '../../../shared/remote-access-types'
import type {
  BrainAccessScope,
  HubConnectionTicketResponse,
  HubRelayControlFrame,
  HubTunnelPlaintext,
} from '../../../shared/hub-relay-types'
import type { WebClientTransport, WebEventEnvelope } from './web-rpc-client'
import { WebRpcError } from './web-rpc-client'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
let requestCounter = 0

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(new ArrayBuffer(value.byteLength))
  result.set(value)
  return result
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  let normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  while (normalized.length % 4) normalized += '='
  const raw = atob(normalized)
  const result = new Uint8Array(new ArrayBuffer(raw.length))
  for (let index = 0; index < raw.length; index += 1) result[index] = raw.charCodeAt(index)
  return result
}

function encodeBase64(value: Uint8Array): string {
  let raw = ''
  const size = 32 * 1024
  for (let offset = 0; offset < value.byteLength; offset += size) {
    raw += String.fromCharCode(...value.subarray(offset, Math.min(value.byteLength, offset + size)))
  }
  return btoa(raw)
}

function encodeBase64Url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  let raw = ''
  for (const byte of bytes) raw += String.fromCharCode(byte)
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function transcript(connectionId: string, clientKey: string, serverKey: string): Uint8Array<ArrayBuffer> {
  return ownedBytes(encoder.encode(`crewcode-hub-relay-v1\0${connectionId}\0${clientKey}\0${serverKey}`))
}

function nonce(direction: 'browser' | 'brain', sequence: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('invalid relay sequence')
  const value = new Uint8Array(new ArrayBuffer(12))
  const view = new DataView(value.buffer)
  view.setUint32(0, direction === 'browser' ? 0x42525752 : 0x4252414e)
  view.setBigUint64(4, BigInt(sequence))
  return value
}

function aad(connectionId: string, direction: 'browser' | 'brain', sequence: number): Uint8Array<ArrayBuffer> {
  return ownedBytes(encoder.encode(`${connectionId}\0${direction}\0${sequence}`))
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json().catch(() => ({})) as Record<string, unknown>
}

export interface OpenHubRelayTransport {
  transport: WebClientTransport
  grantedScopes: BrainAccessScope[]
  closed: Promise<{ code: number; reason: string; error: Error }>
  close(): void
}

export type HubRelayConnectionStatus =
  | { state: 'connected'; grantedScopes: BrainAccessScope[] }
  | { state: 'connecting' }
  | { state: 'disconnected'; message: string; code?: number; reason?: string }

export interface ManagedHubRelayTransport {
  transport: WebClientTransport
  grantedScopes: BrainAccessScope[]
  reconnect(options?: { force?: boolean }): Promise<void>
  onStatus(listener: (status: HubRelayConnectionStatus) => void): () => void
  close(): void
}

async function openHubRelayTransport(machineId: string, requestedScopes: BrainAccessScope[]): Promise<OpenHubRelayTransport> {
  const sessionResponse = await fetch('/api/v1/hub/session', { cache: 'no-store' })
  const session = await responseJson(sessionResponse)
  if (!sessionResponse.ok || typeof session.csrf !== 'string') throw new WebRpcError(String(session.error ?? 'valid Hub session required'), 'UNAUTHENTICATED', sessionResponse.status)
  const ticketResponse = await fetch(`/api/v1/hub/machines/${encodeURIComponent(machineId)}/tickets`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-crewcode-csrf': session.csrf },
    body: JSON.stringify({ requestedScopes }),
  })
  const ticketBody = await responseJson(ticketResponse) as unknown as HubConnectionTicketResponse & { error?: string }
  if (!ticketResponse.ok || !ticketBody.ticket || !ticketBody.machinePublicKey) throw new WebRpcError(ticketBody.error ?? 'connection ticket rejected', 'FORBIDDEN', ticketResponse.status)

  const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const clientKey = encodeBase64Url(await crypto.subtle.exportKey('raw', keyPair.publicKey))
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/api/v1/hub/relay`, ['crewcode.browser.v1', ticketBody.ticket])
  const listeners = new Set<(event: WebEventEnvelope) => void>()
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  let connectionId = ''
  let browserKey: CryptoKey | null = null
  let brainKey: CryptoKey | null = null
  let browserSequence = 0
  let expectedBrainSequence = 0
  let grantedScopes: BrainAccessScope[] = []
  let messageChain = Promise.resolve()
  let sendChain = Promise.resolve()
  let readyResolve!: () => void
  let readyReject!: (error: Error) => void
  let closedResolve!: (value: { code: number; reason: string; error: Error }) => void
  let failure: Error | null = null
  let failed = false
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const closed = new Promise<{ code: number; reason: string; error: Error }>(resolve => { closedResolve = resolve })

  const disconnectedError = async (): Promise<never> => {
    if (failure) throw failure
    // readyState changes to CLOSING before the close event supplies its code
    // and reason. Preserve that evidence instead of replacing it with a
    // generic preflight error during this short race.
    if (socket.readyState === WebSocket.CLOSING) {
      const disconnect = await closed
      throw disconnect.error
    }
    throw new WebRpcError('encrypted Brain tunnel is not connected', 'UNAUTHENTICATED')
  }

  const fail = (error: Error): void => {
    failure ??= error
    if (failed) return
    failed = true
    readyReject(error)
    for (const item of pending.values()) item.reject(error)
    pending.clear()
  }

  const handleMessage = async (frame: HubRelayControlFrame): Promise<void> => {
    if (frame.type === 'ready') {
      if (frame.machineId !== ticketBody.machineId || frame.machinePublicKey !== ticketBody.machinePublicKey) throw new Error('Hub returned mismatched machine identity')
      connectionId = frame.connectionId
      socket.send(JSON.stringify({ type: 'clientHello', connectionId, key: clientKey } satisfies HubRelayControlFrame))
      return
    }
    if (frame.type === 'serverHello') {
      if (!connectionId || frame.connectionId !== connectionId) throw new Error('Brain handshake has a mismatched connection id')
      const machineKey = await crypto.subtle.importKey('spki', decodeBase64Url(ticketBody.machinePublicKey), { name: 'Ed25519' }, false, ['verify'])
      const verified = await crypto.subtle.verify('Ed25519', machineKey, decodeBase64Url(frame.signature), transcript(connectionId, clientKey, frame.key))
      if (!verified) throw new Error('Brain machine identity signature was rejected')
      const serverKey = await crypto.subtle.importKey('raw', decodeBase64Url(frame.key), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
      const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, keyPair.privateKey, 256)
      const salt = await crypto.subtle.digest('SHA-256', transcript(connectionId, clientKey, frame.key))
      const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
      browserKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: ownedBytes(encoder.encode('browser-to-brain')) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
      brainKey = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: ownedBytes(encoder.encode('brain-to-browser')) }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
      grantedScopes = frame.grantedScopes
      readyResolve()
      return
    }
    if (frame.type === 'close') throw new Error(`Brain closed the tunnel: ${frame.reason}`)
    if (frame.type !== 'encrypted' || !brainKey || frame.connectionId !== connectionId) return
    if (frame.sequence !== expectedBrainSequence) {
      throw new Error(`Brain encrypted frame sequence was rejected: expected ${expectedBrainSequence}, received ${frame.sequence}`)
    }
    expectedBrainSequence += 1
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce('brain', frame.sequence), additionalData: aad(connectionId, 'brain', frame.sequence), tagLength: 128 },
      brainKey,
      decodeBase64Url(frame.ciphertext),
    )
    const message = JSON.parse(decoder.decode(plaintext)) as HubTunnelPlaintext
    if (message.type === 'event') {
      if (message.channel === 'pty' || message.channel === 'bridge') {
        for (const listener of listeners) listener({ channel: message.channel, event: message.event } as WebEventEnvelope)
      }
      return
    }
    if (message.type !== 'rpcResult') return
    const awaiting = pending.get(message.response.id)
    if (!awaiting) return
    pending.delete(message.response.id)
    if (message.response.ok) awaiting.resolve(message.response.result)
    else awaiting.reject(new WebRpcError(message.response.error.message, message.response.error.code))
  }

  socket.addEventListener('message', event => {
    messageChain = messageChain.then(async () => handleMessage(JSON.parse(String(event.data)) as HubRelayControlFrame)).catch(error => {
      fail(error as Error)
      socket.close(4002, 'encrypted tunnel rejected')
    })
  })
  socket.addEventListener('error', () => fail(new WebRpcError('Hub relay connection failed', 'UNAUTHENTICATED')))
  socket.addEventListener('close', event => {
    const detail = event.reason ? `: ${event.reason}` : ''
    const error = failure ?? new WebRpcError(`Hub relay disconnected${detail}; unobserved operations are interrupted`, 'UNAUTHENTICATED')
    fail(error)
    closedResolve({ code: event.code, reason: event.reason, error })
  })
  await ready

  const transport: WebClientTransport = {
    async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
      if (!browserKey || socket.readyState !== WebSocket.OPEN) return disconnectedError()
      requestCounter += 1
      const id = `hub-${Date.now().toString(36)}-${requestCounter.toString(36)}`
      const request: CrewCodeRemoteRequest = { protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id, method, params }
      const result = new Promise<T>((resolve, reject) => pending.set(id, { resolve: value => resolve(value as T), reject }))
      // WebCrypto promises from concurrent RPCs may settle out of order. Keep
      // encryption and socket.send in one chain so sequence order is also wire
      // order; the Brain rejects gaps and replayed/out-of-order frames.
      const send = sendChain.then(async () => {
        if (!browserKey || socket.readyState !== WebSocket.OPEN) return disconnectedError()
        const sequence = browserSequence++
        const ciphertext = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: nonce('browser', sequence), additionalData: aad(connectionId, 'browser', sequence), tagLength: 128 },
          browserKey,
          ownedBytes(encoder.encode(JSON.stringify({ type: 'rpc', request } satisfies HubTunnelPlaintext))),
        )
        socket.send(JSON.stringify({ type: 'encrypted', connectionId, sequence, ciphertext: encodeBase64Url(ciphertext) } satisfies HubRelayControlFrame))
      })
      sendChain = send.catch(() => undefined)
      try {
        await send
      } catch (error) {
        fail(error as Error)
        socket.close(4002, 'encrypted tunnel send failed')
        throw error
      }
      return result
    },
    subscribe(onEvent) {
      listeners.add(onEvent)
      return () => listeners.delete(onEvent)
    },
  }
  return { transport, grantedScopes, closed, close: () => socket.close(1000, 'browser disconnected') }
}

/**
 * Keeps one stable transport installed in the browser runtime while requiring an
 * explicit user action to reconnect with a fresh ticket. Interrupted RPCs are
 * rejected by the old connection and are never queued or replayed.
 */
export async function connectHubRelayTransport(
  machineId: string,
  requestedScopes: BrainAccessScope[],
  options: { open?: () => Promise<OpenHubRelayTransport> } = {},
): Promise<ManagedHubRelayTransport> {
  const open = options.open ?? (() => openHubRelayTransport(machineId, requestedScopes))
  const statusListeners = new Set<(status: HubRelayConnectionStatus) => void>()
  const eventListeners = new Set<(event: WebEventEnvelope) => void>()
  const pendingEvents: WebEventEnvelope[] = []
  const MAX_PENDING_EVENTS = 1_000
  let active: OpenHubRelayTransport | null = null
  let activeEventDisposer: (() => void) | null = null
  let stopped = false
  let reconnecting: Promise<void> | null = null
  let grantedScopes: BrainAccessScope[] = []
  const bridgeIds = new Set<string>()
  const paneIds = new Set<string>()

  const emitStatus = (status: HubRelayConnectionStatus): void => {
    for (const listener of statusListeners) listener(status)
  }
  const activate = (connection: OpenHubRelayTransport, announce = true): void => {
    activeEventDisposer?.()
    active = connection
    grantedScopes = connection.grantedScopes
    activeEventDisposer = connection.transport.subscribe(event => {
      if (!eventListeners.size) {
        pendingEvents.push(event)
        if (pendingEvents.length > MAX_PENDING_EVENTS) pendingEvents.shift()
        return
      }
      for (const listener of eventListeners) listener(event)
    })
    if (announce) emitStatus({ state: 'connected', grantedScopes })
    void connection.closed.then(disconnect => {
      if (active !== connection) return
      activeEventDisposer?.()
      activeEventDisposer = null
      active = null
      if (!stopped) emitStatus({
        state: 'disconnected',
        message: disconnect.error.message,
        code: disconnect.code,
        reason: disconnect.reason,
      })
    })
  }
  const reconnect = async (options: { force?: boolean } = {}): Promise<void> => {
    if (stopped) throw new WebRpcError('Hub relay transport is closed', 'UNAUTHENTICATED')
    if (active && !options.force) return
    if (active && options.force) {
      const previous = active
      activeEventDisposer?.(); activeEventDisposer = null; active = null; previous.close()
    }
    if (reconnecting) return reconnecting
    emitStatus({ state: 'connecting' })
    reconnecting = open().then(connection => {
      if (stopped) {
        connection.close()
        throw new WebRpcError('Hub relay transport is closed', 'UNAUTHENTICATED')
      }
      activate(connection, false)
      const requestedBridgeIds = [...bridgeIds]
      const requestedPaneIds = [...paneIds]
      return Promise.all([
        requestedBridgeIds.length
          ? connection.transport.rpc<{ claimed: string[] }>('bridge.claim', { bridgeIds: requestedBridgeIds })
          : Promise.resolve({ claimed: [] }),
        requestedPaneIds.length
          ? connection.transport.rpc<{ claimed: string[] }>('pty.claim', { paneIds: requestedPaneIds })
          : Promise.resolve({ claimed: [] }),
      ]).then(([bridgeClaims, paneClaims]) => {
        // A Brain restart legitimately returns an empty claim set because its
        // execution registry is process-local. Keep only ownership that the new
        // encrypted session actually proved; stale ids must not be presented as
        // attached or blindly re-claimed on every later reconnect.
        bridgeIds.clear()
        for (const id of Array.isArray(bridgeClaims.claimed) ? bridgeClaims.claimed.map(String) : []) bridgeIds.add(id)
        paneIds.clear()
        for (const id of Array.isArray(paneClaims.claimed) ? paneClaims.claimed.map(String) : []) paneIds.add(id)
        emitStatus({ state: 'connected', grantedScopes })
      })
    }).catch(error => {
      activeEventDisposer?.()
      activeEventDisposer = null
      active?.close()
      active = null
      if (!stopped) emitStatus({ state: 'disconnected', message: (error as Error).message })
      throw error
    }).finally(() => { reconnecting = null })
    return reconnecting
  }

  activate(await open())
  const transport: WebClientTransport = {
    async rpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
      if (!active) throw new WebRpcError('Hub relay is disconnected; reconnect before retrying', 'UNAUTHENTICATED')
      const result = await active.transport.rpc<T>(method, params)
      const bridgeId = typeof params.bridgeId === 'string' ? params.bridgeId : ''
      const paneId = typeof params.paneId === 'string' ? params.paneId : ''
      const semantic = result && typeof result === 'object' ? result as { ok?: boolean; error?: unknown; claimed?: unknown } : null
      const succeeded = semantic?.ok !== false && !semantic?.error
      const claimed = Array.isArray(semantic?.claimed) ? semantic.claimed.map(String) : []
      if (method === 'bridge.start' && bridgeId && succeeded) bridgeIds.add(bridgeId)
      else if (method === 'bridge.stop' && bridgeId && succeeded) bridgeIds.delete(bridgeId)
      else if (method === 'bridge.claim' && succeeded) {
        for (const id of claimed) bridgeIds.add(id)
      } else if (method === 'pty.create' && paneId && succeeded) paneIds.add(paneId)
      else if (method === 'pty.kill' && paneId && succeeded) paneIds.delete(paneId)
      else if (method === 'pty.claim' && succeeded) {
        for (const id of claimed) paneIds.add(id)
      }
      return result
    },
    async uploadAttachment(root, name, body) {
      if (!active) throw new WebRpcError('Hub relay is disconnected; reconnect before uploading', 'UNAUTHENTICATED')
      const connection = active
      const bytes = new Uint8Array(body)
      const begun = await connection.transport.rpc<{ uploadId: string; chunkBytes: number }>('attachments.begin', {
        root, name, size: bytes.byteLength,
      })
      const chunkBytes = Math.min(256 * 1024, Number(begun.chunkBytes))
      if (!begun.uploadId || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error('Brain returned invalid attachment upload parameters')
      try {
        let sequence = 0
        for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
          // Await each acknowledgement for natural end-to-end backpressure and
          // strict ordering; no plaintext attachment bytes are visible to Hub.
          await connection.transport.rpc('attachments.chunk', {
            uploadId: begun.uploadId,
            sequence: sequence++,
            data: encodeBase64(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes))),
          })
        }
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body))
        const finished = await connection.transport.rpc<{ rel: string }>('attachments.finish', {
          uploadId: begun.uploadId,
          sha256: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''),
        })
        if (!finished.rel) throw new Error('Brain did not return an attachment path')
        return finished.rel
      } catch (error) {
        // Best effort: disconnect cleanup and Brain's idle sweep cover cases in
        // which the encrypted cancellation itself cannot arrive.
        await connection.transport.rpc('attachments.cancel', { uploadId: begun.uploadId }).catch(() => undefined)
        throw error
      }
    },
    subscribe(listener) {
      eventListeners.add(listener)
      if (pendingEvents.length) {
        const replay = pendingEvents.splice(0)
        queueMicrotask(() => {
          if (!eventListeners.has(listener)) return
          for (const event of replay) listener(event)
        })
      }
      return () => eventListeners.delete(listener)
    },
  }
  return {
    transport,
    get grantedScopes() { return grantedScopes },
    reconnect,
    onStatus(listener) {
      statusListeners.add(listener)
      listener(active ? { state: 'connected', grantedScopes } : { state: 'disconnected', message: 'Hub relay is disconnected' })
      return () => statusListeners.delete(listener)
    },
    close() {
      stopped = true
      activeEventDisposer?.()
      activeEventDisposer = null
      active?.close()
      active = null
    },
  }
}

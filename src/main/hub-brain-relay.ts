import { realpathSync } from 'fs'
import { join } from 'path'
import WebSocket from 'ws'
import {
  CREWCODE_REMOTE_PROTOCOL_VERSION,
  type CrewCodeRemoteRequest,
  type CrewCodeRemoteResponse,
} from '../shared/remote-access-types'
import {
  type BrainAccessScope,
  type HubRelayControlFrame,
  type HubTunnelPlaintext,
} from '../shared/hub-relay-types'
import { resolveHeadlessAgentPath } from './headless-agent-resolver'
import { BrainAuthorizationPolicy, brainAuthorizationPolicyPath } from './brain-authorization-policy'
import { loadConversation } from './agents/conversation-store'
import { webConversationKey } from './agents/bridge-service'
import type { MachineCredentialFile } from './hub-machine-enrollment'
import { createBrainRelayCipher, type BrainRelayCipher } from './hub-relay-crypto'
import { startRemoteAccessServer } from './remote-access-server'

const READ_METHODS = new Set([
  'workspaces.list', 'workspaces.inspectPath', 'fs.readDir', 'fs.readFile', 'fs.readDataUrl', 'fs.listFiles',
  'git.status', 'git.diff', 'git.log', 'git.branches', 'git.remotes', 'worktrees.list',
  'github.status', 'github.prCreateContext', 'github.prDetail', 'github.prDiff', 'gh.status',
  'continuity.get',
])
const WRITE_METHOD_PREFIXES = ['workspaces.', 'fs.', 'git.', 'worktrees.', 'gh.']
const AGENT_METHOD_PREFIXES = ['bridge.', 'agents.', 'transcripts.', 'mcp.', 'voice.', 'delegation.']

interface RelaySession {
  connectionId: string
  userId: string
  grantedScopes: Set<BrainAccessScope>
  cipher?: BrainRelayCipher
  expectedBrowserSequence: number
  brainSequence: number
  outboundQueue: HubTunnelPlaintext[]
  outboundSending: boolean
}

export interface BrainRelayOptions {
  credential: MachineCredentialFile
  dataDir: string
  allowedWorkspaceRoots: string[]
  allowedScopes: BrainAccessScope[]
  desktop?: {
    controlToken: string
    onReady: (connection: { url: string; sessionToken: string }) => void
    onStop: () => void
  }
}

export interface RunningBrainRelay {
  close(): Promise<void>
  closed: Promise<void>
}

export function brainScopeForMethod(method: string): BrainAccessScope | null {
  if (method === 'continuity.update') return 'workspace:write'
  if (READ_METHODS.has(method)) return 'workspace:read'
  if (method.startsWith('pty.')) return 'terminal'
  if (method.startsWith('attachments.')) return 'workspace:write'
  if (AGENT_METHOD_PREFIXES.some(prefix => method.startsWith(prefix))) return 'agent'
  if (WRITE_METHOD_PREFIXES.some(prefix => method.startsWith(prefix))) return 'workspace:write'
  return null
}

function deniedResponse(request: CrewCodeRemoteRequest, message: string): CrewCodeRemoteResponse {
  return {
    protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION,
    id: request.id,
    ok: false,
    error: { code: 'FORBIDDEN', message },
  }
}

function latestAssistantMessageIndex(messages: Array<{ role: string; content: string }>): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'assistant' && message.content.trim()) return index
  }
  return -1
}

function precedingUserText(messages: Array<{ role: string; content: string }>, before: number): string | undefined {
  for (let index = before - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === 'user') return messages[index]!.content
  }
  return undefined
}

function websocketOrigin(origin: string): string {
  const url = new URL(origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/api/v1/hub/relay'
  return url.toString()
}

export async function startBrainRelay(options: BrainRelayOptions): Promise<RunningBrainRelay> {
  const policy = new BrainAuthorizationPolicy(brainAuthorizationPolicyPath(options.dataDir), options.allowedWorkspaceRoots.map(root => realpathSync(root)), options.allowedScopes)
  const roots = policy.current().roots
  const runtimeDataDir = join(options.dataDir, 'runtime')
  // Agent persistence helpers also run in Electron, where they fall back to
  // app.getPath(). A Brain is ordinary Node, so pin the same explicit runtime
  // directory before any agent bridge can lazily open those stores.
  process.env.CREWCODE_DATA_DIR = runtimeDataDir
  const backend = await startRemoteAccessServer({
    host: '127.0.0.1',
    port: 0,
    dataDir: runtimeDataDir,
    allowedWorkspaceRoots: roots,
    resolveAgentPath: resolveHeadlessAgentPath,
    desktopControl: options.desktop ? { token: options.desktop.controlToken, onStop: options.desktop.onStop } : undefined,
  })
  const pairResponse = await fetch(`${backend.url}/api/v1/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: backend.pairingToken }),
  })
  const pair = await pairResponse.json() as { sessionToken?: string }
  if (!pairResponse.ok || !pair.sessionToken) { await backend.close(); throw new Error('could not initialize the brain RPC boundary') }
  const backendToken = pair.sessionToken
  options.desktop?.onReady({ url: backend.url, sessionToken: backendToken })
  const eventSocket = new WebSocket(backend.url.replace(/^http/, 'ws') + '/api/v1/events', ['crewcode.v1', backendToken])
  await new Promise<void>((resolve, reject) => { eventSocket.once('open', resolve); eventSocket.once('error', reject) })

  // The Brain-local execution backend outlives every Hub/browser transport.
  // `relay` is replaced on transient Hub disconnects without recreating the
  // backend or stopping provider processes.
  let relay: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  const sessions = new Map<string, RelaySession>()
  type ResourceOwner = {
    userId: string
    connectionId: string | null
    createdAt: number
    lastEventAt: number
    status: 'idle' | 'running' | 'completed' | 'blocked' | 'failed' | 'interrupted'
    cwd?: string
    provider?: string
    conversationScopeKey?: string
    droppedEvents: number
  }
  const paneOwners = new Map<string, ResourceOwner>()
  const bridgeOwners = new Map<string, ResourceOwner>()
  const requestOwners = new Map<string, string>()
  const detachedEvents = new Map<string, Array<{ channel: 'pty' | 'bridge'; event: unknown }>>()
  // Keep a process-local semantic snapshot of the current/latest text turn even
  // while it is attached. Browser close and Brain's logical `close` frame travel
  // on different sockets, so a few final encrypted deltas can otherwise target
  // the just-closed connection before detach is observed and disappear. A fresh
  // explicit claim receives this replacement snapshot before later live deltas.
  const bridgeTextSnapshots = new Map<string, { turnId: string; text: string }>()
  const MAX_OWNED_RESOURCES_PER_USER = 100
  const MAX_DETACHED_EVENTS_PER_RESOURCE = 1_000
  const MAX_DETACHED_EVENT_BYTES_PER_RESOURCE = 1024 * 1024
  const MAX_OUTBOUND_FRAMES_PER_SESSION = 1_000
  const appendDetachedEvent = (resourceId: string, event: { channel: 'pty' | 'bridge'; event: unknown }): void => {
    const events = [...(detachedEvents.get(resourceId) ?? []), event]
    let bytes = events.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0)
    let dropped = 0
    while (events.length > MAX_DETACHED_EVENTS_PER_RESOURCE || bytes > MAX_DETACHED_EVENT_BYTES_PER_RESOURCE) {
      const removed = events.shift()
      if (!removed) break
      bytes -= Buffer.byteLength(JSON.stringify(removed))
      dropped += 1
    }
    const owner = bridgeOwners.get(resourceId) ?? paneOwners.get(resourceId)
    if (owner) owner.droppedEvents += dropped
    detachedEvents.set(resourceId, events)
  }
  let closing = false
  let backendClose: Promise<void> | null = null
  const closeBackend = (): Promise<void> => {
    backendClose ??= (async () => {
      const sessionId = backendToken.slice(0, backendToken.indexOf('.'))
      try {
        await fetch(`${backend.url}/api/v1/rpc`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${backendToken}` },
          body: JSON.stringify({ protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id: 'brain-internal-revoke', method: 'auth.revoke', params: { sessionId } }),
        })
      } catch { /* the loopback boundary is already closing */ }
      await backend.close()
    })()
    return backendClose
  }
  let closeResolve!: () => void
  const closed = new Promise<void>(resolve => { closeResolve = resolve })

  const drainEncrypted = (session: RelaySession): void => {
    const activeRelay = relay
    if (session.outboundSending || !session.cipher || !activeRelay || activeRelay.readyState !== WebSocket.OPEN) return
    const plaintext = session.outboundQueue[0]
    if (!plaintext) return
    const sequence = session.brainSequence
    const descriptor = plaintext.type === 'rpcResult'
      ? `RPC result ${plaintext.response.id}`
      : plaintext.type === 'event' ? `${plaintext.channel} event` : plaintext.type
    const closeForFrameFailure = (operation: string, cause: unknown): void => {
      session.outboundQueue.length = 0
      const detail = cause instanceof Error && cause.message
        ? cause.message.replace(/[\r\n]/g, ' ').slice(0, 160)
        : 'unknown failure'
      activeRelay.send(JSON.stringify({
        type: 'close', connectionId: session.connectionId,
        reason: `Brain could not ${operation} encrypted frame ${sequence} (${descriptor}): ${detail}`,
      } satisfies HubRelayControlFrame))
      releaseSession(session.connectionId)
    }
    let plaintextJson: string
    try {
      plaintextJson = JSON.stringify(plaintext)
    } catch (cause) {
      closeForFrameFailure('serialize', cause)
      return
    }
    let ciphertext: string
    try {
      ciphertext = session.cipher.encryptBrain(sequence, plaintextJson)
    } catch (cause) {
      closeForFrameFailure('encrypt', cause)
      return
    }
    const frame: HubRelayControlFrame = {
      type: 'encrypted', connectionId: session.connectionId, sequence, ciphertext,
    }
    const encoded = JSON.stringify(frame)
    session.outboundSending = true
    activeRelay.send(encoded, error => {
      session.outboundSending = false
      if (sessions.get(session.connectionId) !== session || relay !== activeRelay) {
        session.outboundQueue.length = 0
        return
      }
      if (error) {
        session.outboundQueue.length = 0
        activeRelay.close(4002, `Brain encrypted frame ${sequence} was not accepted`)
        return
      }
      // Allocate the next nonce only after ws confirms this frame was accepted
      // for transmission. Advancing before that observation creates a permanent
      // sequence hole when serialization or socket backpressure fails.
      session.outboundQueue.shift()
      session.brainSequence += 1
      drainEncrypted(session)
    })
  }

  const sendEncrypted = (session: RelaySession, plaintext: HubTunnelPlaintext): void => {
    if (!session.cipher || sessions.get(session.connectionId) !== session) return
    if (session.outboundQueue.length >= MAX_OUTBOUND_FRAMES_PER_SESSION) {
      relay?.send(JSON.stringify({
        type: 'close', connectionId: session.connectionId,
        reason: 'Brain encrypted outbound queue limit reached',
      } satisfies HubRelayControlFrame))
      releaseSession(session.connectionId)
      return
    }
    session.outboundQueue.push(plaintext)
    drainEncrypted(session)
  }

  const releaseSession = (connectionId: string): void => {
    sessions.delete(connectionId)
    // Browser transport custody is deliberately separate from execution custody.
    // A dropped browser detaches its resources; only explicit bridge.stop,
    // pty.kill, Brain shutdown, or authority revocation terminates them.
    for (const owner of paneOwners.values()) if (owner.connectionId === connectionId) owner.connectionId = null
    for (const owner of bridgeOwners.values()) if (owner.connectionId === connectionId) owner.connectionId = null
  }

  eventSocket.on('message', raw => {
    let event: { channel?: 'pty' | 'bridge'; event?: unknown }
    try { event = JSON.parse(raw.toString()) as typeof event } catch { return }
    if (event.channel !== 'pty' && event.channel !== 'bridge') return
    const eventRecord = event.event && typeof event.event === 'object' ? event.event as Record<string, unknown> : {}
    const nestedRequest = eventRecord.request && typeof eventRecord.request === 'object' ? eventRecord.request as Record<string, unknown> : null
    const resourceId = event.channel === 'pty' ? String(eventRecord.paneId ?? '') : String(eventRecord.bridgeId ?? nestedRequest?.bridgeId ?? '')
    const owner = event.channel === 'pty' ? paneOwners.get(resourceId) : bridgeOwners.get(resourceId)
    if (owner && nestedRequest && typeof nestedRequest.requestId === 'string') requestOwners.set(nestedRequest.requestId, resourceId)
    if (!owner) return
    owner.lastEventAt = Date.now()
    if (event.channel === 'bridge') {
      const type = String(eventRecord.type ?? '')
      if (type === 'turn_start') {
        owner.status = 'running'
        const turnId = typeof eventRecord.turnId === 'string' ? eventRecord.turnId : ''
        if (turnId) bridgeTextSnapshots.set(resourceId, { turnId, text: '' })
      } else if (type === 'text_delta') {
        const turnId = typeof eventRecord.turnId === 'string' ? eventRecord.turnId : ''
        const delta = typeof eventRecord.delta === 'string' ? eventRecord.delta : ''
        const snapshot = bridgeTextSnapshots.get(resourceId)
        if (turnId && delta) {
          const text = snapshot?.turnId === turnId ? snapshot.text + delta : delta
          // Detached event history has the same 1 MiB resource bound. Cap the
          // semantic replacement too rather than allowing provider text to grow
          // without limit inside the always-on Brain process.
          const bounded = Buffer.from(text).subarray(0, MAX_DETACHED_EVENT_BYTES_PER_RESOURCE).toString('utf8').replace(/\uFFFD$/, '')
          bridgeTextSnapshots.set(resourceId, { turnId, text: bounded })
        }
      } else if (type === 'turn_end') owner.status = 'completed'
      else if (type === 'user_request') owner.status = 'blocked'
      else if (type === 'user_request_resolved' && owner.status === 'blocked') owner.status = 'running'
      else if (type === 'error') owner.status = 'failed'
      else if (type === 'closed') owner.status = owner.status === 'running' ? 'interrupted' : 'completed'
      else if (type === 'idle_stopped') owner.status = 'completed'
      else if (type === 'ready' && owner.status === 'idle') owner.status = 'idle'
    } else if (String(eventRecord.type ?? '') === 'exit') owner.status = 'completed'
    const session = owner.connectionId ? sessions.get(owner.connectionId) : null
    if (session) sendEncrypted(session, { type: 'event', channel: event.channel, event: event.event })
    else appendDetachedEvent(resourceId, { channel: event.channel, event: event.event })
    if (event.channel === 'bridge' && eventRecord.type === 'idle_stopped') {
      // `idle_stopped` is authoritative backend teardown, not merely an idle
      // status. Keeping its process-local owner record makes the next stable
      // bridge.start "attach" to a resource that no longer exists.
      bridgeOwners.delete(resourceId)
      bridgeTextSnapshots.delete(resourceId)
      detachedEvents.delete(resourceId)
      for (const [requestId, ownerBridgeId] of requestOwners) {
        if (ownerBridgeId === resourceId) requestOwners.delete(requestId)
      }
    }
  })

  const handleRelayMessage = async (raw: WebSocket.RawData): Promise<void> => {
    let frame: HubRelayControlFrame
    try { frame = JSON.parse(raw.toString()) as HubRelayControlFrame } catch { relay?.close(4002, 'invalid Hub relay frame'); return }
    if (frame.type === 'brainReady') return
    if (frame.type === 'connect') {
      const grantedScopes = frame.requestedScopes.filter(scope => policy.allowsScope(scope))
      sessions.set(frame.connectionId, {
        connectionId: frame.connectionId,
        userId: frame.userId,
        grantedScopes: new Set(grantedScopes),
        expectedBrowserSequence: 0,
        brainSequence: 0,
        outboundQueue: [],
        outboundSending: false,
      })
      return
    }
    if (!('connectionId' in frame)) return
    const session = sessions.get(frame.connectionId)
    if (!session) return
    if (frame.type === 'clientHello') {
      if (session.cipher) {
        relay?.send(JSON.stringify({ type: 'close', connectionId: frame.connectionId, reason: 'duplicate end-to-end handshake rejected' } satisfies HubRelayControlFrame))
        sessions.delete(frame.connectionId)
        return
      }
      try {
        session.cipher = createBrainRelayCipher({ connectionId: frame.connectionId, clientKey: frame.key, machinePrivateKey: options.credential.privateKey })
        const hello: HubRelayControlFrame = {
          type: 'serverHello', connectionId: frame.connectionId, key: session.cipher.serverKey,
          signature: session.cipher.signature, grantedScopes: [...session.grantedScopes],
        }
        relay?.send(JSON.stringify(hello))
      } catch {
        relay?.send(JSON.stringify({ type: 'close', connectionId: frame.connectionId, reason: 'end-to-end handshake rejected' } satisfies HubRelayControlFrame))
        sessions.delete(frame.connectionId)
      }
      return
    }
    if (frame.type === 'close') { releaseSession(frame.connectionId); return }
    if (frame.type !== 'encrypted' || !session.cipher) return
    if (frame.sequence !== session.expectedBrowserSequence) {
      relay?.send(JSON.stringify({ type: 'close', connectionId: frame.connectionId, reason: 'encrypted frame sequence rejected' } satisfies HubRelayControlFrame))
      releaseSession(frame.connectionId)
      return
    }
    session.expectedBrowserSequence += 1
    let plaintext: HubTunnelPlaintext
    try { plaintext = JSON.parse(session.cipher.decryptBrowser(frame.sequence, frame.ciphertext)) as HubTunnelPlaintext } catch {
      relay?.send(JSON.stringify({ type: 'close', connectionId: frame.connectionId, reason: 'encrypted frame authentication failed' } satisfies HubRelayControlFrame))
      releaseSession(frame.connectionId)
      return
    }
    if (plaintext.type !== 'rpc') return
    const request = plaintext.request
    if (!request || request.protocolVersion !== CREWCODE_REMOTE_PROTOCOL_VERSION || typeof request.id !== 'string' || !request.id || typeof request.method !== 'string' || !request.params || typeof request.params !== 'object') {
      relay?.send(JSON.stringify({ type: 'close', connectionId: frame.connectionId, reason: 'invalid encrypted RPC envelope' } satisfies HubRelayControlFrame))
      releaseSession(frame.connectionId)
      return
    }
    const scope = brainScopeForMethod(request.method)
    const params = request.params as Record<string, unknown>
    const responseParams = params.response && typeof params.response === 'object' ? params.response as Record<string, unknown> : null
    const responseRequestId = request.method === 'bridge.respondUserRequest' ? String(responseParams?.requestId ?? '') : ''
    const resourceId = request.method.startsWith('pty.') ? String(params.paneId ?? '') : request.method.startsWith('bridge.') ? String(params.bridgeId ?? '') : ''
    const ownerMap = request.method.startsWith('pty.') ? paneOwners : request.method.startsWith('bridge.') && request.method !== 'bridge.respondUserRequest' ? bridgeOwners : null
    const createsResource = request.method === 'pty.create' || request.method === 'bridge.start'
    const existingOwner = ownerMap && resourceId ? ownerMap.get(resourceId) : undefined
    const ownedResourceCount = [...paneOwners.values(), ...bridgeOwners.values()].filter(owner => owner.userId === session.userId).length
    const exceedsResourceLimit = createsResource && !existingOwner && ownedResourceCount >= MAX_OWNED_RESOURCES_PER_USER
    // Execution authority belongs to the authenticated Hub user on this Brain,
    // not to one ephemeral browser websocket. connectionId is event-routing
    // custody only: a same-owner command from a replacement page atomically
    // attaches the resource to that page. Otherwise closing a tab turns a
    // transport lifecycle into an execution lifecycle and strands live agents.
    const ownsResource = existingOwner?.userId === session.userId
    const wrongOwner = !!existingOwner && !ownsResource
    const missingOwner = !!ownerMap && !!resourceId && !createsResource && !existingOwner
    const requestResourceId = responseRequestId ? requestOwners.get(responseRequestId) : undefined
    const requestOwner = requestResourceId ? bridgeOwners.get(requestResourceId) : undefined
    const wrongRequestOwner = !!responseRequestId && requestOwner?.userId !== session.userId
    let response: CrewCodeRemoteResponse
    let replayResourceId = ''
    if (request.method === 'brain.authorization.get') {
      response = { protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id: request.id, ok: true, result: policy.current() }
      sendEncrypted(session, { type: 'rpcResult', response }); return
    } else if (request.method === 'brain.authorization.update') {
      try {
        const previous = policy.current()
        const updated = policy.update({ roots: params.roots, scopes: params.scopes, userId: session.userId })
        backend.updateAllowedWorkspaceRoots(updated.roots)
        const stopped = await backend.stopResources({ terminal: previous.scopes.includes('terminal') && !updated.scopes.includes('terminal'), agent: previous.scopes.includes('agent') && !updated.scopes.includes('agent'), allowedRoots: updated.roots })
        for (const paneId of stopped.paneIds) { paneOwners.delete(paneId); detachedEvents.delete(paneId) }
        for (const bridgeId of stopped.bridgeIds) {
          bridgeOwners.delete(bridgeId); detachedEvents.delete(bridgeId); bridgeTextSnapshots.delete(bridgeId)
          for (const [requestId, ownerBridgeId] of requestOwners) if (ownerBridgeId === bridgeId) requestOwners.delete(requestId)
        }
        for (const activeSession of sessions.values()) for (const granted of [...activeSession.grantedScopes]) if (!policy.allowsScope(granted)) activeSession.grantedScopes.delete(granted)
        response = { protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id: request.id, ok: true, result: { policy: updated, stopped } }
      } catch (error) {
        response = { protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id: request.id, ok: false, error: { code: 'INVALID_REQUEST', message: (error as Error).message } }
      }
      sendEncrypted(session, { type: 'rpcResult', response }); return
    } else if (!scope || !session.grantedScopes.has(scope) || !policy.allowsScope(scope)) {
      response = deniedResponse(request, scope
        ? `Brain authorization does not grant ${scope} for ${request.method}`
        : `Brain authorization does not expose ${request.method}`)
    } else if (request.method === 'bridge.list') {
      const executions = [...bridgeOwners].filter(([, owner]) => owner.userId === session.userId).map(([bridgeId, owner]) => ({
        bridgeId,
        status: owner.status,
        attached: owner.connectionId !== null,
        cwd: owner.cwd,
        provider: owner.provider,
        conversationScopeKey: owner.conversationScopeKey,
        createdAt: owner.createdAt,
        lastEventAt: owner.lastEventAt,
        droppedEvents: owner.droppedEvents,
      }))
      response = { protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id: request.id, ok: true, result: { executions } }
      sendEncrypted(session, { type: 'rpcResult', response })
      return
    } else if (request.method === 'bridge.recoverHistory') {
      const conversationScopeKey = typeof params.conversationScopeKey === 'string' ? params.conversationScopeKey : ''
      if (!resourceId || !conversationScopeKey || conversationScopeKey.length > 512) {
        response = deniedResponse(request, 'A valid local chat scope is required for Brain history recovery')
        sendEncrypted(session, { type: 'rpcResult', response })
        return
      }
      // Machine enrollment is single-owner. The opaque scope comes from that
      // owner's local browser state and is useful after a Brain restart has
      // erased process-resident resource ownership while preserving its local
      // conversation shard. Agent scope is still required above.
      const history = loadConversation(webConversationKey(conversationScopeKey))
      const latestAssistantIndex = latestAssistantMessageIndex(history)
      const latestAssistant = latestAssistantIndex === -1 ? null : {
        index: latestAssistantIndex,
        text: history[latestAssistantIndex]!.content,
        userText: precedingUserText(history, latestAssistantIndex),
      }
      response = { protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id: request.id, ok: true, result: { replayed: latestAssistant !== null, latestAssistant } }
      sendEncrypted(session, { type: 'rpcResult', response })
      if (latestAssistantIndex !== -1) {
        sendEncrypted(session, {
          type: 'event', channel: 'bridge',
          event: { type: 'history_agent', bridgeId: resourceId, turnId: `recovered-${resourceId}-${latestAssistantIndex}`, text: history[latestAssistantIndex]!.content },
        })
      }
      return
    } else if (request.method === 'bridge.replayHistory') {
      const owner = resourceId ? bridgeOwners.get(resourceId) : undefined
      if (!owner || owner.userId !== session.userId || owner.connectionId !== session.connectionId || !owner.conversationScopeKey) {
        response = deniedResponse(request, 'Brain session does not own this agent history')
        sendEncrypted(session, { type: 'rpcResult', response })
        return
      }
      const history = loadConversation(webConversationKey(owner.conversationScopeKey))
      const latestAssistantIndex = latestAssistantMessageIndex(history)
      const latestAssistant = latestAssistantIndex === -1 ? null : {
        index: latestAssistantIndex,
        text: history[latestAssistantIndex]!.content,
        userText: precedingUserText(history, latestAssistantIndex),
      }
      response = { protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id: request.id, ok: true, result: { replayed: latestAssistant !== null, latestAssistant } }
      sendEncrypted(session, { type: 'rpcResult', response })
      if (latestAssistantIndex !== -1) {
        sendEncrypted(session, {
          type: 'event',
          channel: 'bridge',
          event: {
            type: 'history_agent',
            bridgeId: resourceId,
            turnId: `recovered-${resourceId}-${latestAssistantIndex}`,
            text: history[latestAssistantIndex]!.content,
          },
        })
      }
      return
    } else if (request.method === 'bridge.claim' || request.method === 'pty.claim') {
      const idsKey = request.method === 'bridge.claim' ? 'bridgeIds' : 'paneIds'
      const claims = Array.isArray(params[idsKey]) ? (params[idsKey] as unknown[]).map(String).slice(0, 100) : []
      const claimsMap = request.method === 'bridge.claim' ? bridgeOwners : paneOwners
      const claimed: string[] = []
      for (const id of claims) {
        const owner = claimsMap.get(id)
        if (!owner || owner.userId !== session.userId) continue
        // A page refresh can establish its fresh encrypted session before Brain
        // observes the old browser socket closing. Explicit same-owner claim is
        // an atomic custody handoff; otherwise events keep targeting the stale
        // connection and the refreshed page can neither receive nor prompt.
        owner.connectionId = session.connectionId
        claimed.push(id)
      }
      response = { protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id: request.id, ok: true, result: { claimed } }
      sendEncrypted(session, { type: 'rpcResult', response })
      for (const id of claimed) {
        for (const event of detachedEvents.get(id) ?? []) sendEncrypted(session, { type: 'event', channel: event.channel, event: event.event })
        detachedEvents.delete(id)
        const bridgeOwner = request.method === 'bridge.claim' ? bridgeOwners.get(id) : undefined
        const snapshot = bridgeOwner && (bridgeOwner.status === 'running' || bridgeOwner.status === 'blocked')
          ? bridgeTextSnapshots.get(id)
          : undefined
        if (snapshot?.text) {
          sendEncrypted(session, {
            type: 'event', channel: 'bridge',
            event: { type: 'history_agent', bridgeId: id, turnId: snapshot.turnId, text: snapshot.text },
          })
        }
      }
      return
    } else if (exceedsResourceLimit) {
      response = deniedResponse(request, `Brain resource limit of ${MAX_OWNED_RESOURCES_PER_USER} terminals and agents reached`)
    } else if (request.method === 'bridge.start' && params.freshSession !== true && ownsResource) {
      // Stable browser bridge ids make start an idempotent same-owner attach as
      // well as a create operation. This is also the recovery fallback when a
      // restored page misses its eager bridge.claim (for example, because the
      // old socket still looked attached during startup). Explicit claim is an
      // optimization for replaying buffered events, not a prerequisite for the
      // owner's next prompt. Taking custody here is no broader than bridge.claim,
      // which already permits an atomic same-owner handoff from a stale socket.
      existingOwner.connectionId = session.connectionId
      replayResourceId = resourceId
      response = { protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id: request.id, ok: true, result: { ok: true, attached: true } }
    } else if (wrongOwner || missingOwner || wrongRequestOwner) {
      response = deniedResponse(request, 'Authenticated Hub user does not own this Brain resource')
    } else {
      // Any operation by the durable owner attaches event routing to the
      // replacement browser before backend work can emit. The prior connection
      // may still be open during a refresh; it no longer owns execution.
      if (existingOwner && ownsResource) existingOwner.connectionId = session.connectionId
      if (requestOwner?.userId === session.userId) requestOwner.connectionId = session.connectionId
      // Reserve caller-chosen resource ids before invoking the backend. PTY and
      // agent implementations may emit their first event before create/start
      // resolves; claiming afterward drops that event and leaves the UI stuck.
      if (ownerMap && resourceId && createsResource) ownerMap.set(resourceId, {
        userId: session.userId,
        connectionId: session.connectionId,
        createdAt: Date.now(),
        lastEventAt: Date.now(),
        status: 'idle',
        cwd: typeof params.cwd === 'string' ? params.cwd : undefined,
        provider: typeof params.provider === 'string' ? params.provider : undefined,
        conversationScopeKey: typeof params.conversationScopeKey === 'string' ? params.conversationScopeKey : undefined,
        droppedEvents: 0,
      })
      try {
        const result = await fetch(`${backend.url}/api/v1/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${backendToken}` },
          body: JSON.stringify(request),
        })
        response = await result.json() as CrewCodeRemoteResponse
        const semanticResult = response.ok && response.result && typeof response.result === 'object'
          ? response.result as { ok?: boolean; error?: unknown }
          : null
        const created = response.ok && semanticResult?.ok !== false && !semanticResult?.error
        const reservedOwner = ownerMap && resourceId ? ownerMap.get(resourceId) : undefined
        if (!created && ownerMap && resourceId && createsResource && reservedOwner?.connectionId === session.connectionId) ownerMap.delete(resourceId)
        if (created && request.method === 'pty.create' && resourceId) detachedEvents.delete(resourceId)
        if (response.ok && responseRequestId) requestOwners.delete(responseRequestId)
        if (response.ok && (request.method === 'bridge.stop' || request.method === 'pty.kill') && ownerMap && resourceId) {
          ownerMap.delete(resourceId)
          detachedEvents.delete(resourceId)
          if (request.method === 'bridge.stop') {
            bridgeTextSnapshots.delete(resourceId)
            for (const [requestId, ownerResourceId] of requestOwners) {
              if (ownerResourceId === resourceId) requestOwners.delete(requestId)
            }
          }
        }
      } catch (error) {
        const reservedOwner = ownerMap && resourceId ? ownerMap.get(resourceId) : undefined
        if (ownerMap && resourceId && createsResource && reservedOwner?.connectionId === session.connectionId) ownerMap.delete(resourceId)
        response = {
          protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id: request.id, ok: false,
          error: { code: 'INTERNAL', message: `Brain RPC failed: ${(error as Error).message}` },
        }
      }
    }
    // A backend request may outlive its browser transport. Its execution and
    // events remain in Brain custody, but the interrupted RPC result belongs to
    // the released logical session and must never be emitted onto the shared
    // Brain socket as an unknown/stale connection frame.
    if (sessions.get(session.connectionId) !== session) return
    sendEncrypted(session, { type: 'rpcResult', response })
    if (replayResourceId) {
      for (const event of detachedEvents.get(replayResourceId) ?? []) sendEncrypted(session, { type: 'event', channel: event.channel, event: event.event })
      detachedEvents.delete(replayResourceId)
    }
  }

  const connectRelay = (): Promise<void> => {
    const socket = new WebSocket(websocketOrigin(options.credential.hubOrigin), ['crewcode.brain.v1', options.credential.token])
    relay = socket
    socket.on('message', raw => { void handleRelayMessage(raw) })
    // The close handler owns retry. Keep an error listener installed so a failed
    // reconnect cannot become an uncaught EventEmitter error.
    socket.on('error', () => undefined)
    socket.on('close', () => {
      if (relay !== socket) return
      relay = null
      // Detach only browser routing. Provider execution and the loopback event
      // socket stay alive while the persistent Brain reconnects to the Hub.
      for (const connectionId of [...sessions.keys()]) releaseSession(connectionId)
      if (closing) {
        eventSocket.close()
        void closeBackend().finally(closeResolve)
        return
      }
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void connectRelay().catch(() => undefined)
      }, 5_000)
    })
    return new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
  }
  // Local desktop custody must not depend on Hub reachability. Start the
  // outbound connector in the background; its close handler owns bounded retry
  // while the loopback backend and provider processes stay alive.
  void connectRelay().catch(() => undefined)

  return {
    closed,
    async close() {
      if (closing) return closed
      closing = true
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      if (relay?.readyState === WebSocket.OPEN || relay?.readyState === WebSocket.CONNECTING) relay.close(1000, 'brain stopping')
      eventSocket.close()
      await closeBackend()
      if (!relay || relay.readyState === WebSocket.CLOSED) closeResolve()
      await closed
    },
  }
}

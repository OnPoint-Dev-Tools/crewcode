import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  hkdfSync,
  verify,
} from 'crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'fs'
import { createServer } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { brainScopeForMethod, startBrainRelay, type RunningBrainRelay } from './hub-brain-relay'
import { HubConnectionTicketIssuer } from './hub-connection-tickets'
import { HUB_CONNECTION_TICKET_TTL_MS } from '../shared/hub-relay-types'
import type { MachineCredentialFile } from './hub-machine-enrollment'
import { startHubServer, type RunningHubServer } from './hub-server'
import { HubStore } from './hub-store'
import type { HubRelayControlFrame, HubTunnelPlaintext } from '../shared/hub-relay-types'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

function directory(): string {
  const value = realpathSync(mkdtempSync(join(tmpdir(), 'crewcode-hub-relay-')))
  cleanups.push(() => {
    try { rmSync(value, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } catch { /* Windows may keep SQLite/PTY handles briefly */ }
  })
  return value
}

async function fixture(scopes: Array<'workspace:read' | 'workspace:write' | 'terminal' | 'agent'>): Promise<{
  hub: RunningHubServer
  brain: RunningBrainRelay
  machineId: string
  machineToken: string
  cookie: string
  csrf: string
  publicKey: string
  workspaceRoot: string
}> {
  const hubData = directory()
  const brainData = directory()
  const workspaceRoot = directory()
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url')
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64url')
  const store = new HubStore(join(hubData, 'hub.sqlite'))
  const owner = store.createOwnerWithCredential({
    username: 'Owner', credential: { id: 'credential', publicKey: new Uint8Array([1]), counter: 0 },
    deviceType: 'singleDevice', backedUp: false, now: 1_000,
  })
  const session = store.createSession(owner.id, 1_000, 60_000)
  const enrolled = store.createMachine({ userId: owner.id, publicKey, name: 'brain', platform: 'linux', version: 'test', now: 1_000 })
  store.close()
  const hub = await startHubServer({ dataDir: hubData, port: 0, now: () => 2_000 })
  cleanups.push(() => hub.close())
  const credential: MachineCredentialFile = {
    version: 1, hubOrigin: hub.url, machineId: enrolled.machine.id, token: enrolled.token,
    publicKey, privateKey, enrolledAt: 1_000,
  }
  const brain = await startBrainRelay({ credential, dataDir: brainData, allowedWorkspaceRoots: [workspaceRoot], allowedScopes: scopes })
  cleanups.push(() => brain.close())
  return { hub, brain, machineId: enrolled.machine.id, machineToken: enrolled.token, cookie: `crewcode_hub_session=${encodeURIComponent(session.token)}`, csrf: session.csrf, publicKey, workspaceRoot }
}

function onceFrame(socket: WebSocket, predicate: (frame: HubRelayControlFrame) => boolean): Promise<HubRelayControlFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('relay frame timeout')), 10_000)
    const onMessage = (raw: WebSocket.RawData): void => {
      const frame = JSON.parse(raw.toString()) as HubRelayControlFrame
      if (!predicate(frame)) return
      clearTimeout(timeout)
      socket.off('message', onMessage)
      resolve(frame)
    }
    socket.on('message', onMessage)
  })
}

function relayNonce(direction: 'browser' | 'brain', sequence: number): Buffer {
  const value = Buffer.alloc(12)
  value.writeUInt32BE(direction === 'browser' ? 0x42525752 : 0x4252414e, 0)
  value.writeBigUInt64BE(BigInt(sequence), 4)
  return value
}

async function openEncryptedSession(input: {
  hub: RunningHubServer
  ticket: string
  machineId: string
  publicKey: string
}): Promise<{
  rpc(request: { protocolVersion: 1; id: string; method: string; params: Record<string, unknown> }): Promise<HubTunnelPlaintext>
  nextEvent(predicate?: (event: Extract<HubTunnelPlaintext, { type: 'event' }>) => boolean): Promise<Extract<HubTunnelPlaintext, { type: 'event' }>>
  close(): Promise<void>
}> {
  const socket = new WebSocket(input.hub.url.replace(/^http/, 'ws') + '/api/v1/hub/relay', ['crewcode.browser.v1', input.ticket], { origin: input.hub.publicOrigin })
  const readyFrame = onceFrame(socket, frame => frame.type === 'ready')
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const ready = await readyFrame.catch(error => { throw new Error(`browser relay ready failed: ${(error as Error).message}`) })
  if (ready.type !== 'ready') throw new Error('missing ready')
  expect(ready.machineId).toBe(input.machineId)
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const clientKey = ecdh.getPublicKey().toString('base64url')
  const helloFrame = onceFrame(socket, frame => frame.type === 'serverHello')
  socket.send(JSON.stringify({ type: 'clientHello', connectionId: ready.connectionId, key: clientKey } satisfies HubRelayControlFrame))
  const hello = await helloFrame.catch(error => { throw new Error(`Brain end-to-end hello failed: ${(error as Error).message}`) })
  if (hello.type !== 'serverHello') throw new Error('missing server hello')
  const transcript = Buffer.from(`crewcode-hub-relay-v1\0${ready.connectionId}\0${clientKey}\0${hello.key}`)
  const machineKey = createPublicKey({ key: Buffer.from(input.publicKey, 'base64url'), type: 'spki', format: 'der' })
  expect(verify(null, transcript, machineKey, Buffer.from(hello.signature, 'base64url'))).toBe(true)
  const shared = ecdh.computeSecret(Buffer.from(hello.key, 'base64url'))
  const salt = createHash('sha256').update(transcript).digest()
  const browserKey = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('browser-to-brain'), 32))
  const brainKey = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('brain-to-browser'), 32))
  let browserSequence = 0
  let expectedBrainSequence = 0
  const pending = new Map<string, (message: HubTunnelPlaintext) => void>()
  type RelayEvent = Extract<HubTunnelPlaintext, { type: 'event' }>
  const bufferedEvents: RelayEvent[] = []
  const eventWaiters: Array<{ predicate: (event: RelayEvent) => boolean; resolve: (event: RelayEvent) => void }> = []
  let chain = Promise.resolve()
  socket.on('message', raw => {
    chain = chain.then(async () => {
      const frame = JSON.parse(raw.toString()) as HubRelayControlFrame
      if (frame.type !== 'encrypted') return
      expect(frame.sequence).toBe(expectedBrainSequence++)
      const encoded = Buffer.from(frame.ciphertext, 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', brainKey, relayNonce('brain', frame.sequence))
      decipher.setAAD(Buffer.from(`${ready.connectionId}\0brain\0${frame.sequence}`))
      decipher.setAuthTag(encoded.subarray(-16))
      const message = JSON.parse(Buffer.concat([decipher.update(encoded.subarray(0, -16)), decipher.final()]).toString()) as HubTunnelPlaintext
      if (message.type === 'rpcResult') {
        pending.get(message.response.id)?.(message)
        pending.delete(message.response.id)
      } else if (message.type === 'event') {
        const waiterIndex = eventWaiters.findIndex(waiter => waiter.predicate(message))
        if (waiterIndex === -1) bufferedEvents.push(message)
        else eventWaiters.splice(waiterIndex, 1)[0]!.resolve(message)
      }
    })
  })
  return {
    rpc(request) {
      const plaintext: HubTunnelPlaintext = { type: 'rpc', request }
      const sequence = browserSequence++
      const cipher = createCipheriv('aes-256-gcm', browserKey, relayNonce('browser', sequence))
      cipher.setAAD(Buffer.from(`${ready.connectionId}\0browser\0${sequence}`))
      const body = Buffer.concat([cipher.update(JSON.stringify(plaintext)), cipher.final(), cipher.getAuthTag()])
      return new Promise(resolve => {
        pending.set(request.id, resolve)
        socket.send(JSON.stringify({ type: 'encrypted', connectionId: ready.connectionId, sequence, ciphertext: body.toString('base64url') } satisfies HubRelayControlFrame))
      })
    },
    nextEvent(predicate = () => true) {
      const bufferedIndex = bufferedEvents.findIndex(predicate)
      if (bufferedIndex !== -1) return Promise.resolve(bufferedEvents.splice(bufferedIndex, 1)[0]!)
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve: (event: RelayEvent) => { clearTimeout(timeout); resolve(event) } }
        const timeout = setTimeout(() => {
          const index = eventWaiters.indexOf(waiter)
          if (index !== -1) eventWaiters.splice(index, 1)
          reject(new Error('encrypted relay event timeout'))
        }, 10_000)
        eventWaiters.push(waiter)
      })
    },
    close: () => new Promise(resolve => {
      if (socket.readyState === WebSocket.CLOSED) { resolve(); return }
      socket.once('close', () => resolve())
      socket.close(1000, 'test browser disconnected')
    }),
  }
}

async function encryptedRpc(input: {
  hub: RunningHubServer
  ticket: string
  machineId: string
  publicKey: string
  request: { protocolVersion: 1; id: string; method: string; params: Record<string, unknown> }
}): Promise<HubTunnelPlaintext> {
  const socket = new WebSocket(input.hub.url.replace(/^http/, 'ws') + '/api/v1/hub/relay', ['crewcode.browser.v1', input.ticket], { origin: input.hub.publicOrigin })
  const readyFrame = onceFrame(socket, frame => frame.type === 'ready')
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const ready = await readyFrame.catch(error => { throw new Error(`browser relay ready failed: ${(error as Error).message}`) })
  if (ready.type !== 'ready') throw new Error('missing ready')
  expect(ready.machineId).toBe(input.machineId)
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const clientKey = ecdh.getPublicKey().toString('base64url')
  const helloFrame = onceFrame(socket, frame => frame.type === 'serverHello')
  socket.send(JSON.stringify({ type: 'clientHello', connectionId: ready.connectionId, key: clientKey } satisfies HubRelayControlFrame))
  const hello = await helloFrame.catch(error => { throw new Error(`Brain end-to-end hello failed: ${(error as Error).message}`) })
  if (hello.type !== 'serverHello') throw new Error('missing server hello')
  const transcript = Buffer.from(`crewcode-hub-relay-v1\0${ready.connectionId}\0${clientKey}\0${hello.key}`)
  const machineKey = createPublicKey({ key: Buffer.from(input.publicKey, 'base64url'), type: 'spki', format: 'der' })
  expect(verify(null, transcript, machineKey, Buffer.from(hello.signature, 'base64url'))).toBe(true)
  const shared = ecdh.computeSecret(Buffer.from(hello.key, 'base64url'))
  const salt = createHash('sha256').update(transcript).digest()
  const browserKey = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('browser-to-brain'), 32))
  const brainKey = Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from('brain-to-browser'), 32))
  const plaintext: HubTunnelPlaintext = { type: 'rpc', request: input.request }
  const cipher = createCipheriv('aes-256-gcm', browserKey, relayNonce('browser', 0))
  cipher.setAAD(Buffer.from(`${ready.connectionId}\0browser\0${0}`))
  const body = Buffer.concat([cipher.update(JSON.stringify(plaintext)), cipher.final(), cipher.getAuthTag()])
  const encryptedFrame = onceFrame(socket, frame => frame.type === 'encrypted')
  socket.send(JSON.stringify({ type: 'encrypted', connectionId: ready.connectionId, sequence: 0, ciphertext: body.toString('base64url') } satisfies HubRelayControlFrame))
  const encrypted = await encryptedFrame
  if (encrypted.type !== 'encrypted') throw new Error('missing encrypted response')
  const encoded = Buffer.from(encrypted.ciphertext, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', brainKey, relayNonce('brain', encrypted.sequence))
  decipher.setAAD(Buffer.from(`${ready.connectionId}\0brain\0${encrypted.sequence}`))
  decipher.setAuthTag(encoded.subarray(-16))
  const decoded = Buffer.concat([decipher.update(encoded.subarray(0, -16)), decipher.final()]).toString()
  socket.close()
  return JSON.parse(decoded) as HubTunnelPlaintext
}

describe('Brain-local RPC authorization', () => {
  it('classifies workspace, terminal, and agent methods without a permissive fallback', () => {
    expect(brainScopeForMethod('workspaces.list')).toBe('workspace:read')
    expect(brainScopeForMethod('git.conflictDiff')).toBe('workspace:read')
    expect(brainScopeForMethod('fs.writeFile')).toBe('workspace:write')
    expect(brainScopeForMethod('pty.create')).toBe('terminal')
    expect(brainScopeForMethod('attachments.chunk')).toBe('workspace:write')
    expect(brainScopeForMethod('bridge.prompt')).toBe('agent')
    expect(brainScopeForMethod('mcp.list')).toBe('agent')
    expect(brainScopeForMethod('voice.transcribe')).toBe('agent')
    expect(brainScopeForMethod('transcripts.recent')).toBe('agent')
    expect(brainScopeForMethod('delegation.disable')).toBe('agent')
     expect(brainScopeForMethod('github.status')).toBe('workspace:read')
     expect(brainScopeForMethod('github.prCatalogue')).toBe('workspace:read')
      expect(brainScopeForMethod('github.prDetail')).toBe('workspace:read')
     expect(brainScopeForMethod('github.prDiff')).toBe('workspace:read')
     expect(brainScopeForMethod('github.prReviewContext')).toBe('workspace:read')
     expect(brainScopeForMethod('github.prManagementContext')).toBe('workspace:read')
     expect(brainScopeForMethod('github.prChecksContext')).toBe('workspace:read')
     expect(brainScopeForMethod('github.prCheckLog')).toBe('workspace:read')
     expect(brainScopeForMethod('github.avatar')).toBe('workspace:read')
    expect(brainScopeForMethod('gh.prMerge')).toBe('workspace:write')
    expect(brainScopeForMethod('gh.prReady')).toBe('workspace:write')
    expect(brainScopeForMethod('gh.prDraft')).toBe('workspace:write')
    expect(brainScopeForMethod('gh.prReopen')).toBe('workspace:write')
    expect(brainScopeForMethod('gh.prEdit')).toBe('workspace:write')
    expect(brainScopeForMethod('gh.prMetadata')).toBe('workspace:write')
    expect(brainScopeForMethod('gh.prCheckRerun')).toBe('workspace:write')
    expect(brainScopeForMethod('gh.prMergeAutomation')).toBe('workspace:write')
    expect(brainScopeForMethod('gh.prPrepareConflictResolution')).toBe('workspace:write')
    expect(brainScopeForMethod('gh.prReview')).toBe('workspace:write')
    expect(brainScopeForMethod('gh.prViewedFile')).toBe('workspace:write')
    expect(brainScopeForMethod('gh.prReviewThread')).toBe('workspace:write')
    expect(brainScopeForMethod('continuity.get')).toBe('workspace:read')
    expect(brainScopeForMethod('continuity.update')).toBe('workspace:write')
    expect(brainScopeForMethod('unknown.execute')).toBeNull()
  })
})

describe('Hub connection tickets', () => {
  it('are short-lived, one-shot, and consume a guessed id', () => {
    let now = 1_000
    const issuer = new HubConnectionTicketIssuer(() => now)
    const first = issuer.issue({ userId: 'user', browserSessionId: 'session', machineId: 'machine', requestedScopes: ['workspace:read'] })
    expect(first.expiresAt).toBe(now + HUB_CONNECTION_TICKET_TTL_MS)
    expect(HUB_CONNECTION_TICKET_TTL_MS).toBe(60_000)
    expect(issuer.consume(first.ticket)).toMatchObject({ userId: 'user', requestedScopes: ['workspace:read'] })
    expect(issuer.consume(first.ticket)).toBeNull()
    const guessed = issuer.issue({ userId: 'user', browserSessionId: 'session', machineId: 'machine', requestedScopes: [] })
    expect(issuer.consume(`${guessed.ticket.split('.')[0]}.wrong`)).toBeNull()
    expect(issuer.consume(guessed.ticket)).toBeNull()
    const expired = issuer.issue({ userId: 'user', browserSessionId: 'session', machineId: 'machine', requestedScopes: [] })
    now = expired.expiresAt
    expect(issuer.consume(expired.ticket)).toBeNull()
  })
})

describe('authenticated encrypted Hub relay', () => {
  it('routes encrypted RPC while the Brain independently denies ungranted scope', async () => {
    const { hub, machineId, cookie, csrf, publicKey } = await fixture([])
    const ticketResponse = await fetch(`${hub.url}/api/v1/hub/machines/${machineId}/tickets`, {
      method: 'POST', headers: { cookie, 'x-crewcode-csrf': csrf, 'content-type': 'application/json', origin: hub.publicOrigin },
      body: JSON.stringify({ requestedScopes: ['workspace:read'] }),
    })
    expect(ticketResponse.status).toBe(201)
    const { ticket } = await ticketResponse.json() as { ticket: string }
    const result = await encryptedRpc({ hub, ticket, machineId, publicKey, request: { protocolVersion: 1, id: 'denied', method: 'workspaces.list', params: {} } })
    expect(result).toMatchObject({ type: 'rpcResult', response: { id: 'denied', ok: false, error: { code: 'FORBIDDEN' } } })
  })

  it('starts the headless agent boundary without depending on Electron app paths', async () => {
    const { hub, machineId, cookie, csrf, publicKey, workspaceRoot } = await fixture(['workspace:write', 'agent'])
    const issue = async (requestedScopes: Array<'workspace:write' | 'agent'>): Promise<string> => {
      const response = await fetch(`${hub.url}/api/v1/hub/machines/${machineId}/tickets`, {
        method: 'POST', headers: { cookie, 'x-crewcode-csrf': csrf, 'content-type': 'application/json', origin: hub.publicOrigin },
        body: JSON.stringify({ requestedScopes }),
      })
      return ((await response.json()) as { ticket: string }).ticket
    }
    const added = await encryptedRpc({
      hub, ticket: await issue(['workspace:write']), machineId, publicKey,
      request: { protocolVersion: 1, id: 'add', method: 'workspaces.add', params: { path: workspaceRoot } },
    })
    expect(added).toMatchObject({ type: 'rpcResult', response: { ok: true } })
    const started = await encryptedRpc({
      hub, ticket: await issue(['agent']), machineId, publicKey,
      request: {
        protocolVersion: 1, id: 'agent', method: 'bridge.start',
        params: { bridgeId: 'browser-agent', provider: 'openrouter', cwd: workspaceRoot, conversationScopeKey: 'test-session' },
      },
    })
    expect(started).toMatchObject({
      type: 'rpcResult',
      response: { ok: true, result: { error: 'openrouter API key not set' } },
    })
  })

  it('closes only the abusive logical connection when its frame budget is exhausted', async () => {
    const { hub, brain, machineId, machineToken, cookie, csrf } = await fixture([])
    await brain.close()
    const rawBrain = new WebSocket(hub.url.replace(/^http/, 'ws') + '/api/v1/hub/relay', ['crewcode.brain.v1', machineToken])
    const brainReady = onceFrame(rawBrain, frame => frame.type === 'brainReady')
    await new Promise<void>((resolve, reject) => { rawBrain.once('open', resolve); rawBrain.once('error', reject) })
    await brainReady

    const issue = async (): Promise<string> => {
      const response = await fetch(`${hub.url}/api/v1/hub/machines/${machineId}/tickets`, {
        method: 'POST', headers: { cookie, 'x-crewcode-csrf': csrf, 'content-type': 'application/json', origin: hub.publicOrigin },
        body: JSON.stringify({ requestedScopes: [] }),
      })
      return ((await response.json()) as { ticket: string }).ticket
    }
    const open = async (ticket: string): Promise<{ socket: WebSocket; ready: Extract<HubRelayControlFrame, { type: 'ready' }> }> => {
      const socket = new WebSocket(hub.url.replace(/^http/, 'ws') + '/api/v1/hub/relay', ['crewcode.browser.v1', ticket], { origin: hub.publicOrigin })
      const readyFrame = onceFrame(socket, frame => frame.type === 'ready')
      await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      return { socket, ready: await readyFrame as Extract<HubRelayControlFrame, { type: 'ready' }> }
    }

    const first = await open(await issue())
    const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
      first.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
      first.socket.once('error', reject)
    })
    for (let index = 0; index < 300; index += 1) {
      first.socket.send(JSON.stringify({ type: 'clientHello', connectionId: first.ready.connectionId, key: 'flood' } satisfies HubRelayControlFrame))
    }
    await expect(closed).resolves.toEqual({ code: 4011, reason: 'frame rate limit' })

    // The Brain WebSocket multiplexes sessions and must survive one browser's
    // traffic violation; a fresh ticket can still establish another session.
    const second = await open(await issue())
    expect(second.ready.machineId).toBe(machineId)
    second.socket.close()
    rawBrain.close()
  })

  it('detaches a terminal on browser loss and explicitly reclaims the live process', async () => {
    const { hub, machineId, machineToken, cookie, csrf, publicKey, workspaceRoot } = await fixture(['workspace:write', 'terminal'])
    const issue = async (): Promise<string> => {
      const response = await fetch(`${hub.url}/api/v1/hub/machines/${machineId}/tickets`, {
        method: 'POST', headers: { cookie, 'x-crewcode-csrf': csrf, 'content-type': 'application/json', origin: hub.publicOrigin },
        body: JSON.stringify({ requestedScopes: ['workspace:write', 'terminal'] }),
      })
      return ((await response.json()) as { ticket: string }).ticket
    }
    const first = await openEncryptedSession({ hub, ticket: await issue(), machineId, publicKey })
    await expect(first.rpc({ protocolVersion: 1, id: 'add-custody-root', method: 'workspaces.add', params: { path: workspaceRoot } }))
      .resolves.toMatchObject({ type: 'rpcResult', response: { ok: true } })
    await expect(first.rpc({ protocolVersion: 1, id: 'create-custody-pty', method: 'pty.create', params: { paneId: 'durable-pane', cwd: workspaceRoot, shell: '/bin/sh' } }))
      .resolves.toMatchObject({ type: 'rpcResult', response: { ok: true, result: { ok: true, pid: expect.any(Number) } } })
    await first.close()

    // A transient shared Hub relay replacement must not tear down Brain-local
    // execution either. The Brain reconnects its transport while retaining the
    // same backend and PTY/provider registry.
    const replacement = new WebSocket(hub.url.replace(/^http/, 'ws') + '/api/v1/hub/relay', ['crewcode.brain.v1', machineToken])
    await new Promise<void>((resolve, reject) => { replacement.once('open', resolve); replacement.once('error', reject) })
    await new Promise<void>(resolve => { replacement.once('close', () => resolve()); replacement.close(1000, 'test transport replacement') })
    await new Promise(resolve => setTimeout(resolve, 5_250))

    const second = await openEncryptedSession({ hub, ticket: await issue(), machineId, publicKey })
    // The durable Hub owner can operate its Brain-owned process immediately;
    // explicit claim only controls eager event replay and is not authorization.
    await expect(second.rpc({ protocolVersion: 1, id: 'write-before-custody-claim', method: 'pty.write', params: { paneId: 'durable-pane', data: 'echo still-alive\n' } }))
      .resolves.toMatchObject({ type: 'rpcResult', response: { ok: true } })
    await expect(second.rpc({ protocolVersion: 1, id: 'claim-custody-pty', method: 'pty.claim', params: { paneIds: ['durable-pane'] } }))
      .resolves.toMatchObject({ type: 'rpcResult', response: { ok: true, result: { claimed: ['durable-pane'] } } })
    await expect(second.rpc({ protocolVersion: 1, id: 'reattach-custody-pty', method: 'pty.create', params: { paneId: 'durable-pane', cwd: workspaceRoot, shell: '/bin/sh' } }))
      .resolves.toMatchObject({ type: 'rpcResult', response: { ok: true, result: { ok: true, attached: true } } })
    await second.rpc({ protocolVersion: 1, id: 'stop-custody-pty', method: 'pty.kill', params: { paneId: 'durable-pane' } })
    await second.close()
  })

  it('keeps an agent prompt running after browser loss and replays its reply only after explicit reclaim', async () => {
    let releaseReply!: () => void
    let requestStartedResolve!: () => void
    const replyReleased = new Promise<void>(resolve => { releaseReply = resolve })
    const requestStarted = new Promise<void>(resolve => { requestStartedResolve = resolve })
    let requestCount = 0
    const ollama = createServer(async (request, response) => {
      if (request.url !== '/api/chat') { response.writeHead(404).end(); return }
      requestCount += 1
      requestStartedResolve()
      await replyReleased
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.end([
        JSON.stringify({ message: { role: 'assistant', content: 'finished while detached' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 3, eval_count: 3 }),
        '',
      ].join('\n'))
    })
    await new Promise<void>((resolve, reject) => {
      ollama.once('error', reject)
      ollama.listen(0, '127.0.0.1', resolve)
    })
    cleanups.push(() => new Promise<void>(resolve => ollama.close(() => resolve())))
    const address = ollama.address()
    if (!address || typeof address === 'string') throw new Error('fake Ollama did not bind a TCP port')
    const previousOllamaHost = process.env.OLLAMA_HOST
    process.env.OLLAMA_HOST = `http://127.0.0.1:${address.port}`
    cleanups.push(() => {
      if (previousOllamaHost === undefined) delete process.env.OLLAMA_HOST
      else process.env.OLLAMA_HOST = previousOllamaHost
    })

    const { hub, machineId, cookie, csrf, publicKey, workspaceRoot } = await fixture(['workspace:write', 'agent'])
    const issue = async (): Promise<string> => {
      const response = await fetch(`${hub.url}/api/v1/hub/machines/${machineId}/tickets`, {
        method: 'POST', headers: { cookie, 'x-crewcode-csrf': csrf, 'content-type': 'application/json', origin: hub.publicOrigin },
        body: JSON.stringify({ requestedScopes: ['workspace:write', 'agent'] }),
      })
      const body = await response.json() as { ticket?: string; error?: string }
      if (!response.ok || !body.ticket) throw new Error(`ticket issuance failed (${response.status}): ${body.error ?? 'missing ticket'}`)
      return body.ticket
    }
    const bridgeId = 'detached-agent'
    const first = await openEncryptedSession({ hub, ticket: await issue(), machineId, publicKey })
    await expect(first.rpc({ protocolVersion: 1, id: 'add-detached-root', method: 'workspaces.add', params: { path: workspaceRoot } }))
      .resolves.toMatchObject({ type: 'rpcResult', response: { ok: true } })
    const started = await first.rpc({
      protocolVersion: 1, id: 'start-detached-agent', method: 'bridge.start',
      params: { bridgeId, provider: 'ollama', model: 'fake-model', cwd: workspaceRoot, conversationScopeKey: 'detached-chat' },
    })
    if (started.type !== 'rpcResult' || !started.response.ok) throw new Error(`bridge.start failed: ${JSON.stringify(started)}`)
    expect(started).toMatchObject({ type: 'rpcResult', response: { result: { ok: true } } })

    // Keep the old browser connection open to reproduce a real refresh race:
    // the replacement page can connect before Brain observes pagehide/socket
    // close. The prompt must transfer without restarting the provider.
    void first.rpc({ protocolVersion: 1, id: 'detached-prompt', method: 'bridge.prompt', params: { bridgeId, text: 'complete later' } })
    await requestStarted

    const second = await openEncryptedSession({ hub, ticket: await issue(), machineId, publicKey })
    await expect(second.rpc({ protocolVersion: 1, id: 'claim-detached-agent', method: 'bridge.claim', params: { bridgeIds: [bridgeId] } }))
      .resolves.toMatchObject({ type: 'rpcResult', response: { ok: true, result: { claimed: [bridgeId] } } })
    // A restored renderer can issue its stable start after WebConnectionScreen
    // has already claimed the resource. That start must remain an idempotent
    // attach; forwarding it would make AgentBridgeService.start stop the live
    // provider before replacing it.
    await expect(second.rpc({
      protocolVersion: 1, id: 'reattach-claimed-agent', method: 'bridge.start',
      params: { bridgeId, provider: 'ollama', model: 'fake-model', cwd: workspaceRoot, conversationScopeKey: 'detached-chat' },
    })).resolves.toMatchObject({ type: 'rpcResult', response: { ok: true, result: { ok: true, attached: true } } })
    releaseReply()
    const replayedText = await second.nextEvent(message => message.channel === 'bridge'
      && (message.event as { type?: string; bridgeId?: string; delta?: string }).type === 'text_delta'
      && (message.event as { bridgeId?: string }).bridgeId === bridgeId)
    expect(replayedText).toMatchObject({
      type: 'event', channel: 'bridge',
      event: { type: 'text_delta', bridgeId, delta: 'finished while detached' },
    })
    expect(requestCount).toBe(1)
    await expect(second.rpc({ protocolVersion: 1, id: 'durable-history-data', method: 'bridge.replayHistory', params: { bridgeId } }))
      .resolves.toMatchObject({
        type: 'rpcResult',
        response: { ok: true, result: { replayed: true, latestAssistant: { text: 'finished while detached', userText: 'complete later' } } },
      })
    // Closing the superseded connection after handoff must not detach the new
    // owner or make its next operation fail ownership checks.
    await first.close()
    await expect(second.rpc({ protocolVersion: 1, id: 'compact-after-handoff', method: 'bridge.compact', params: { bridgeId } }))
      .resolves.toMatchObject({ type: 'rpcResult', response: { ok: true } })

    // Recovery must not depend on eager claim or reissuing bridge.start. The
    // agent belongs to the authenticated Hub owner, while browser connection
    // ids only decide where subsequent live events are routed.
    const third = await openEncryptedSession({ hub, ticket: await issue(), machineId, publicKey })
    await second.close()
    await expect(third.rpc({ protocolVersion: 1, id: 'prompt-after-page-return', method: 'bridge.prompt', params: { bridgeId, text: 'continue working' } }))
      .resolves.toMatchObject({ type: 'rpcResult', response: { ok: true, result: { ok: true } } })
    expect(requestCount).toBe(2)
    await third.rpc({ protocolVersion: 1, id: 'stop-detached-agent', method: 'bridge.stop', params: { bridgeId } })
    await third.close()
  })

  it('replaces browser-persisted partial text with the Brain snapshot after close', async () => {
    let releaseFinal!: () => void
    let firstChunkResolve!: () => void
    const releaseFinalChunk = new Promise<void>(resolve => { releaseFinal = resolve })
    const firstChunkWritten = new Promise<void>(resolve => { firstChunkResolve = resolve })
    let requestCount = 0
    const ollama = createServer(async (request, response) => {
      if (request.url !== '/api/chat') { response.writeHead(404).end(); return }
      requestCount += 1
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      response.write(JSON.stringify({ message: { role: 'assistant', content: 'The Nephilim are ' }, done: false }) + '\n')
      firstChunkResolve()
      await releaseFinalChunk
      response.end([
        JSON.stringify({ message: { role: 'assistant', content: 'mysterious figures mentioned in ancient texts.' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 3, eval_count: 8 }),
        '',
      ].join('\n'))
    })
    await new Promise<void>((resolve, reject) => {
      ollama.once('error', reject)
      ollama.listen(0, '127.0.0.1', resolve)
    })
    cleanups.push(() => new Promise<void>(resolve => ollama.close(() => resolve())))
    const address = ollama.address()
    if (!address || typeof address === 'string') throw new Error('fake Ollama did not bind a TCP port')
    const previousOllamaHost = process.env.OLLAMA_HOST
    process.env.OLLAMA_HOST = `http://127.0.0.1:${address.port}`
    cleanups.push(() => {
      if (previousOllamaHost === undefined) delete process.env.OLLAMA_HOST
      else process.env.OLLAMA_HOST = previousOllamaHost
    })

    const { hub, machineId, cookie, csrf, publicKey, workspaceRoot } = await fixture(['workspace:write', 'agent'])
    const issue = async (): Promise<string> => {
      const response = await fetch(`${hub.url}/api/v1/hub/machines/${machineId}/tickets`, {
        method: 'POST', headers: { cookie, 'x-crewcode-csrf': csrf, 'content-type': 'application/json', origin: hub.publicOrigin },
        body: JSON.stringify({ requestedScopes: ['workspace:write', 'agent'] }),
      })
      return ((await response.json()) as { ticket: string }).ticket
    }
    const bridgeId = 'partial-text-agent'
    const first = await openEncryptedSession({ hub, ticket: await issue(), machineId, publicKey })
    await first.rpc({ protocolVersion: 1, id: 'add-partial-root', method: 'workspaces.add', params: { path: workspaceRoot } })
    await first.rpc({
      protocolVersion: 1, id: 'start-partial-agent', method: 'bridge.start',
      params: { bridgeId, provider: 'ollama', model: 'fake-model', cwd: workspaceRoot, conversationScopeKey: 'partial-chat' },
    })
    void first.rpc({ protocolVersion: 1, id: 'partial-prompt', method: 'bridge.prompt', params: { bridgeId, text: 'Explain' } })
    await firstChunkWritten
    await expect(first.nextEvent(message => message.channel === 'bridge'
      && (message.event as { type?: string }).type === 'text_delta'))
      .resolves.toMatchObject({ event: { delta: 'The Nephilim are ' } })

    // This is the observed browser flow: a partial answer was rendered and
    // persisted, then the tab closed while the same provider turn continued.
    await first.close()
    const second = await openEncryptedSession({ hub, ticket: await issue(), machineId, publicKey })
    await second.rpc({ protocolVersion: 1, id: 'claim-partial-agent', method: 'bridge.claim', params: { bridgeIds: [bridgeId] } })
    const replacement = await second.nextEvent(message => message.channel === 'bridge'
      && (message.event as { type?: string }).type === 'history_agent')
    expect(replacement).toMatchObject({
      event: { type: 'history_agent', bridgeId, text: 'The Nephilim are ' },
    })

    releaseFinal()
    const continued = await second.nextEvent(message => message.channel === 'bridge'
      && (message.event as { type?: string; delta?: string }).type === 'text_delta'
      && (message.event as { delta?: string }).delta?.includes('mysterious figures') === true)
    expect(continued).toMatchObject({
      event: { delta: 'mysterious figures mentioned in ancient texts.' },
    })
    expect(requestCount).toBe(1)
    await second.rpc({ protocolVersion: 1, id: 'stop-partial-agent', method: 'bridge.stop', params: { bridgeId } })
    await second.close()
  })

  it('applies Brain authorization reductions immediately and stops affected resources', async () => {
    const { hub, machineId, cookie, csrf, publicKey, workspaceRoot } = await fixture(['workspace:write', 'terminal'])
    const ticketResponse = await fetch(`${hub.url}/api/v1/hub/machines/${machineId}/tickets`, {
      method: 'POST', headers: { cookie, 'x-crewcode-csrf': csrf, 'content-type': 'application/json', origin: hub.publicOrigin },
      body: JSON.stringify({ requestedScopes: ['workspace:write', 'terminal'] }),
    })
    const { ticket } = await ticketResponse.json() as { ticket: string }
    const session = await openEncryptedSession({ hub, ticket, machineId, publicKey })
    await session.rpc({ protocolVersion: 1, id: 'add-policy-root', method: 'workspaces.add', params: { path: workspaceRoot } })
    await session.rpc({ protocolVersion: 1, id: 'create-policy-pty', method: 'pty.create', params: { paneId: 'policy-pane', cwd: workspaceRoot } })
    await expect(session.rpc({ protocolVersion: 1, id: 'get-policy', method: 'brain.authorization.get', params: {} }))
      .resolves.toMatchObject({ type: 'rpcResult', response: { ok: true, result: { roots: [workspaceRoot], scopes: ['terminal', 'workspace:write'] } } })
    await expect(session.rpc({ protocolVersion: 1, id: 'reduce-policy', method: 'brain.authorization.update', params: { roots: [workspaceRoot], scopes: ['workspace:write'] } }))
      .resolves.toMatchObject({ type: 'rpcResult', response: { ok: true, result: { stopped: { paneIds: ['policy-pane'] } } } })
    await expect(session.rpc({ protocolVersion: 1, id: 'terminal-after-revoke', method: 'pty.write', params: { paneId: 'policy-pane', data: 'no' } }))
      .resolves.toMatchObject({ type: 'rpcResult', response: { ok: false, error: { code: 'FORBIDDEN' } } })
    await session.close()
  })

  it('tunnels attachment chunks end-to-end into the Brain workspace', async () => {
    const { hub, machineId, cookie, csrf, publicKey, workspaceRoot } = await fixture(['workspace:write'])
    const ticketResponse = await fetch(`${hub.url}/api/v1/hub/machines/${machineId}/tickets`, {
      method: 'POST', headers: { cookie, 'x-crewcode-csrf': csrf, 'content-type': 'application/json', origin: hub.publicOrigin },
      body: JSON.stringify({ requestedScopes: ['workspace:write'] }),
    })
    const { ticket } = await ticketResponse.json() as { ticket: string }
    const session = await openEncryptedSession({ hub, ticket, machineId, publicKey })
    await session.rpc({ protocolVersion: 1, id: 'add-upload-root', method: 'workspaces.add', params: { path: workspaceRoot } })
    const bytes = Buffer.from('private attachment bytes never visible to Hub')
    const begun = await session.rpc({
      protocolVersion: 1, id: 'begin-upload', method: 'attachments.begin',
      params: { root: workspaceRoot, name: '../private.txt', size: bytes.byteLength },
    })
    if (begun.type !== 'rpcResult' || !begun.response.ok) throw new Error(`attachment begin failed: ${JSON.stringify(begun)}`)
    const uploadId = String((begun.response.result as { uploadId: string }).uploadId)
    await expect(session.rpc({
      protocolVersion: 1, id: 'chunk-upload', method: 'attachments.chunk',
      params: { uploadId, sequence: 0, data: bytes.toString('base64') },
    })).resolves.toMatchObject({ type: 'rpcResult', response: { ok: true } })
    const finished = await session.rpc({
      protocolVersion: 1, id: 'finish-upload', method: 'attachments.finish',
      params: { uploadId, sha256: createHash('sha256').update(bytes).digest('hex') },
    })
    if (finished.type !== 'rpcResult' || !finished.response.ok) throw new Error(`attachment finish failed: ${JSON.stringify(finished)}`)
    const rel = String((finished.response.result as { rel: string }).rel)
    expect(rel).toMatch(/^\.crewcode\/attachments\//)
    expect(readFileSync(join(workspaceRoot, rel), 'utf8')).toBe(bytes.toString())
    await session.close()
  })

  it('executes a scoped read RPC and rejects ticket replay', async () => {
    const { hub, machineId, cookie, csrf, publicKey } = await fixture(['workspace:read'])
    const issue = () => fetch(`${hub.url}/api/v1/hub/machines/${machineId}/tickets`, {
      method: 'POST', headers: { cookie, 'x-crewcode-csrf': csrf, 'content-type': 'application/json', origin: hub.publicOrigin },
      body: JSON.stringify({ requestedScopes: ['workspace:read'] }),
    })
    const ticketResponse = await issue()
    const { ticket } = await ticketResponse.json() as { ticket: string }
    const result = await encryptedRpc({ hub, ticket, machineId, publicKey, request: { protocolVersion: 1, id: 'list', method: 'workspaces.list', params: {} } })
    expect(result).toEqual({ type: 'rpcResult', response: { protocolVersion: 1, id: 'list', ok: true, result: [] } })
    const replay = new WebSocket(hub.url.replace(/^http/, 'ws') + '/api/v1/hub/relay', ['crewcode.browser.v1', ticket], { origin: hub.publicOrigin })
    const code = await new Promise<number>((resolve, reject) => { replay.once('close', resolve); replay.once('error', reject) })
    expect(code).toBe(4001)
  })
})

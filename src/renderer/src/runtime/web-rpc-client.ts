import {
  CREWCODE_REMOTE_PROTOCOL_VERSION,
  type CrewCodeRemoteResponse,
  type CrewCodeServerCapabilities,
} from '../../../shared/remote-access-types'
import type { CrewCodeClient } from './crewcode-client'
import type { BridgeEvent } from '../types'

const SESSION_KEY = 'crewcode:remote-session:v1'
let requestCounter = 0

type WebEventEnvelope =
  | { channel: 'pty'; event: { type: 'data'; paneId: string; data: string } | { type: 'exit'; paneId: string; exitCode: number; signal?: number } }
  | { channel: 'bridge'; event: BridgeEvent }

export class WebRpcError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message)
  }
}

export async function fetchServerCapabilities(): Promise<CrewCodeServerCapabilities> {
  const response = await fetch('/api/v1/capabilities', { cache: 'no-store' })
  if (!response.ok) throw new WebRpcError(`server returned ${response.status}`, undefined, response.status)
  const value = await response.json() as CrewCodeServerCapabilities
  if (value.protocolVersion !== CREWCODE_REMOTE_PROTOCOL_VERSION) throw new WebRpcError(`unsupported server protocol ${value.protocolVersion}`)
  return value
}

export function savedWebSession(): string {
  try { return localStorage.getItem(SESSION_KEY) ?? '' } catch { return '' }
}

export function clearWebSession(): void {
  try { localStorage.removeItem(SESSION_KEY) } catch { /* unavailable storage */ }
}

export async function exchangePairingToken(token: string): Promise<string> {
  const response = await fetch('/api/v1/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const body = await response.json() as { sessionToken?: string; error?: { message?: string } }
  if (!response.ok || !body.sessionToken) throw new WebRpcError(body.error?.message ?? 'pairing failed', 'UNAUTHENTICATED', response.status)
  try { localStorage.setItem(SESSION_KEY, body.sessionToken) } catch { /* session works until refresh */ }
  return body.sessionToken
}

export async function webRpc<T>(sessionToken: string, method: string, params: Record<string, unknown>): Promise<T> {
  requestCounter += 1
  const id = `web-${Date.now().toString(36)}-${requestCounter.toString(36)}`
  const response = await fetch('/api/v1/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id, method, params }),
  })
  const body = await response.json() as CrewCodeRemoteResponse<T> | { error?: { code?: string; message?: string } }
  if (response.ok && 'ok' in body && (body.protocolVersion !== CREWCODE_REMOTE_PROTOCOL_VERSION || body.id !== id)) {
    throw new WebRpcError('server returned a mismatched RPC response', 'INVALID_REQUEST', response.status)
  }
  if (!response.ok || !('ok' in body) || !body.ok) {
    const error = 'error' in body ? body.error : undefined
    if (response.status === 401) clearWebSession()
    throw new WebRpcError(error?.message ?? `RPC failed with ${response.status}`, error?.code, response.status)
  }
  return body.result
}

function createEventSocket(sessionToken: string, onEvent: (envelope: WebEventEnvelope) => void): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/events`, ['crewcode.v1', sessionToken])
  socket.addEventListener('message', message => {
    try {
      const envelope = JSON.parse(String(message.data)) as WebEventEnvelope
      if (envelope.channel === 'pty' || envelope.channel === 'bridge') onEvent(envelope)
    } catch { /* malformed server events are ignored, never executed */ }
  })
  return socket
}

/** A Proxy keeps unsupported privileged methods explicit while the web surface
 * grows; supported calls retain the desktop client's exact TypeScript shape. */
export function createWebCrewCodeClient(sessionToken: string): CrewCodeClient {
  const dataListeners = new Set<(event: { paneId: string; data: string }) => void>()
  const exitListeners = new Set<(event: { paneId: string; exitCode: number; signal?: number }) => void>()
  const bridgeListeners = new Set<(event: BridgeEvent) => void>()
  let eventSocket: WebSocket | null = null
  const ensureEvents = (): void => {
    if (eventSocket) return
    eventSocket = createEventSocket(sessionToken, envelope => {
      if (envelope.channel === 'bridge') {
        for (const listener of bridgeListeners) listener(envelope.event)
      } else if (envelope.event.type === 'data') {
        for (const listener of dataListeners) listener({ paneId: envelope.event.paneId, data: envelope.event.data })
      } else {
        for (const listener of exitListeners) listener({ paneId: envelope.event.paneId, exitCode: envelope.event.exitCode, signal: envelope.event.signal })
      }
    })
  }
  const noSubscription = (): (() => void) => () => undefined
  const supported: Partial<CrewCodeClient> = {
    workspacesList: () => webRpc(sessionToken, 'workspaces.list', {}),
    workspacesAdd: path => webRpc(sessionToken, 'workspaces.add', { path }),
    workspacesRemove: id => webRpc(sessionToken, 'workspaces.remove', { id }),
    workspacesPin: (id, pinned) => webRpc(sessionToken, 'workspaces.pin', { id, pinned }),
    workspacesRename: (id, name) => webRpc(sessionToken, 'workspaces.rename', { id, name }),
    workspacesSetFolder: (id, folder) => webRpc(sessionToken, 'workspaces.setFolder', { id, folder }),
    // Browser replacement for the host-native picker. The entered server path
    // is canonicalized and checked against server-configured workspace roots.
    workspacesPickFolder: async () => {
      const selected = window.prompt('Enter a folder path on the CrewCode server:')?.trim()
      if (!selected) return { ok: true, canceled: true }
      const result = await webRpc<{ ok: true; path: string }>(sessionToken, 'workspaces.inspectPath', { path: selected })
      return { ok: true, canceled: false, path: result.path }
    },
    workspacesCloneRepo: (url, parentDir, folderName) => webRpc(sessionToken, 'workspaces.clone', { url, parentDir, folderName }),
    workspacesInitProject: (parentDir, folderName, asGit) => webRpc(sessionToken, 'workspaces.initProject', { parentDir, folderName, asGit }),
    agentRegistry: () => webRpc(sessionToken, 'agents.registry', {}),
    agentListModels: provider => webRpc(sessionToken, 'agents.listModels', { provider }),
    // Browser-safe platform equivalents. They deliberately do not grant new
    // server privileges and keep shared App startup independent of Electron.
    openExternal: async url => { window.open(url, '_blank', 'noopener,noreferrer'); return { ok: true } },
    clipboardWriteText: async text => { await navigator.clipboard.writeText(text); return { ok: true } },
    clipboardReadText: async () => ({ ok: true, text: await navigator.clipboard.readText() }),
    notify: async options => {
      if ('Notification' in window && Notification.permission === 'granted') new Notification(options.title, { body: options.body })
      return { ok: true }
    },
    setUiZoom: () => undefined,
    // Shared App hooks subscribe unconditionally. Desktop-only event sources are
    // represented by inert subscriptions rather than rejected promises because
    // React effect cleanup requires an actual disposer function.
    onRemoteStatus: noSubscription,
    onMcpChanged: noSubscription,
    onPluginsChanged: noSubscription,
    onNotificationClick: noSubscription,
    onDelegationRequest: noSubscription,
    onKeybindsChanged: noSubscription,
    onEditorFileChanged: noSubscription,
    onEditorLanguageServerMessage: noSubscription,
    onEditorLanguageServerStatus: noSubscription,
    onGhAuthEvent: noSubscription,
    onUpdaterEvent: noSubscription,
    mcpList: async () => ({ path: '', exists: false, servers: [], errors: [] }),
    sshListConfig: async () => [],
    keybindsRead: async () => ({ ok: true, data: null }),
    // Browser shortcuts persist through SettingsProvider localStorage. The
    // desktop keys.json mirror and native editor action do not exist on web.
    keybindsWrite: async () => ({ ok: true }),
    keybindsOpen: async () => ({ ok: false, error: 'keys.json is unavailable in browser mode' }),
    rateLimits: {
      get: async () => ({ providers: {} }),
      refresh: async () => ({ providers: {} }),
      setPollingInterval: async () => undefined,
      onUpdate: () => () => undefined,
    },
    transcriptsLoadAll: () => webRpc(sessionToken, 'transcripts.loadAll', {}),
    transcriptsMtimes: () => webRpc(sessionToken, 'transcripts.mtimes', {}),
    transcriptsSave: (scopeId, messages) => webRpc(sessionToken, 'transcripts.save', { scopeId, messages }),
    transcriptsRemove: scopeId => webRpc(sessionToken, 'transcripts.remove', { scopeId }),
    worktreeList: repoPath => webRpc(sessionToken, 'worktrees.list', { repoPath }),
    worktreeCreate: (repoPath, branch, worktreePath, startPoint) => webRpc(sessionToken, 'worktrees.create', { repoPath, branch, worktreePath, startPoint }),
    worktreeRemove: worktreePath => webRpc(sessionToken, 'worktrees.remove', { worktreePath }),
    attachmentsPick: async () => ({ canceled: true, filePaths: [] }),
    attachmentsImport: async (root, items) => {
      const rels: string[] = []
      for (const item of items) {
        const source = item.data instanceof ArrayBuffer ? new Uint8Array(item.data) : item.data
        const bytes = new Uint8Array(source.byteLength)
        bytes.set(source)
        const response = await fetch(`/api/v1/attachments?root=${encodeURIComponent(root)}&name=${encodeURIComponent(item.name)}`, {
          method: 'POST', headers: { authorization: `Bearer ${sessionToken}` }, body: bytes.buffer,
        })
        const result = await response.json() as { rel?: string; error?: { message?: string } }
        if (!response.ok || !result.rel) return { error: result.error?.message ?? `attachment upload failed with ${response.status}` }
        rels.push(result.rel)
      }
      return { rels }
    },
    // There is no synchronous network transport. Start a keepalive request so
    // page teardown can still hand the final settled transcript to the server.
    transcriptsSaveSyncBatch: entries => {
      const id = `web-teardown-${Date.now().toString(36)}`
      void fetch('/api/v1/rpc', {
        method: 'POST', keepalive: true,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id, method: 'transcripts.saveBatch', params: { entries } }),
      }).catch(() => undefined)
      return true
    },
    fsReadDir: (root, sub = '') => webRpc(sessionToken, 'fs.readDir', { root, sub }),
    fsReadFile: (root, sub) => webRpc(sessionToken, 'fs.readFile', { root, sub }),
    fsReadDataUrl: (root, sub) => webRpc(sessionToken, 'fs.readDataUrl', { root, sub }),
    fsWriteFile: (root, sub, text) => webRpc(sessionToken, 'fs.writeFile', { root, sub, text }),
    fsMkdir: (root, sub) => webRpc(sessionToken, 'fs.mkdir', { root, sub }),
    fsDelete: (root, sub) => webRpc(sessionToken, 'fs.delete', { root, sub }),
    fsRename: (root, sub, newName) => webRpc(sessionToken, 'fs.rename', { root, sub, newName }),
    fsListFiles: root => webRpc(sessionToken, 'fs.listFiles', { root }),
    gitStatus: cwd => webRpc(sessionToken, 'git.status', { cwd }),
    gitStage: (cwd, paths) => webRpc(sessionToken, 'git.stage', { cwd, paths }),
    gitStageAll: cwd => webRpc(sessionToken, 'git.stageAll', { cwd }),
    gitUnstage: (cwd, paths) => webRpc(sessionToken, 'git.unstage', { cwd, paths }),
    gitDiff: (cwd, path, staged) => webRpc(sessionToken, 'git.diff', { cwd, path, staged }),
    gitLog: (cwd, limit = 20) => webRpc(sessionToken, 'git.log', { cwd, limit }),
    gitBranches: cwd => webRpc(sessionToken, 'git.branches', { cwd }),
    gitRemotes: cwd => webRpc(sessionToken, 'git.remotes', { cwd }),
    gitCommit: (cwd, message, amend, noSign) => webRpc(sessionToken, 'git.commit', { cwd, message, amend, noSign }),
    gitPush: cwd => webRpc(sessionToken, 'git.push', { cwd }),
    gitPull: cwd => webRpc(sessionToken, 'git.pull', { cwd }),
    gitFetch: cwd => webRpc(sessionToken, 'git.fetch', { cwd }),
    gitCheckout: (cwd, branch) => webRpc(sessionToken, 'git.checkout', { cwd, branch }),
    gitCreateBranch: (cwd, name) => webRpc(sessionToken, 'git.createBranch', { cwd, name }),
    gitMerge: (cwd, ref) => webRpc(sessionToken, 'git.merge', { cwd, ref }),
    gitMergeAbort: cwd => webRpc(sessionToken, 'git.mergeAbort', { cwd }),
    gitMergeContinue: cwd => webRpc(sessionToken, 'git.mergeContinue', { cwd }),
    gitResolveConflict: (cwd, file, strategy) => webRpc(sessionToken, 'git.resolveConflict', { cwd, file, strategy }),
    gitInit: cwd => webRpc(sessionToken, 'git.init', { cwd }),
    // GitHub/credential operations are intentionally unavailable remotely. Empty
    // status values keep the shared Git surface functional without exposing auth.
    githubStatus: async () => ({ error: 'GitHub integration is unavailable remotely' }),
    ghStatus: async () => ({ available: false, loggedIn: false, user: null, host: null, raw: '', error: 'GitHub integration is unavailable remotely' }),
    ptyCreate: opts => webRpc(sessionToken, 'pty.create', { ...opts }),
    ptyWrite: (paneId, data) => { void webRpc(sessionToken, 'pty.write', { paneId, data }) },
    ptyResize: (paneId, cols, rows) => { void webRpc(sessionToken, 'pty.resize', { paneId, cols, rows }) },
    ptyKill: paneId => { void webRpc(sessionToken, 'pty.kill', { paneId }) },
    onPtyData: callback => {
      dataListeners.add(callback)
      ensureEvents()
      return () => dataListeners.delete(callback)
    },
    onPtyDataForPane: (paneId, callback) => {
      const listener = (event: { paneId: string; data: string }) => { if (event.paneId === paneId) callback(event.data) }
      dataListeners.add(listener)
      ensureEvents()
      return () => dataListeners.delete(listener)
    },
    onPtyExit: callback => {
      exitListeners.add(callback)
      ensureEvents()
      return () => exitListeners.delete(callback)
    },
    bridgeStart: opts => webRpc(sessionToken, 'bridge.start', {
      bridgeId: opts.bridgeId, provider: opts.provider, cwd: opts.cwd, model: opts.model,
      mode: opts.mode, toolPolicy: opts.toolPolicy, thinking: opts.thinking,
      conversationScopeKey: opts.conversationScopeKey, freshSession: opts.freshSession,
      suppressProviderHistoryReplay: opts.suppressProviderHistoryReplay,
    }),
    bridgePrompt: (bridgeId, text, options) => webRpc(sessionToken, 'bridge.prompt', { bridgeId, text, options }),
    bridgeCompact: bridgeId => webRpc(sessionToken, 'bridge.compact', { bridgeId }),
    bridgeRemoveFollowUp: (bridgeId, followUpId) => webRpc(sessionToken, 'bridge.removeFollowUp', { bridgeId, followUpId }),
    bridgeRespondUserRequest: response => webRpc(sessionToken, 'bridge.respondUserRequest', { response }),
    bridgeSetMode: (bridgeId, mode) => { void webRpc(sessionToken, 'bridge.setMode', { bridgeId, mode }) },
    bridgeAbort: bridgeId => { void webRpc(sessionToken, 'bridge.abort', { bridgeId }) },
    bridgeStop: bridgeId => { void webRpc(sessionToken, 'bridge.stop', { bridgeId }) },
    onBridgeEvent: callback => {
      bridgeListeners.add(callback)
      ensureEvents()
      return () => bridgeListeners.delete(callback)
    },
  }
  return new Proxy(supported as CrewCodeClient, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver)
      if (typeof property !== 'string') return undefined
      return () => Promise.reject(new WebRpcError(`${property} is not available in this CrewCode web preview`, 'UNSUPPORTED'))
    },
  })
}

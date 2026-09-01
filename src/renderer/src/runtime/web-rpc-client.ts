import {
  CREWCODE_REMOTE_PROTOCOL_VERSION,
  type CrewCodeRemoteResponse,
  type CrewCodeServerCapabilities,
} from '../../../shared/remote-access-types'
import type { CrewCodeClient } from './crewcode-client'
import type { BridgeEvent, GhAuthEvent } from '../types'
import type { LanguageServerMessageEvent, LanguageServerStatusEvent } from '../../../shared/language-server-types'
import type { DelegationRendererRequest } from '../../../shared/delegation-types'

const SESSION_KEY = 'crewcode:remote-session:v1'
let requestCounter = 0

export type WebEventEnvelope =
  | { channel: 'pty'; event: { type: 'data'; paneId: string; data: string } | { type: 'exit'; paneId: string; exitCode: number; signal?: number } }
  | { channel: 'bridge'; event: BridgeEvent }
  | { channel: 'gh'; event: GhAuthEvent }
  | { channel: 'editorFileChanged'; event: { root: string; rel: string } }
  | { channel: 'editorLspMessage'; event: LanguageServerMessageEvent }
  | { channel: 'editorLspStatus'; event: LanguageServerStatusEvent }
  | { channel: 'delegation'; event: DelegationRendererRequest & { id: string } }

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
  if (!window.location || typeof WebSocket === 'undefined') {
    return { close: () => undefined, addEventListener: () => undefined } as unknown as WebSocket
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${window.location.host}/api/v1/events`, ['crewcode.v1', sessionToken])
  socket.addEventListener('message', message => {
    try {
      const envelope = JSON.parse(String(message.data)) as WebEventEnvelope
      onEvent(envelope)
    } catch { /* malformed server events are ignored, never executed */ }
  })
  return socket
}

function bytesToBase64(value: Uint8Array): string {
  let binary = ''
  const chunkSize = 32 * 1024
  for (let offset = 0; offset < value.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...value.subarray(offset, Math.min(value.byteLength, offset + chunkSize)))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export interface WebClientTransport {
  rpc<T>(method: string, params: Record<string, unknown>): Promise<T>
  subscribe(onEvent: (envelope: WebEventEnvelope) => void): () => void
  uploadAttachment?(root: string, name: string, body: ArrayBuffer): Promise<string>
  saveSyncBatch?(entries: unknown): boolean
}

/** A Proxy keeps unsupported privileged methods explicit while the web surface
 * grows; supported calls retain the desktop client's exact TypeScript shape. */
export function createWebCrewCodeClient(sessionOrTransport: string | WebClientTransport): CrewCodeClient {
  const directSession = typeof sessionOrTransport === 'string' ? sessionOrTransport : null
  const transport: WebClientTransport = typeof sessionOrTransport === 'string'
    ? {
        rpc: (method, params) => webRpc(sessionOrTransport, method, params),
        subscribe: onEvent => {
          const socket = createEventSocket(sessionOrTransport, onEvent)
          return () => socket.close()
        },
      }
    : sessionOrTransport
  const rpc = <T,>(method: string, params: Record<string, unknown>): Promise<T> => transport.rpc<T>(method, params)
  const dataListeners = new Set<(event: { paneId: string; data: string }) => void>()
  const exitListeners = new Set<(event: { paneId: string; exitCode: number; signal?: number }) => void>()
  const bridgeListeners = new Set<(event: BridgeEvent) => void>()
  const ghListeners = new Set<(event: GhAuthEvent) => void>()
  const editorFileListeners = new Set<(event: { root: string; rel: string }) => void>()
  const editorLspMessageListeners = new Set<(event: LanguageServerMessageEvent) => void>()
  const editorLspStatusListeners = new Set<(event: LanguageServerStatusEvent) => void>()
  const delegationListeners = new Set<(event: DelegationRendererRequest & { id: string }) => void>()
  let eventDisposer: (() => void) | null = null
  const ensureEvents = (): void => {
    if (eventDisposer) return
    eventDisposer = transport.subscribe(envelope => {
      if (envelope.channel === 'bridge') {
        for (const listener of bridgeListeners) listener(envelope.event)
      } else if (envelope.channel === 'gh') {
        for (const listener of ghListeners) listener(envelope.event)
      } else if (envelope.channel === 'editorFileChanged') {
        for (const listener of editorFileListeners) listener(envelope.event)
      } else if (envelope.channel === 'editorLspMessage') {
        for (const listener of editorLspMessageListeners) listener(envelope.event)
      } else if (envelope.channel === 'editorLspStatus') {
        for (const listener of editorLspStatusListeners) listener(envelope.event)
      } else if (envelope.channel === 'delegation') {
        for (const listener of delegationListeners) listener(envelope.event)
      } else if (envelope.event.type === 'data') {
        for (const listener of dataListeners) listener({ paneId: envelope.event.paneId, data: envelope.event.data })
      } else {
        for (const listener of exitListeners) listener({ paneId: envelope.event.paneId, exitCode: envelope.event.exitCode, signal: envelope.event.signal })
      }
    })
  }
  const noSubscription = (): (() => void) => () => undefined
  const supported: Partial<CrewCodeClient> = {
    workspacesList: () => rpc('workspaces.list', {}),
    workspacesAdd: path => rpc('workspaces.add', { path }),
    workspacesRemove: id => rpc('workspaces.remove', { id }),
    workspacesPin: (id, pinned) => rpc('workspaces.pin', { id, pinned }),
    workspacesRename: (id, name) => rpc('workspaces.rename', { id, name }),
    workspacesSetFolder: (id, folder) => rpc('workspaces.setFolder', { id, folder }),
    // Browser replacement for the host-native picker. The entered server path
    // is canonicalized and checked against server-configured workspace roots.
    workspacesPickFolder: async () => {
      const selected = window.prompt('Enter a folder path on the CrewCode server:')?.trim()
      if (!selected) return { ok: true, canceled: true }
      const result = await rpc<{ ok: true; path: string }>('workspaces.inspectPath', { path: selected })
      return { ok: true, canceled: false, path: result.path }
    },
    workspacesCloneRepo: (url, parentDir, folderName) => rpc('workspaces.clone', { url, parentDir, folderName }),
    workspacesInitProject: (parentDir, folderName, asGit) => rpc('workspaces.initProject', { parentDir, folderName, asGit }),
    agentRegistry: () => rpc('agents.registry', {}),
    agentListModels: provider => rpc('agents.listModels', { provider }),
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
    onDelegationRequest: callback => { delegationListeners.add(callback); ensureEvents(); return () => delegationListeners.delete(callback) },
    onKeybindsChanged: noSubscription,
    onEditorFileChanged: callback => { editorFileListeners.add(callback); ensureEvents(); return () => editorFileListeners.delete(callback) },
    onEditorLanguageServerMessage: callback => { editorLspMessageListeners.add(callback); ensureEvents(); return () => editorLspMessageListeners.delete(callback) },
    onEditorLanguageServerStatus: callback => { editorLspStatusListeners.add(callback); ensureEvents(); return () => editorLspStatusListeners.delete(callback) },
    onGhAuthEvent: callback => { ghListeners.add(callback); ensureEvents(); return () => ghListeners.delete(callback) },
    onUpdaterEvent: noSubscription,
    updaterConfigure: async () => ({ ok: false, error: 'updates are desktop-only' }),
    updaterCheck: async () => ({ ok: false, error: 'updates are desktop-only' }),
    updaterDownload: async () => ({ ok: false, error: 'updates are desktop-only' }),
    updaterQuitAndInstall: async () => ({ ok: false, error: 'updates are desktop-only' }),
    appBuildInfo: async () => ({ version: 'web', buildHash: 'web', packaged: false }),
    // These desktop integrations are deliberately inert in a browser. Defining
    // them explicitly matters because the Proxy fallback is a function, so
    // optional method checks would otherwise invoke a rejected Promise.
    delegationEnable: (sessionId, policy) => rpc('delegation.enable', { sessionId, policy }),
    delegationDisable: sessionId => rpc('delegation.disable', { sessionId }),
    delegationRespond: (id, result) => { void rpc('delegation.respond', { id, result }) },
    editorWatchAdd: (root, rel) => { void rpc('editor.watchAdd', { root, rel }) },
    editorWatchRemove: (root, rel) => { void rpc('editor.watchRemove', { root, rel }) },
    editorLanguageServerStart: root => rpc('editor.lspStart', { root }),
    editorLanguageServerSend: (handleId, message) => { void rpc('editor.lspSend', { handleId, message }) },
    editorLanguageServerStop: handleId => { void rpc('editor.lspStop', { handleId }) },
    voiceProviderAvailability: () => rpc('voice.availability', {}),
    voiceCreateClientSecret: request => rpc('voice.clientSecret', { request }),
    voiceTranscribe: request => {
      if (request.provider !== 'openai' && request.provider !== 'xai') return Promise.resolve({ ok: false, error: 'Only Brain-configured GPT and xAI dictation are available remotely.' })
      return rpc('voice.transcribe', { provider: request.provider, audioBase64: bytesToBase64(request.audio) })
    },
    voiceSynthesize: async request => {
      if (request.provider !== 'openai' && request.provider !== 'xai') return { ok: false, error: 'Only Brain-configured GPT and xAI speech is available remotely.' }
      const result = await rpc<{ ok: boolean; audio?: string; contentType?: string; error?: string }>('voice.synthesize', {
        provider: request.provider, text: request.text, voice: request.voice,
      })
      return result.ok && result.audio
        ? { ok: true, audio: base64ToBytes(result.audio), contentType: result.contentType }
        : { ok: false, error: result.error ?? 'Remote speech failed.' }
    },
    voiceSetProviderKey: async provider => ({ ok: false, error: `Configure the ${provider} voice key on the CrewCode Brain` }),
    mcpList: () => rpc('mcp.list', {}),
    mcpOpenFile: async () => ({ ok: false, error: 'Edit ~/.crewcode/mcp.json on the CrewCode Brain' }),
    pluginsList: () => rpc('plugins.list', {}),
    pluginsWatch: async () => ({ ok: true, registry: await rpc('plugins.list', {}) }),
    pluginsRefresh: () => rpc('plugins.list', {}),
    pluginsResolveTab: registrationId => rpc('plugins.resolveTab', { registrationId }),
    pluginsInvoke: request => rpc('plugins.invoke', { request }),
    pluginsRecordRuntimeError: async () => ({ ok: true }),
    pluginsAudit: async () => [],
    pluginsSetApproval: async () => ({ ok: false, error: 'Plugin approval must be changed on the Brain' }),
    pluginsSetEnabled: async () => ({ ok: false, error: 'Plugin enablement must be changed on the Brain' }),
    pluginsCopyExample: async () => ({ ok: false, error: 'Plugin installation is Brain-local' }),
    pluginsInspectGit: async () => ({ ok: false, error: 'Plugin installation is Brain-local' }),
    pluginsInstallGit: async () => ({ ok: false, error: 'Plugin installation is Brain-local' }),
    pluginsOpenDir: async () => ({ ok: false, error: 'Plugin folders are Brain-local' }),
    pluginsOpenPluginDir: async () => ({ ok: false, error: 'Plugin folders are Brain-local' }),
    pluginsOpenManifest: async () => ({ ok: false, error: 'Plugin manifests are Brain-local' }),
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
    transcriptsLoadAll: () => rpc('transcripts.loadAll', {}),
    transcriptsMtimes: () => rpc('transcripts.mtimes', {}),
    transcriptsSave: (scopeId, messages) => rpc('transcripts.save', { scopeId, messages }),
    transcriptsRemove: scopeId => rpc('transcripts.remove', { scopeId }),
    continuityStateGet: () => rpc('continuity.get', {}),
    continuityStateUpdate: values => rpc('continuity.update', { values }),
    worktreeList: repoPath => rpc('worktrees.list', { repoPath }),
    worktreeCreate: (repoPath, branch, worktreePath, startPoint) => rpc('worktrees.create', { repoPath, branch, worktreePath, startPoint }),
    worktreeRemove: worktreePath => rpc('worktrees.remove', { worktreePath }),
    attachmentsPick: async () => ({ canceled: true, filePaths: [] }),
    attachmentsImport: async (root, items) => {
      const rels: string[] = []
      try {
        for (const item of items) {
          const source = item.data instanceof ArrayBuffer ? new Uint8Array(item.data) : item.data
          const bytes = new Uint8Array(source.byteLength)
          bytes.set(source)
          if (transport.uploadAttachment) {
            rels.push(await transport.uploadAttachment(root, item.name, bytes.buffer))
            continue
          }
          if (!directSession) return { error: 'attachment upload is unavailable through this remote transport' }
          const response = await fetch(`/api/v1/attachments?root=${encodeURIComponent(root)}&name=${encodeURIComponent(item.name)}`, {
            method: 'POST', headers: { authorization: `Bearer ${directSession}` }, body: bytes.buffer,
          })
          const result = await response.json() as { rel?: string; error?: { message?: string } }
          if (!response.ok || !result.rel) return { error: result.error?.message ?? `attachment upload failed with ${response.status}` }
          rels.push(result.rel)
        }
        return { rels }
      } catch (error) {
        return { error: (error as Error).message || 'attachment upload failed' }
      }
    },
    // There is no synchronous network transport. Start a keepalive request so
    // page teardown can still hand the final settled transcript to the server.
    transcriptsSaveSyncBatch: entries => {
      if (transport.saveSyncBatch) return transport.saveSyncBatch(entries)
      if (!directSession) return false
      const id = `web-teardown-${Date.now().toString(36)}`
      void fetch('/api/v1/rpc', {
        method: 'POST', keepalive: true,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${directSession}` },
        body: JSON.stringify({ protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id, method: 'transcripts.saveBatch', params: { entries } }),
      }).catch(() => undefined)
      return true
    },
    fsReadDir: (root, sub = '') => rpc('fs.readDir', { root, sub }),
    fsReadFile: (root, sub) => rpc('fs.readFile', { root, sub }),
    fsReadDataUrl: (root, sub) => rpc('fs.readDataUrl', { root, sub }),
    fsWriteFile: (root, sub, text) => rpc('fs.writeFile', { root, sub, text }),
    fsFormat: (root, sub, text) => rpc('fs.format', { root, sub, text }),
    fsMkdir: (root, sub) => rpc('fs.mkdir', { root, sub }),
    fsDelete: (root, sub) => rpc('fs.delete', { root, sub }),
    fsRename: (root, sub, newName) => rpc('fs.rename', { root, sub, newName }),
    fsCopyFile: (root, sub, destDirRel) => rpc('fs.copyFile', destDirRel === undefined ? { root, sub } : { root, sub, destDirRel }),
    fsMove: (root, srcRel, destDirRel) => rpc('fs.move', { root, srcRel, destDirRel }),
    fsListFiles: root => rpc('fs.listFiles', { root }),
    gitStatus: cwd => rpc('git.status', { cwd }),
    gitStage: (cwd, paths) => rpc('git.stage', { cwd, paths }),
    gitStageAll: cwd => rpc('git.stageAll', { cwd }),
    gitUnstage: (cwd, paths) => rpc('git.unstage', { cwd, paths }),
    gitDiscard: (cwd, path) => rpc('git.discard', { cwd, path }),
    gitDiff: (cwd, path, staged) => rpc('git.diff', { cwd, path, staged }),
    gitChangesVsRef: (cwd, ref) => rpc('git.changesVsRef', { cwd, ref }),
    gitDiffVsRef: (cwd, ref, path) => rpc('git.diffVsRef', { cwd, ref, path }),
    gitLog: (cwd, limit = 20) => rpc('git.log', { cwd, limit }),
    gitBranches: cwd => rpc('git.branches', { cwd }),
    gitRemotes: cwd => rpc('git.remotes', { cwd }),
    gitCommit: (cwd, message, amend, noSign) => rpc('git.commit', { cwd, message, amend, noSign }),
    gitPush: cwd => rpc('git.push', { cwd }),
    gitPull: cwd => rpc('git.pull', { cwd }),
    gitFetch: cwd => rpc('git.fetch', { cwd }),
    gitCheckout: (cwd, branch) => rpc('git.checkout', { cwd, branch }),
    gitCreateBranch: (cwd, name) => rpc('git.createBranch', { cwd, name }),
    gitMerge: (cwd, ref) => rpc('git.merge', { cwd, ref }),
    gitMergeAbort: cwd => rpc('git.mergeAbort', { cwd }),
    gitMergeContinue: cwd => rpc('git.mergeContinue', { cwd }),
    gitResolveConflict: (cwd, file, strategy) => rpc('git.resolveConflict', { cwd, file, strategy }),
    gitInit: cwd => rpc('git.init', { cwd }),
    // GitHub commands execute with the Brain's existing gh CLI identity. Browser
    // clients never receive its token, and every repo operation remains confined
    // to a registered workspace root.
    githubStatus: repoPath => rpc('github.status', { cwd: repoPath }),
    ghStatus: () => rpc('gh.status', {}),
    ghPrCreate: cwd => rpc('gh.prCreate', { cwd }),
    ghPrMerge: (cwd, number) => rpc('gh.prMerge', { cwd, number }),
    ghPrApprove: (cwd, number) => rpc('gh.prApprove', { cwd, number }),
    ghLoginStart: () => rpc('gh.loginStart', {}),
    ghLoginCancel: () => rpc('gh.loginCancel', {}),
    ghLogout: async () => ({ ok: false, error: 'Remote logout is disabled; manage gh credentials from the Brain' }),
    ghRepoCreate: (cwd, options) => rpc('gh.repoCreate', { cwd, options }),
    ptyCreate: opts => rpc('pty.create', { ...opts }),
    ptyWrite: (paneId, data) => { void rpc('pty.write', { paneId, data }) },
    ptyResize: (paneId, cols, rows) => { void rpc('pty.resize', { paneId, cols, rows }) },
    ptyKill: paneId => { void rpc('pty.kill', { paneId }) },
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
    bridgeStart: opts => rpc('bridge.start', {
      bridgeId: opts.bridgeId, provider: opts.provider, cwd: opts.cwd, model: opts.model,
      mode: opts.mode, crewcoderMode: opts.crewcoderMode, crewcoderApprovalMode: opts.crewcoderApprovalMode, toolPolicy: opts.toolPolicy, thinking: opts.thinking,
      conversationScopeKey: opts.conversationScopeKey?.replace(/^(?:web|thread):/, ''), freshSession: opts.freshSession,
      suppressProviderHistoryReplay: opts.suppressProviderHistoryReplay,
      // Send references only. The Brain resolves these against its own registry
      // and never trusts browser-supplied MCP command/env definitions.
      mcpServerIds: opts.mcpServers?.map(server => server.id),
    }),
    bridgePrompt: (bridgeId, text, options) => rpc('bridge.prompt', { bridgeId, text, options }),
    bridgeCompact: bridgeId => rpc('bridge.compact', { bridgeId }),
    bridgeResetSession: (sessionKey, conversationScopeKey) => rpc('bridge.resetSession', {
      sessionKey,
      conversationScopeKey: (conversationScopeKey ?? sessionKey)?.replace(/^(?:web|thread):/, ''),
    }),
    bridgeHandoff: (bridgeId, sourceConversationKey, options) => rpc('bridge.handoff', {
      bridgeId,
      // The shared renderer uses desktop's `thread:<session>` key. Brain keeps
      // browser conversations in a separate namespace and adds `web:` itself.
      sourceConversationKey: sourceConversationKey.replace(/^(?:web|thread):/, ''),
      options,
    }),
    bridgeRemoveFollowUp: (bridgeId, followUpId) => rpc('bridge.removeFollowUp', { bridgeId, followUpId }),
    bridgeRespondUserRequest: response => rpc('bridge.respondUserRequest', { response }),
    bridgeSetMode: (bridgeId, mode) => { void rpc('bridge.setMode', { bridgeId, mode }) },
    bridgeAbort: bridgeId => { void rpc('bridge.abort', { bridgeId }) },
    bridgeStop: bridgeId => { void rpc('bridge.stop', { bridgeId }) },
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

const BRAIN_BACKED_METHODS = new Set([
  'workspacesList', 'workspacesAdd', 'workspacesRemove', 'workspacesPin', 'workspacesRename', 'workspacesSetFolder',
  'workspacesCloneRepo', 'workspacesInitProject',
  'agentRegistry', 'agentListModels',
  'transcriptsLoadAll', 'transcriptsMtimes', 'transcriptsSave', 'transcriptsRemove', 'transcriptsSaveSyncBatch',
  'continuityStateGet', 'continuityStateUpdate',
  'worktreeList', 'worktreeCreate', 'worktreeRemove',
  'fsReadDir', 'fsListFiles', 'fsReadFile', 'fsReadDataUrl', 'fsWriteFile', 'fsFormat', 'fsMkdir', 'fsDelete', 'fsRename', 'fsCopyFile', 'fsMove',
  'gitStatus', 'gitStage', 'gitStageAll', 'gitUnstage', 'gitDiscard', 'gitDiff', 'gitChangesVsRef', 'gitDiffVsRef', 'gitLog',
  'gitBranches', 'gitRemotes', 'gitCommit', 'gitPush', 'gitPull', 'gitFetch', 'gitCheckout', 'gitCreateBranch', 'gitMerge', 'gitMergeAbort', 'gitMergeContinue', 'gitResolveConflict', 'gitInit',
  'githubStatus', 'ghStatus', 'ghPrCreate', 'ghPrMerge', 'ghPrApprove', 'ghLoginStart', 'ghLoginCancel', 'ghRepoCreate', 'onGhAuthEvent',
  'ptyCreate', 'ptyWrite', 'ptyResize', 'ptyKill', 'onPtyData', 'onPtyDataForPane', 'onPtyExit',
  'bridgeStart', 'bridgePrompt', 'bridgeCompact', 'bridgeResetSession', 'bridgeHandoff', 'bridgeRemoveFollowUp', 'bridgeRespondUserRequest', 'bridgeSetMode', 'bridgeAbort', 'bridgeStop', 'onBridgeEvent',
  'delegationEnable', 'delegationDisable', 'delegationRespond', 'onDelegationRequest',
  'editorWatchAdd', 'editorWatchRemove', 'editorLanguageServerStart', 'editorLanguageServerSend', 'editorLanguageServerStop',
  'onEditorFileChanged', 'onEditorLanguageServerMessage', 'onEditorLanguageServerStatus',
  'voiceProviderAvailability', 'voiceCreateClientSecret', 'voiceTranscribe', 'voiceSynthesize',
  'mcpList', 'pluginsList', 'pluginsWatch', 'pluginsRefresh', 'pluginsResolveTab', 'pluginsInvoke',
  'attachmentsImport',
])

/**
 * Electron keeps native window/picker/updater integrations while all durable
 * workspace, transcript, terminal, and agent work crosses the same Brain
 * boundary used by the web client.
 */
export function createBrainAttachedCrewCodeClient(local: CrewCodeClient): CrewCodeClient {
  const transport: WebClientTransport = {
    rpc: (method, params) => local.brainDesktopRpc(method, params),
    subscribe: onEvent => local.onBrainDesktopEvent(event => onEvent(event as WebEventEnvelope)),
    uploadAttachment: async (root, name, body) => {
      const result = await local.brainDesktopUploadAttachment(root, name, new Uint8Array(body))
      if (!result.rel) throw new WebRpcError(result.error ?? 'Brain attachment upload failed')
      return result.rel
    },
    saveSyncBatch: entries => {
      void local.brainDesktopRpc('transcripts.saveBatch', { entries }).catch(() => undefined)
      return true
    },
  }
  const brain = createWebCrewCodeClient(transport)
  const trustedBrainOverrides: Partial<CrewCodeClient> = {
    agentGetKey: id => local.brainDesktopRpc('desktop.agent.getKey', { id }),
    agentSetKey: (id, key) => local.brainDesktopRpc('desktop.agent.setKey', { id, key }),
    voiceSetProviderKey: (provider, key) => local.brainDesktopRpc('desktop.voice.setProviderKey', { provider, key }),
  }
  // Electron contextBridge exposes `local` as a frozen proxy whose methods are
  // non-configurable data properties. Using it as this Proxy's target and then
  // returning a Brain-backed replacement violates the ECMAScript `get` trap
  // invariant. Keep a separate facade target and delegate native reads to the
  // contextBridge object instead.
  return new Proxy({} as CrewCodeClient, {
    get(_target, property) {
      if (Object.prototype.hasOwnProperty.call(trustedBrainOverrides, property)) {
        return Reflect.get(trustedBrainOverrides, property)
      }
      if (typeof property === 'string' && BRAIN_BACKED_METHODS.has(property)) return Reflect.get(brain, property)
      return Reflect.get(local, property, local)
    },
  })
}

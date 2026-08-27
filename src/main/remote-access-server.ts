import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { dirname, extname, join, normalize, posix, sep } from 'path'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'fs'
import { spawnSync } from 'child_process'
import { createHash, randomBytes } from 'crypto'
import { homedir } from 'os'
import {
  CREWCODE_REMOTE_PROTOCOL_VERSION,
  type CrewCodeRemoteError,
  type CrewCodeRemoteRequest,
  type CrewCodeRemoteResponse,
  type CrewCodeServerCapabilities,
} from '../shared/remote-access-types'
import { FilesystemService } from './filesystem-service'
import { RemoteAccessAuth } from './remote-access-auth'
import {
  browserOriginAllowed,
  REMOTE_PAIR_ATTEMPTS_PER_WINDOW,
  REMOTE_UNAUTHENTICATED_ATTEMPTS_PER_WINDOW,
  remotePeerKey,
  RemoteAccessRateLimiter,
} from './remote-access-security'
import { WorkspaceService } from './workspace-service'
import { PtyService } from './pty-service'
import { AgentBridgeService, type AgentPathResolver } from './agents/bridge-service'
import { headlessAgentRegistry, listHeadlessAgentModels } from './headless-agent-resolver'
import { readMcpConfig } from './mcp-config-service'
import { getGhStatus, getGitHubStatus, runGh } from './github-service'
import { RemoteGhService } from './remote-gh-service'
import { RemoteEditorLanguageServer } from './remote-editor-language-server'
import { RemoteEditorFileWatch } from './remote-editor-file-watch'
import { RemoteDelegationService } from './remote-delegation-service'
import { RemotePluginService } from './remote-plugin-service'
import { createVoiceClientSecret, synthesizeRemoteVoiceText, transcribeRemoteVoiceAudio, voiceProviderAvailability } from './voice-provider-auth'
import { TranscriptService, type TranscriptBatchEntry } from './transcript-service'
import { parsePorcelainWorktrees } from './worktree-list-parse'
import { addWorktree, removeWorktree } from './worktree-ops'
import { GitService } from './git-service'
import type { BridgeEvent, BridgeStartOpts, HandoffPromptOptions, PromptOptions } from './agents/bridge-types'
import { WebSocketServer, WebSocket } from 'ws'

const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_ATTACHMENT_CHUNK_BYTES = 256 * 1024
const MAX_ACTIVE_ATTACHMENT_UPLOADS = 8
const ATTACHMENT_UPLOAD_IDLE_MS = 2 * 60_000

export interface RemoteAccessServerOptions {
  host?: string
  port?: number
  dataDir: string
  webRoot?: string
  auth?: RemoteAccessAuth
  resolveAgentPath?: AgentPathResolver
  /** Host directories that paired browsers may discover/register/create under. */
  allowedWorkspaceRoots?: string[]
  /** Exact HTTPS/HTTP browser origins accepted when a reverse proxy changes Host. */
  publicOrigins?: string[]
}

export interface RunningRemoteAccessServer {
  host: string
  port: number
  url: string
  pairingToken: string
  pairingUrl: string
  close: () => Promise<void>
  updateAllowedWorkspaceRoots(roots: string[]): void
  stopResources(input: { terminal: boolean; agent: boolean; allowedRoots: string[] }): Promise<{ paneIds: string[]; bridgeIds: string[] }>
}

type RpcHandler = (params: Record<string, unknown>) => unknown | Promise<unknown>

const MAX_REMOTE_VOICE_AUDIO_BYTES = 8 * 1024 * 1024

function decodeRemoteVoiceAudio(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_REMOTE_VOICE_AUDIO_BYTES * 4 / 3) + 8) return null
  const bytes = Buffer.from(value, 'base64')
  return bytes.byteLength > 0 && bytes.byteLength <= MAX_REMOTE_VOICE_AUDIO_BYTES ? new Uint8Array(bytes) : null
}

function remoteMcpServers(value: unknown) {
  const ids = new Set(Array.isArray(value) ? value.map(String) : [])
  return readMcpConfig().servers.filter(server => ids.has(server.id))
}

function remoteError(code: CrewCodeRemoteError['code'], message: string): CrewCodeRemoteError {
  return { code, message }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  response.end(body)
}

async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > limit) throw new Error(`request exceeds ${Math.floor(limit / 1024 / 1024)}MB limit`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  return JSON.parse((await readBody(request, MAX_REQUEST_BYTES)).toString('utf8') || '{}')
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

function capabilitySnapshot(): CrewCodeServerCapabilities {
  return {
    protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION,
    runtime: 'server',
    platform: process.platform,
    features: {
      workspaces: true, filesystem: true, git: true, terminals: true, agents: true,
      attachments: true, mcp: true, github: true, voice: true, editorFormat: true,
    },
  }
}

function safeStaticPath(root: string, urlPath: string): string | null {
  const target = normalize(join(root, urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '')))
  const normalizedRoot = normalize(root)
  return target === normalizedRoot || target.startsWith(normalizedRoot + sep) ? target : null
}

function serveStatic(webRoot: string | undefined, request: IncomingMessage, response: ServerResponse): boolean {
  if (!webRoot || request.method !== 'GET') return false
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  if (pathname.startsWith('/api/')) return false
  let target = safeStaticPath(webRoot, pathname)
  if (!target) return false
  if (!existsSync(target) || !statSync(target).isFile()) target = join(webRoot, 'index.html')
  if (!existsSync(target)) return false
  const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
  response.writeHead(200, {
    'content-type': mime[extname(target)] ?? 'application/octet-stream',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'",
    'x-content-type-options': 'nosniff',
  })
  response.end(readFileSync(target))
  return true
}

export async function startRemoteAccessServer(options: RemoteAccessServerOptions): Promise<RunningRemoteAccessServer> {
  const host = options.host ?? '127.0.0.1'
  const workspaceService = new WorkspaceService(join(options.dataDir, 'workspaces.json'))
  const filesystemService = new FilesystemService()
  const gitService = new GitService()
  const ptyService = new PtyService()
  const transcriptService = new TranscriptService(options.dataDir)
  const agentService = new AgentBridgeService(options.resolveAgentPath ?? (() => null))
  const auth = options.auth ?? new RemoteAccessAuth({ storePath: join(options.dataDir, 'remote-access-sessions.json') })
  const remoteGh = new RemoteGhService()
  const remotePlugins = new RemotePluginService()
  let broadcastOwned = (_ownerId: string, _channel: string, _event: unknown): void => undefined
  const remoteDelegation = new RemoteDelegationService((ownerId, request) => broadcastOwned(ownerId, 'delegation', request))
  const remoteLsp = new RemoteEditorLanguageServer((ownerId, payload) => broadcastOwned(ownerId, payload.type === 'message' ? 'editorLspMessage' : 'editorLspStatus', payload.event))
  const remoteWatch = new RemoteEditorFileWatch((ownerId, event) => broadcastOwned(ownerId, 'editorFileChanged', event))
  const pairingLimiter = new RemoteAccessRateLimiter(REMOTE_PAIR_ATTEMPTS_PER_WINDOW)
  const unauthenticatedLimiter = new RemoteAccessRateLimiter(REMOTE_UNAUTHENTICATED_ATTEMPTS_PER_WINDOW)
  let allowedWorkspaceRoots = (options.allowedWorkspaceRoots?.length ? options.allowedWorkspaceRoots : [homedir()])
    .map(root => realpathSync(root))
  const allowedPath = (candidate: unknown): string => {
    const raw = String(candidate ?? '').trim()
    if (!raw || !existsSync(raw)) throw Object.assign(new Error('path does not exist'), { remoteCode: 'FORBIDDEN' })
    const resolved = realpathSync(raw)
    if (!allowedWorkspaceRoots.some(root => resolved === root || resolved.startsWith(root + sep))) {
      throw Object.assign(new Error('path is outside the server workspace roots'), { remoteCode: 'FORBIDDEN' })
    }
    return resolved
  }
  const attachmentDirectory = (root: string): string => {
    const crewDirectory = join(root, '.crewcode')
    if (!existsSync(crewDirectory)) mkdirSync(crewDirectory, { mode: 0o700 })
    const resolvedCrew = realpathSync(crewDirectory)
    if (resolvedCrew !== root && !resolvedCrew.startsWith(root + sep)) {
      throw Object.assign(new Error('attachment directory escapes workspace'), { remoteCode: 'FORBIDDEN' })
    }
    const directory = join(resolvedCrew, 'attachments')
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 })
    const resolved = realpathSync(directory)
    if (resolved !== root && !resolved.startsWith(root + sep)) {
      throw Object.assign(new Error('attachment directory escapes workspace'), { remoteCode: 'FORBIDDEN' })
    }
    return resolved
  }
  const validChildName = (value: unknown): string => {
    const name = String(value ?? '').trim()
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw new Error('invalid folder name')
    return name
  }
  // Network clients may only address roots explicitly registered in this server's
  // workspace store. Desktop IPC historically accepts any caller-supplied root;
  // carrying that behavior onto the network would expose the whole host filesystem.
  const registeredRoot = (params: Record<string, unknown>): string => {
    const root = allowedPath(params.root)
    if (!workspaceService.list().some(workspace => workspace.path === root)) {
      throw Object.assign(new Error('filesystem root is not a registered workspace'), { remoteCode: 'FORBIDDEN' })
    }
    return root
  }
  const listWorktrees = (repoPath: string) => {
    const cwd = registeredRoot({ root: repoPath })
    if (!existsSync(cwd)) return { worktrees: [] }
    spawnSync('git', ['worktree', 'prune'], { cwd, encoding: 'utf8' })
    const result = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' })
    if (result.status !== 0) return { error: 'not a git repo' }
    return { worktrees: parsePorcelainWorktrees(result.stdout ?? '', cwd) }
  }
  type AttachmentUpload = {
    fd: number
    root: string
    tempPath: string
    finalPath: string
    rel: string
    size: number
    received: number
    nextSequence: number
    touchedAt: number
    hash: ReturnType<typeof createHash>
  }
  const attachmentUploads = new Map<string, AttachmentUpload>()
  const discardAttachmentUpload = (uploadId: string): boolean => {
    const upload = attachmentUploads.get(uploadId)
    if (!upload) return false
    attachmentUploads.delete(uploadId)
    try { closeSync(upload.fd) } catch { /* already closed */ }
    try { unlinkSync(upload.tempPath) } catch { /* already removed */ }
    return true
  }
  const handlers = new Map<string, RpcHandler>([
    ['auth.sessions', () => auth.list()],
    ['auth.revoke', params => ({ revoked: auth.revoke(String(params.sessionId ?? '')) })],
    ['workspaces.list', () => workspaceService.list().filter(workspace => {
      try { allowedPath(workspace.path); return true } catch { return false }
    })],
    ['workspaces.inspectPath', params => {
      const path = allowedPath(params.path)
      if (!statSync(path).isDirectory()) throw new Error('path is not a directory')
      return { ok: true, path }
    }],
    ['workspaces.add', params => workspaceService.add(allowedPath(params.path))],
    ['workspaces.clone', params => {
      const parentDir = allowedPath(params.parentDir)
      if (!statSync(parentDir).isDirectory()) throw new Error('parent is not a directory')
      const url = String(params.url ?? '').trim()
      if (!/^(https?:\/\/|ssh:\/\/|git@[a-z0-9._-]+:)/i.test(url)) return { error: 'only HTTP(S) and SSH repository URLs are allowed' }
      const folderName = params.folderName == null || params.folderName === '' ? undefined : validChildName(params.folderName)
      return workspaceService.cloneRepo(url, parentDir, folderName)
    }],
    ['workspaces.initProject', params => {
      const parentDir = allowedPath(params.parentDir)
      if (!statSync(parentDir).isDirectory()) throw new Error('parent is not a directory')
      return workspaceService.initProject(parentDir, validChildName(params.folderName), params.asGit === true)
    }],
    ['workspaces.remove', params => workspaceService.remove(String(params.id ?? ''))],
    ['workspaces.pin', params => workspaceService.pin(String(params.id ?? ''), params.pinned === true)],
    ['workspaces.rename', params => workspaceService.rename(String(params.id ?? ''), String(params.name ?? ''))],
    ['workspaces.setFolder', params => workspaceService.setFolder(String(params.id ?? ''), typeof params.folder === 'string' ? params.folder : null)],
    ['agents.registry', () => headlessAgentRegistry()],
    ['agents.listModels', params => listHeadlessAgentModels(String(params.provider ?? ''))],
    // Browser clients may inspect the Brain-owned registry, but never submit
    // executable MCP commands or environment values of their own.
    ['mcp.list', () => readMcpConfig()],
    ['voice.availability', () => {
      const availability = voiceProviderAvailability()
      return { ...availability, local: { configured: false, available: false, reason: 'Brain-local voice is not exposed to browser clients yet.' } }
    }],
    ['voice.clientSecret', params => createVoiceClientSecret(params.request as Parameters<typeof createVoiceClientSecret>[0])],
    ['voice.transcribe', params => {
      const provider = params.provider === 'openai' || params.provider === 'xai' ? params.provider : null
      const audio = decodeRemoteVoiceAudio(params.audioBase64)
      if (!provider || !audio) return { ok: false, error: 'Invalid remote dictation request.' }
      return transcribeRemoteVoiceAudio(provider, audio)
    }],
    ['voice.synthesize', async params => {
      const provider = params.provider === 'openai' || params.provider === 'xai' ? params.provider : null
      if (!provider || typeof params.text !== 'string' || typeof params.voice !== 'string') return { ok: false, error: 'Invalid remote speech request.' }
      const result = await synthesizeRemoteVoiceText(provider, params.text, params.voice)
      if (!result.ok || !result.audio) return result
      return { ...result, audio: Buffer.from(result.audio).toString('base64') }
    }],
    ['transcripts.loadAll', () => transcriptService.loadAll()],
    ['transcripts.mtimes', () => transcriptService.mtimes()],
    ['transcripts.recent', params => transcriptService.recent(Number(params.limit ?? 5))],
    ['transcripts.save', params => transcriptService.save(String(params.scopeId ?? ''), params.messages)],
    ['transcripts.saveBatch', params => transcriptService.saveBatch(params.entries as TranscriptBatchEntry[])],
    ['transcripts.remove', params => transcriptService.remove(String(params.scopeId ?? ''))],
    ['worktrees.list', params => listWorktrees(String(params.repoPath ?? ''))],
    ['worktrees.create', params => {
      const repoPath = registeredRoot({ root: params.repoPath })
      // Remote clients may not choose an arbitrary host path. The default
      // placement is constrained by worktree-ops to <repo>/.worktrees/.
      if (params.worktreePath != null) throw Object.assign(new Error('custom worktree paths are unavailable remotely'), { remoteCode: 'FORBIDDEN' })
      return addWorktree(repoPath, String(params.branch ?? ''), { startPoint: typeof params.startPoint === 'string' ? params.startPoint : undefined })
    }],
    ['worktrees.remove', params => {
      const target = String(params.worktreePath ?? '')
      const ownsTarget = workspaceService.list().some(workspace => {
        const listed = listWorktrees(workspace.path)
        return listed.worktrees?.some(worktree => worktree.path === target) === true
      })
      if (!ownsTarget) throw Object.assign(new Error('worktree is not owned by a registered workspace'), { remoteCode: 'FORBIDDEN' })
      return removeWorktree(target)
    }],
    ['fs.readDir', params => filesystemService.readDir(registeredRoot(params), String(params.sub ?? ''))],
    ['fs.readFile', params => filesystemService.readFile(registeredRoot(params), String(params.sub ?? ''))],
    ['fs.readDataUrl', params => filesystemService.readDataUrl(registeredRoot(params), String(params.sub ?? ''))],
    ['fs.writeFile', params => filesystemService.writeFile(registeredRoot(params), String(params.sub ?? ''), String(params.text ?? ''))],
    ['fs.format', params => filesystemService.format(registeredRoot(params), String(params.sub ?? ''), String(params.text ?? ''))],
    ['fs.mkdir', params => filesystemService.mkdir(registeredRoot(params), String(params.sub ?? ''))],
    ['fs.delete', params => filesystemService.delete(registeredRoot(params), String(params.sub ?? ''))],
    ['fs.rename', params => filesystemService.rename(registeredRoot(params), String(params.sub ?? ''), String(params.newName ?? ''))],
    ['fs.listFiles', params => filesystemService.listFiles(registeredRoot(params))],
    ['attachments.begin', params => {
      if (attachmentUploads.size >= MAX_ACTIVE_ATTACHMENT_UPLOADS) throw new Error('too many active attachment uploads')
      const root = registeredRoot({ root: params.root })
      const size = Number(params.size)
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) throw new Error('invalid attachment size')
      const originalName = String(params.name ?? '')
      const safeName = originalName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(0, 100) || 'file'
      const directory = attachmentDirectory(root)
      const uploadId = randomBytes(16).toString('hex')
      const filename = `${Date.now().toString(36)}-${uploadId.slice(0, 8)}-${safeName}`
      const finalPath = normalize(join(directory, filename))
      if (!finalPath.startsWith(normalize(directory) + sep)) throw new Error('attachment path escapes workspace')
      const tempPath = `${finalPath}.${uploadId}.upload`
      const fd = openSync(tempPath, 'wx', 0o600)
      const rel = posix.join('.crewcode', 'attachments', filename)
      attachmentUploads.set(uploadId, {
        fd, root, tempPath, finalPath, rel, size, received: 0, nextSequence: 0,
        touchedAt: Date.now(), hash: createHash('sha256'),
      })
      return { uploadId, chunkBytes: MAX_ATTACHMENT_CHUNK_BYTES }
    }],
    ['attachments.chunk', params => {
      const uploadId = String(params.uploadId ?? '')
      const upload = attachmentUploads.get(uploadId)
      if (!upload) throw new Error('attachment upload not found')
      const sequence = Number(params.sequence)
      if (!Number.isSafeInteger(sequence) || sequence !== upload.nextSequence) {
        discardAttachmentUpload(uploadId)
        throw new Error('attachment chunk sequence rejected')
      }
      const encoded = typeof params.data === 'string' ? params.data : ''
      if (!encoded || encoded.length > Math.ceil(MAX_ATTACHMENT_CHUNK_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        discardAttachmentUpload(uploadId)
        throw new Error('attachment chunk rejected')
      }
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_CHUNK_BYTES || upload.received + bytes.byteLength > upload.size) {
        discardAttachmentUpload(uploadId)
        throw new Error('attachment chunk size rejected')
      }
      let written = 0
      while (written < bytes.byteLength) written += writeSync(upload.fd, bytes, written, bytes.byteLength - written)
      upload.hash.update(bytes)
      upload.received += bytes.byteLength
      upload.nextSequence += 1
      upload.touchedAt = Date.now()
      return { received: upload.received }
    }],
    ['attachments.finish', params => {
      const uploadId = String(params.uploadId ?? '')
      const upload = attachmentUploads.get(uploadId)
      if (!upload) throw new Error('attachment upload not found')
      if (upload.received !== upload.size) {
        discardAttachmentUpload(uploadId)
        throw new Error('attachment upload is incomplete')
      }
      const digest = upload.hash.digest('hex')
      const expectedDigest = typeof params.sha256 === 'string' ? params.sha256.toLowerCase() : ''
      if (!/^[a-f0-9]{64}$/.test(expectedDigest) || digest !== expectedDigest) {
        discardAttachmentUpload(uploadId)
        throw new Error('attachment digest rejected')
      }
      attachmentUploads.delete(uploadId)
      try {
        closeSync(upload.fd)
        renameSync(upload.tempPath, upload.finalPath)
      } catch (error) {
        try { closeSync(upload.fd) } catch { /* already closed */ }
        try { unlinkSync(upload.tempPath) } catch { /* already removed */ }
        throw error
      }
      return { rel: upload.rel, size: upload.size, sha256: digest }
    }],
    ['attachments.cancel', params => ({ canceled: discardAttachmentUpload(String(params.uploadId ?? '')) })],
    ['git.status', params => gitService.status(registeredRoot({ root: params.cwd }))],
    ['git.stage', params => gitService.stage(registeredRoot({ root: params.cwd }), Array.isArray(params.paths) ? params.paths.map(String) : [])],
    ['git.stageAll', params => gitService.stageAll(registeredRoot({ root: params.cwd }))],
    ['git.unstage', params => gitService.unstage(registeredRoot({ root: params.cwd }), Array.isArray(params.paths) ? params.paths.map(String) : [])],
    ['git.diff', params => gitService.diff(registeredRoot({ root: params.cwd }), String(params.path ?? ''), params.staged === true)],
    ['git.changesVsRef', params => gitService.changesVsRef(registeredRoot({ root: params.cwd }), String(params.ref ?? ''))],
    ['git.diffVsRef', params => gitService.diffVsRef(registeredRoot({ root: params.cwd }), String(params.ref ?? ''), String(params.path ?? ''))],
    ['git.log', params => gitService.log(registeredRoot({ root: params.cwd }), Number(params.limit ?? 20))],
    ['git.branches', params => gitService.branches(registeredRoot({ root: params.cwd }))],
    ['git.remotes', params => gitService.remotes(registeredRoot({ root: params.cwd }))],
    ['git.commit', params => gitService.commit(registeredRoot({ root: params.cwd }), String(params.message ?? ''), params.amend === true, params.noSign === true)],
    ['git.push', params => gitService.simple(registeredRoot({ root: params.cwd }), 'push')],
    ['git.pull', params => gitService.simple(registeredRoot({ root: params.cwd }), 'pull')],
    ['git.fetch', params => gitService.simple(registeredRoot({ root: params.cwd }), 'fetch')],
    ['git.init', params => gitService.simple(registeredRoot({ root: params.cwd }), 'init')],
    ['github.status', params => getGitHubStatus(registeredRoot({ root: params.cwd }))],
    ['gh.status', () => getGhStatus()],
    ['gh.prCreate', params => runGh(registeredRoot({ root: params.cwd }), ['pr', 'create', '--fill'])],
    ['gh.prMerge', params => runGh(registeredRoot({ root: params.cwd }), ['pr', 'merge', String(Number(params.number)), '--squash'])],
    ['gh.prApprove', params => runGh(registeredRoot({ root: params.cwd }), ['pr', 'review', String(Number(params.number)), '--approve'])],
    ['gh.loginStart', () => remoteGh.login()],
    ['gh.loginCancel', () => remoteGh.cancel()],
    ['gh.repoCreate', params => remoteGh.createRepository(registeredRoot({ root: params.cwd }), params.options as Parameters<RemoteGhService['createRepository']>[1])],
    ['editor.watchAdd', params => { const root = registeredRoot({ root: params.root }); remoteWatch.add(String(params.__remoteSessionToken), root, String(params.rel ?? '')); return { ok: true } }],
    ['editor.watchRemove', params => { const root = registeredRoot({ root: params.root }); remoteWatch.remove(String(params.__remoteSessionToken), root, String(params.rel ?? '')); return { ok: true } }],
    ['editor.lspStart', params => remoteLsp.start(String(params.__remoteSessionToken), registeredRoot({ root: params.root }))],
    ['editor.lspSend', params => remoteLsp.send(String(params.__remoteSessionToken), String(params.handleId ?? ''), String(params.message ?? ''))],
    ['editor.lspStop', params => remoteLsp.stop(String(params.__remoteSessionToken), String(params.handleId ?? ''))],
    ['delegation.enable', async params => ({ ok: true, credentials: await remoteDelegation.enable(String(params.__remoteSessionToken), String(params.sessionId ?? ''), params.policy as Parameters<RemoteDelegationService['enable']>[2]) })],
    ['delegation.disable', params => { remoteDelegation.disable(String(params.__remoteSessionToken), String(params.sessionId ?? '')); return { ok: true } }],
    ['delegation.respond', params => { remoteDelegation.respond(String(params.__remoteSessionToken), String(params.id ?? ''), params.result as Parameters<RemoteDelegationService['respond']>[2]); return { ok: true } }],
    ['plugins.list', () => remotePlugins.load()],
    ['plugins.resolveTab', params => remotePlugins.resolve(String(params.registrationId ?? ''))],
    ['plugins.invoke', params => remotePlugins.invoke(params.request as Parameters<RemotePluginService['invoke']>[0], value => registeredRoot({ root: value }))],
    ['git.checkout', params => gitService.checkout(registeredRoot({ root: params.cwd }), String(params.branch ?? ''), false)],
    ['git.createBranch', params => gitService.checkout(registeredRoot({ root: params.cwd }), String(params.name ?? ''), true)],
    ['git.merge', params => gitService.merge(registeredRoot({ root: params.cwd }), String(params.ref ?? ''))],
    ['git.mergeAbort', params => gitService.mergeAbort(registeredRoot({ root: params.cwd }))],
    ['git.mergeContinue', params => gitService.mergeContinue(registeredRoot({ root: params.cwd }))],
    ['git.resolveConflict', params => gitService.resolveConflict(registeredRoot({ root: params.cwd }), String(params.file ?? ''), String(params.strategy ?? ''))],
    ['pty.create', params => ptyService.create({
      paneId: String(params.paneId ?? ''),
      cwd: registeredRoot({ root: params.cwd }),
      cols: typeof params.cols === 'number' ? params.cols : undefined,
      rows: typeof params.rows === 'number' ? params.rows : undefined,
      shell: typeof params.shell === 'string' ? params.shell : undefined,
      argv: Array.isArray(params.argv) ? params.argv.map(String) : undefined,
    })],
    ['pty.write', params => { ptyService.write(String(params.paneId ?? ''), String(params.data ?? '')); return { ok: true } }],
    ['pty.resize', params => { ptyService.resize(String(params.paneId ?? ''), Number(params.cols), Number(params.rows)); return { ok: true } }],
    ['pty.kill', params => { ptyService.kill(String(params.paneId ?? '')); return { ok: true } }],
    ['bridge.start', params => {
      const cwd = registeredRoot({ root: params.cwd })
      // Never accept API keys, arbitrary environment variables, or additional
      // filesystem grants from a network client. Secrets resolve server-side.
      const opts: BridgeStartOpts = {
        bridgeId: String(params.bridgeId ?? ''),
        provider: String(params.provider ?? '') as BridgeStartOpts['provider'],
        cwd,
        model: typeof params.model === 'string' ? params.model : undefined,
        mode: params.mode === 'ask' || params.mode === 'plan' || params.mode === 'build' || params.mode === 'full' ? params.mode : 'build',
        toolPolicy: params.toolPolicy === 'read-only' ? 'read-only' : 'default',
        thinking: typeof params.thinking === 'string' ? params.thinking as BridgeStartOpts['thinking'] : undefined,
        conversationKey: typeof params.conversationScopeKey === 'string' ? `web:${params.conversationScopeKey}` : undefined,
        freshSession: params.freshSession === true,
        suppressProviderHistoryReplay: params.suppressProviderHistoryReplay === true,
        // Resolve opaque selections against the Brain's local registry. This is
        // intentionally not `params.mcpServers`: accepting command/env objects
        // from a browser would turn bridge.start into arbitrary execution.
        mcpServers: remoteMcpServers(params.mcpServerIds),
      }
      return agentService.start(opts)
    }],
    ['bridge.prompt', params => agentService.prompt(String(params.bridgeId ?? ''), String(params.text ?? ''), params.options as PromptOptions | undefined)],
    ['bridge.compact', params => agentService.compact(String(params.bridgeId ?? ''))],
    ['bridge.handoff', params => {
      const sourceScope = String(params.sourceConversationKey ?? '')
      return agentService.handoff(
        String(params.bridgeId ?? ''),
        sourceScope ? `web:${sourceScope}` : '',
        params.options && typeof params.options === 'object' ? params.options as HandoffPromptOptions : {},
      )
    }],
    ['bridge.removeFollowUp', params => agentService.removeFollowUp(String(params.bridgeId ?? ''), String(params.followUpId ?? ''))],
    ['bridge.respondUserRequest', params => agentService.respond(params.response as Parameters<AgentBridgeService['respond']>[0])],
    // Returns { deferred, reason } when the change was refused mid-turn, so a
    // remote client can show that its request lands on the next turn.
    ['bridge.setMode', params => agentService.setMode(String(params.bridgeId ?? ''), params.mode as BridgeStartOpts['mode'])],
    ['bridge.abort', params => agentService.abort(String(params.bridgeId ?? ''))],
    ['bridge.stop', params => agentService.stop(String(params.bridgeId ?? ''))],
  ])

  const server: Server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      if (pathname.startsWith('/api/') && !browserOriginAllowed(request, options.publicOrigins)) {
        sendJson(response, 403, { error: remoteError('FORBIDDEN', 'browser origin is not allowed') })
        return
      }
      if (request.method === 'GET' && pathname === '/api/v1/capabilities') {
        sendJson(response, 200, capabilitySnapshot())
        return
      }
      if (request.method === 'GET' && pathname.startsWith('/api/v1/plugin-assets/')) {
        const [token, ...parts] = pathname.slice('/api/v1/plugin-assets/'.length).split('/')
        const asset = remotePlugins.asset(token || '', parts.join('/'))
        if (!asset) { sendJson(response, 404, { error: remoteError('FORBIDDEN', 'plugin asset grant invalid or expired') }); return }
        response.writeHead(200, { 'content-type': asset.contentType, 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'self'", 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }); response.end(asset.body); return
      }
      if (request.method === 'POST' && pathname === '/api/v1/pair') {
        const limited = pairingLimiter.consume(remotePeerKey(request))
        if (!limited.allowed) {
          response.setHeader('retry-after', String(limited.retryAfterSeconds))
          sendJson(response, 429, { error: remoteError('FORBIDDEN', `too many pairing attempts; retry in ${limited.retryAfterSeconds}s`) })
          return
        }
        const body = await readJson(request) as { token?: unknown }
        const exchanged = auth.exchange(typeof body.token === 'string' ? body.token : '')
        if (exchanged.error) sendJson(response, 401, { error: remoteError('UNAUTHENTICATED', exchanged.error) })
        else sendJson(response, 200, { sessionToken: exchanged.sessionToken })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/attachments') {
        if (!auth.authenticate(bearer(request))) {
          const limited = unauthenticatedLimiter.consume(remotePeerKey(request))
          if (!limited.allowed) response.setHeader('retry-after', String(limited.retryAfterSeconds))
          sendJson(response, limited.allowed ? 401 : 429, { error: remoteError('UNAUTHENTICATED', limited.allowed ? 'valid device session required' : `too many authentication attempts; retry in ${limited.retryAfterSeconds}s`) })
          return
        }
        const url = new URL(request.url ?? '/', 'http://localhost')
        const root = registeredRoot({ root: url.searchParams.get('root') ?? '' })
        const originalName = url.searchParams.get('name') ?? ''
        const safeName = originalName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_').slice(0, 100) || 'file'
        const data = await readBody(request, MAX_ATTACHMENT_BYTES)
        const directory = attachmentDirectory(root)
        const filename = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safeName}`
        const target = normalize(join(directory, filename))
        if (!target.startsWith(normalize(directory) + sep)) throw new Error('attachment path escapes workspace')
        writeFileSync(target, data)
        // rel crosses the wire to a web client, so it must be POSIX on every
        // host. Native join() would hand Windows clients ".crewcode\attachments\x".
        sendJson(response, 200, { rel: posix.join('.crewcode', 'attachments', filename) })
        return
      }
      if (request.method === 'POST' && pathname === '/api/v1/rpc') {
        if (!auth.authenticate(bearer(request))) {
          const limited = unauthenticatedLimiter.consume(remotePeerKey(request))
          if (!limited.allowed) response.setHeader('retry-after', String(limited.retryAfterSeconds))
          sendJson(response, limited.allowed ? 401 : 429, { error: remoteError('UNAUTHENTICATED', limited.allowed ? 'valid device session required' : `too many authentication attempts; retry in ${limited.retryAfterSeconds}s`) })
          return
        }
        const body = await readJson(request) as Partial<CrewCodeRemoteRequest>
        const id = typeof body.id === 'string' ? body.id : ''
        if (body.protocolVersion !== CREWCODE_REMOTE_PROTOCOL_VERSION || !id || typeof body.method !== 'string' || !body.params || typeof body.params !== 'object') {
          const invalid: CrewCodeRemoteResponse = { protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id, ok: false, error: remoteError('INVALID_REQUEST', 'invalid RPC envelope') }
          sendJson(response, 400, invalid)
          return
        }
        const handler = handlers.get(body.method)
        if (!handler) {
          const unsupported: CrewCodeRemoteResponse = { protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id, ok: false, error: remoteError('UNSUPPORTED', `unsupported method: ${body.method}`) }
          sendJson(response, 404, unsupported)
          return
        }
        let result: unknown
        try {
          result = await handler({ ...(body.params as Record<string, unknown>), __remoteSessionToken: bearer(request) })
        } catch (error) {
          const code = (error as Error & { remoteCode?: string }).remoteCode === 'FORBIDDEN' ? 'FORBIDDEN' : 'INTERNAL'
          const failure: CrewCodeRemoteResponse = { protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id, ok: false, error: remoteError(code, (error as Error).message) }
          sendJson(response, code === 'FORBIDDEN' ? 403 : 500, failure)
          return
        }
        const success: CrewCodeRemoteResponse = { protocolVersion: CREWCODE_REMOTE_PROTOCOL_VERSION, id, ok: true, result }
        sendJson(response, 200, success)
        return
      }
      if (serveStatic(options.webRoot, request, response)) return
      sendJson(response, 404, { error: remoteError('UNSUPPORTED', 'route not found') })
    } catch (error) {
      const forbidden = (error as Error & { remoteCode?: string }).remoteCode === 'FORBIDDEN'
      sendJson(response, forbidden ? 403 : 400, { error: remoteError(forbidden ? 'FORBIDDEN' : 'INVALID_REQUEST', (error as Error).message) })
    }
  })

  const attachmentSweep = setInterval(() => {
    const cutoff = Date.now() - ATTACHMENT_UPLOAD_IDLE_MS
    for (const [uploadId, upload] of attachmentUploads) if (upload.touchedAt < cutoff) discardAttachmentUpload(uploadId)
  }, 30_000)
  attachmentSweep.unref()

  const sockets = new Set<WebSocket>()
  const socketOwners = new Map<WebSocket, string>()
  const websocketServer = new WebSocketServer({ noServer: true, handleProtocols: protocols => protocols.has('crewcode.v1') ? 'crewcode.v1' : false })
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim())
    const token = protocols.find(value => value !== 'crewcode.v1') ?? ''
    if (pathname !== '/api/v1/events' || !browserOriginAllowed(request, options.publicOrigins) || !protocols.includes('crewcode.v1') || !auth.authenticate(token)) {
      const limited = unauthenticatedLimiter.consume(remotePeerKey(request))
      socket.write(`HTTP/1.1 ${limited.allowed ? '401 Unauthorized' : '429 Too Many Requests'}\r\nConnection: close\r\n${limited.allowed ? '' : `Retry-After: ${limited.retryAfterSeconds}\r\n`}\r\n`)
      socket.destroy()
      return
    }
    websocketServer.handleUpgrade(request, socket, head, ws => { socketOwners.set(ws, token); websocketServer.emit('connection', ws, request) })
  })
  websocketServer.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket); socketOwners.delete(socket) })
  })
  const broadcast = (channel: 'pty' | 'bridge' | 'gh', event: unknown): void => {
    const message = JSON.stringify({ channel, event })
    for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(message)
  }
  broadcastOwned = (ownerId, channel, event) => {
    const message = JSON.stringify({ channel, event })
    for (const socket of sockets) if (socketOwners.get(socket) === ownerId && socket.readyState === WebSocket.OPEN) socket.send(message)
  }
  const unsubscribePty = ptyService.subscribe(event => broadcast('pty', event))
  const unsubscribeAgent = agentService.subscribe((event: BridgeEvent) => broadcast('bridge', event))
  const unsubscribeGh = remoteGh.subscribe(event => broadcast('gh', event))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind a TCP address')
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host
  const url = `http://${displayHost}:${address.port}`
  const pairing = auth.issuePairing()
  return {
    host,
    port: address.port,
    url,
    pairingToken: pairing.token,
    pairingUrl: `${url}/pair#token=${encodeURIComponent(pairing.token)}`,
    updateAllowedWorkspaceRoots(roots) { allowedWorkspaceRoots = roots.map(root => realpathSync(root)) },
    async stopResources(input) {
      const permitted = (cwd: string): boolean => input.allowedRoots.some(root => cwd === root || cwd.startsWith(root + sep))
      const paneIds = input.terminal ? ptyService.killWhere(() => true) : ptyService.killWhere(cwd => !permitted(cwd))
      const bridgeIds = await agentService.stopWhere(entry => input.agent || !permitted(entry.cwd))
      return { paneIds, bridgeIds }
    },
    close: () => new Promise<void>((resolve, reject) => {
      clearInterval(attachmentSweep)
      for (const uploadId of [...attachmentUploads.keys()]) discardAttachmentUpload(uploadId)
      unsubscribePty()
      unsubscribeAgent()
      unsubscribeGh()
      ptyService.killAll()
      remoteWatch.stop()
      remoteLsp.stopAll()
      remoteDelegation.stop()
      void agentService.stopAll()
      for (const socket of sockets) socket.close()
      websocketServer.close()
      server.close(error => error ? reject(error) : resolve())
    }),
  }
}

import { app, ipcMain, type WebContents } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { randomUUID } from 'crypto'
import type { AgentProc } from './agents/agent-spawn'
import { spawnAgentProcess } from './agents/agent-spawn'
import { isRemoteRoot, parseRemoteTarget } from './remote/ssh-target'
import type { LanguageServerMessageEvent, LanguageServerStartResult, LanguageServerStatus, LanguageServerStatusEvent } from '../shared/language-server-types'
import { frameLanguageServerMessage, MAX_LANGUAGE_SERVER_MESSAGE_BYTES, parseLanguageServerFrames } from './language-server-framing'


type Handle = { id: string; owner: WebContents }
type WorkspaceServer = {
  root: string
  rootUri: string
  proc: AgentProc
  handles: Map<string, Handle>
  buffer: Buffer
  expectedBytes: number | null
  stopTimer: ReturnType<typeof setTimeout> | null
  stopped: boolean
  stderr: string
}

const servers = new Map<string, WorkspaceServer>()
const serverStarts = new Map<string, Promise<WorkspaceServer>>()
const handles = new Map<string, WorkspaceServer>()

function remoteFileUri(path: string): string {
  return `file://${path.split('/').map((part, index) => index === 0 ? '' : encodeURIComponent(part)).join('/')}`
}

function sendStatus(server: WorkspaceServer, status: LanguageServerStatus, error?: string): void {
  for (const handle of server.handles.values()) {
    if (handle.owner.isDestroyed()) continue
    const event: LanguageServerStatusEvent = { handleId: handle.id, status, ...(error ? { error } : {}) }
    handle.owner.send('editorLanguageServer:status', event)
  }
}

function sendMessage(server: WorkspaceServer, message: string): void {
  for (const handle of server.handles.values()) {
    if (handle.owner.isDestroyed()) continue
    const event: LanguageServerMessageEvent = { handleId: handle.id, message }
    handle.owner.send('editorLanguageServer:message', event)
  }
}

async function createServer(root: string): Promise<WorkspaceServer> {
  const remote = isRemoteRoot(root)
  const target = remote ? parseRemoteTarget(root) : null
  if (remote && !target) throw new Error('invalid SSH workspace URI')

  const command = remote ? 'typescript-language-server' : process.execPath
  const args = remote
    ? ['--stdio']
    : [join(app.getAppPath(), 'node_modules', 'typescript-language-server', 'lib', 'cli.mjs'), '--stdio']
  const spawned = await spawnAgentProcess({
    command,
    args,
    cwd: root,
    // Packaged Electron doubles as Node for the bundled local language server.
    env: remote ? undefined : { ELECTRON_RUN_AS_NODE: '1' },
  })
  const server: WorkspaceServer = {
    root,
    rootUri: target ? remoteFileUri(target.path) : pathToFileURL(root).href,
    proc: spawned.proc,
    handles: new Map(),
    buffer: Buffer.alloc(0),
    expectedBytes: null,
    stopTimer: null,
    stopped: false,
    stderr: '',
  }

  spawned.proc.stdout.on('data', chunk => {
    try {
      for (const message of parseLanguageServerFrames(server, Buffer.from(chunk))) sendMessage(server, message)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      sendStatus(server, 'error', detail)
      stopServer(server)
    }
  })
  spawned.proc.stderr.on('data', chunk => {
    server.stderr = (server.stderr + Buffer.from(chunk).toString('utf8')).slice(-4_000)
  })
  spawned.proc.on('error', error => {
    sendStatus(server, 'error', error.message)
    stopServer(server)
  })
  spawned.proc.on('close', code => {
    if (server.stopped) return
    const suffix = server.stderr.trim().split(/\r?\n/).pop()
    const remoteHint = isRemoteRoot(server.root) && (code === 127 || /not found/i.test(suffix ?? ''))
      ? ' Install typescript and typescript-language-server on the remote host and ensure they are on PATH.'
      : ''
    sendStatus(server, 'error', `${suffix || `TypeScript language server exited ${code ?? 'unexpectedly'}`}${remoteHint}`)
    stopServer(server)
  })
  return server
}

function stopServer(server: WorkspaceServer): void {
  if (server.stopped) return
  server.stopped = true
  if (server.stopTimer) clearTimeout(server.stopTimer)
  try { server.proc.stdin.end() } catch { /* already closed */ }
  try { server.proc.kill() } catch { /* already closed */ }
  servers.delete(server.root)
  for (const id of server.handles.keys()) handles.delete(id)
  sendStatus(server, 'stopped')
  server.handles.clear()
}

function releaseHandle(handleId: string, ownerId?: number): void {
  const server = handles.get(handleId)
  const handle = server?.handles.get(handleId)
  if (!server || !handle || (ownerId != null && handle.owner.id !== ownerId)) return
  handles.delete(handleId)
  server.handles.delete(handleId)
  if (server.handles.size || server.stopped) return
  stopServer(server)
}

async function start(root: string, owner: WebContents): Promise<LanguageServerStartResult> {
  if (!root || typeof root !== 'string') return { ok: false, error: 'workspace root is required' }
  let server = servers.get(root)
  try {
    if (!server || server.stopped) {
      let pending = serverStarts.get(root)
      if (!pending) {
        pending = createServer(root)
        serverStarts.set(root, pending)
      }
      try {
        server = await pending
        servers.set(root, server)
      } finally {
        if (serverStarts.get(root) === pending) serverStarts.delete(root)
      }
    }
    if (server.stopTimer) {
      clearTimeout(server.stopTimer)
      server.stopTimer = null
    }
    const handle: Handle = { id: randomUUID(), owner }
    server.handles.set(handle.id, handle)
    handles.set(handle.id, server)
    owner.once('destroyed', () => releaseHandle(handle.id))
    queueMicrotask(() => sendStatus(server!, 'ready'))
    return { ok: true, handleId: handle.id, rootUri: server.rootUri }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const remoteHint = isRemoteRoot(root) && /not found|127|ENOENT/i.test(detail)
      ? ' Install typescript-language-server on the remote host and ensure it is on PATH.'
      : ''
    return { ok: false, error: `${detail}${remoteHint}` }
  }
}

export function registerEditorLanguageServerIpc(): void {
  ipcMain.handle('editorLanguageServer:start', (event, root: string) => start(root, event.sender))
  ipcMain.on('editorLanguageServer:send', (event, handleId: string, message: string) => {
    const server = handles.get(handleId)
    const handle = server?.handles.get(handleId)
    if (!server || !handle || handle.owner.id !== event.sender.id || server.stopped) return
    if (typeof message !== 'string' || Buffer.byteLength(message, 'utf8') > MAX_LANGUAGE_SERVER_MESSAGE_BYTES) return
    try { JSON.parse(message) } catch { return }
    server.proc.stdin.write(frameLanguageServerMessage(message))
  })
  ipcMain.on('editorLanguageServer:stop', (event, handleId: string) => releaseHandle(handleId, event.sender.id))
}

export function stopAllEditorLanguageServers(): void {
  for (const server of [...servers.values()]) stopServer(server)
}

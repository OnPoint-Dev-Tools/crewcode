import { randomUUID } from 'crypto'
import { createRequire } from 'module'
import { pathToFileURL } from 'url'
import type { AgentProc } from './agents/agent-spawn'
import { spawnAgentProcess } from './agents/agent-spawn'
import { frameLanguageServerMessage, MAX_LANGUAGE_SERVER_MESSAGE_BYTES, parseLanguageServerFrames } from './language-server-framing'
import type { LanguageServerMessageEvent, LanguageServerStartResult, LanguageServerStatusEvent } from '../shared/language-server-types'

type RemoteLspEvent = { type: 'message'; event: LanguageServerMessageEvent } | { type: 'status'; event: LanguageServerStatusEvent }
type Handle = { id: string; ownerId: string; root: string; proc: AgentProc; buffer: Buffer; expectedBytes: number | null; stderr: string; stopped: boolean }

export class RemoteEditorLanguageServer {
  private handles = new Map<string, Handle>()
  constructor(private readonly emit: (ownerId: string, event: RemoteLspEvent) => void) {}

  async start(ownerId: string, root: string): Promise<LanguageServerStartResult> {
    if (!root) return { ok: false, error: 'workspace root is required' }
    try {
      const cli = createRequire(import.meta.url).resolve('typescript-language-server/lib/cli.mjs')
      const spawned = await spawnAgentProcess({ command: process.execPath, args: [cli, '--stdio'], cwd: root, env: { ELECTRON_RUN_AS_NODE: '1' } })
      const handle: Handle = { id: randomUUID(), ownerId, root, proc: spawned.proc, buffer: Buffer.alloc(0), expectedBytes: null, stderr: '', stopped: false }
      this.handles.set(handle.id, handle)
      spawned.proc.stdout.on('data', chunk => {
        try {
          for (const message of parseLanguageServerFrames(handle, Buffer.from(chunk))) this.emit(ownerId, { type: 'message', event: { handleId: handle.id, message } })
        } catch (error) { this.fail(handle, error instanceof Error ? error.message : String(error)) }
      })
      spawned.proc.stderr.on('data', chunk => { handle.stderr = (handle.stderr + Buffer.from(chunk).toString('utf8')).slice(-4_000) })
      spawned.proc.on('error', error => this.fail(handle, error.message))
      spawned.proc.on('close', code => { if (!handle.stopped) this.fail(handle, handle.stderr.trim() || `TypeScript language server exited ${code ?? 'unexpectedly'}`) })
      queueMicrotask(() => this.emit(ownerId, { type: 'status', event: { handleId: handle.id, status: 'ready' } }))
      return { ok: true, handleId: handle.id, rootUri: pathToFileURL(root).href }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }

  send(ownerId: string, handleId: string, message: string): { ok: boolean; error?: string } {
    const handle = this.handles.get(handleId)
    if (!handle || handle.ownerId !== ownerId || handle.stopped) return { ok: false, error: 'language-server handle not owned by this browser session' }
    if (typeof message !== 'string' || Buffer.byteLength(message) > MAX_LANGUAGE_SERVER_MESSAGE_BYTES) return { ok: false, error: 'invalid language-server message' }
    try { JSON.parse(message); handle.proc.stdin.write(frameLanguageServerMessage(message)); return { ok: true } }
    catch { return { ok: false, error: 'invalid language-server JSON' } }
  }

  stop(ownerId: string, handleId: string): { ok: boolean } {
    const handle = this.handles.get(handleId)
    if (handle?.ownerId === ownerId) this.release(handle)
    return { ok: true }
  }

  stopOwner(ownerId: string): void { for (const handle of [...this.handles.values()]) if (handle.ownerId === ownerId) this.release(handle) }
  stopAll(): void { for (const handle of [...this.handles.values()]) this.release(handle) }
  private fail(handle: Handle, error: string): void { this.emit(handle.ownerId, { type: 'status', event: { handleId: handle.id, status: 'error', error } }); this.release(handle) }
  private release(handle: Handle): void { if (handle.stopped) return; handle.stopped = true; this.handles.delete(handle.id); try { handle.proc.stdin.end() } catch {}; try { handle.proc.kill() } catch {}; this.emit(handle.ownerId, { type: 'status', event: { handleId: handle.id, status: 'stopped' } }) }
}

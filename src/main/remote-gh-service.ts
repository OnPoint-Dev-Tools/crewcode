import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { publishRepository, type PublishRepoOpts } from './github-publish'

export type RemoteGhAuthEvent = { type: 'code' | 'url' | 'success' | 'failure' | 'cancelled' | 'output'; code?: string; url?: string; text?: string; error?: string }

export class RemoteGhService {
  private child: ChildProcess | null = null
  private listeners = new Set<(event: RemoteGhAuthEvent) => void>()
  subscribe(listener: (event: RemoteGhAuthEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(event: RemoteGhAuthEvent): void { for (const listener of this.listeners) listener(event) }
  login(): { ok: boolean; error?: string } {
    if (this.child) return { ok: false, error: 'login already in progress' }
    const child = spawn('gh', ['auth', 'login', '--web', '--git-protocol', 'https', '--hostname', 'github.com'], { env: process.env })
    this.child = child
    const chunk = (buffer: Buffer) => { const text = buffer.toString('utf8'); for (const line of text.split(/\r?\n/).filter(Boolean)) { this.emit({ type: 'output', text: line }); const code = line.match(/one[- ]?time code[:\s]+([A-Z0-9-]{4,})/i)?.[1]; if (code) this.emit({ type: 'code', code }); const url = line.match(/https?:\/\/[^\s]+/i)?.[0]; if (url) this.emit({ type: 'url', url }); if (/press enter/i.test(line)) child.stdin?.write('\n') } }
    child.stdout?.on('data', chunk); child.stderr?.on('data', chunk)
    child.on('error', error => { this.child = null; this.emit({ type: 'failure', error: error.message }) })
    child.on('exit', code => { this.child = null; this.emit(code === 0 ? { type: 'success' } : { type: 'failure', error: `gh auth login exited ${code}` }) })
    return { ok: true }
  }
  cancel(): { ok: boolean } { if (this.child) { this.child.kill('SIGTERM'); this.child = null; this.emit({ type: 'cancelled' }) } return { ok: true } }
  createRepository(cwd: string, opts: PublishRepoOpts): { ok: boolean; output: string; error?: string } {
    return publishRepository(opts, (command, args) => { const result = spawnSync(command, args, { cwd, encoding: 'utf8' }); const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(); return result.status === 0 ? { ok: true, output } : { ok: false, output, error: output || `${command} failed` } })
  }
}

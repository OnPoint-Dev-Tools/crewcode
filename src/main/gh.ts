import { ipcMain, BrowserWindow, shell } from 'electron'
import { spawn, spawnSync, ChildProcess } from 'child_process'
import { publishRepository, type PublishRepoOpts } from './github-publish'

export interface GhStatus {
  available: boolean
  loggedIn:  boolean
  user:      string | null
  host:      string | null
  raw:       string
  error?:    string
}

export interface GhAuthEvent {
  type: 'code' | 'url' | 'success' | 'failure' | 'cancelled' | 'output'
  code?: string         // one-time device code
  url?:  string         // verification URL
  text?: string         // raw log line for the output type
  error?: string
}

function ghAvailable(): boolean {
  try {
    const r = spawnSync('gh', ['--version'], { encoding: 'utf8' })
    return r.status === 0
  } catch {
    return false
  }
}

function ghStatus(): GhStatus {
  if (!ghAvailable()) {
    return { available: false, loggedIn: false, user: null, host: null, raw: '', error: 'gh CLI not found in PATH' }
  }
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' })
  const raw = (r.stdout ?? '') + (r.stderr ?? '')
  // `gh auth status` exits 0 when logged in, non-zero when not.
  const loggedIn = r.status === 0
  const userMatch = raw.match(/account\s+(\S+)/i) ?? raw.match(/Logged in to\s+(\S+)\s+as\s+(\S+)/i)
  const hostMatch = raw.match(/Logged in to\s+(\S+)/i)
  const user = userMatch ? (userMatch[2] ?? userMatch[1]) : null
  const host = hostMatch ? hostMatch[1] : null
  return { available: true, loggedIn, user, host, raw }
}

let activeLogin: ChildProcess | null = null

function broadcast(event: GhAuthEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('gh:authEvent', event)
  }
}

function startLogin(): { ok: boolean; error?: string } {
  if (activeLogin) return { ok: false, error: 'login already in progress' }
  if (!ghAvailable()) return { ok: false, error: 'gh CLI not found in PATH' }

  // --web triggers the device-code flow, --git-protocol https avoids the ssh
  // prompt, --hostname github.com skips the host prompt. -p remains
  // interactive on some versions so we still parse from stdout/stderr.
  const child = spawn(
    'gh',
    ['auth', 'login', '--web', '--git-protocol', 'https', '--hostname', 'github.com'],
    { env: process.env },
  )
  activeLogin = child

  const onChunk = (buf: Buffer) => {
    const text = buf.toString('utf8')
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      broadcast({ type: 'output', text: line })

      const codeMatch = line.match(/one[- ]?time code[:\s]+([A-Z0-9-]{4,})/i)
      if (codeMatch) broadcast({ type: 'code', code: codeMatch[1] })

      const urlMatch = line.match(/(https?:\/\/[^\s]+)/i)
      if (urlMatch) {
        broadcast({ type: 'url', url: urlMatch[1] })
        shell.openExternal(urlMatch[1]).catch(() => { /* sandbox / no browser */ })
      }

      // gh prints "Press Enter to open github.com in your browser..." and
      // then blocks on stdin. We already opened the browser ourselves via
      // shell.openExternal — push the newline so gh proceeds.
      if (/press enter/i.test(line)) {
        try { child.stdin?.write('\n') } catch { /* stdin already closed */ }
      }
    }
  }

  child.stdout?.on('data', onChunk)
  child.stderr?.on('data', onChunk)
  child.on('exit', (code) => {
    activeLogin = null
    if (code === 0) broadcast({ type: 'success' })
    else            broadcast({ type: 'failure', error: `gh auth login exited ${code}` })
  })

  return { ok: true }
}

function cancelLogin(): { ok: boolean } {
  if (activeLogin) {
    try { activeLogin.kill('SIGTERM') } catch { /* already exiting */ }
    activeLogin = null
    broadcast({ type: 'cancelled' })
  }
  return { ok: true }
}

function logout(): { ok: boolean; error?: string } {
  if (!ghAvailable()) return { ok: false, error: 'gh CLI not found in PATH' }
  const r = spawnSync('gh', ['auth', 'logout', '--hostname', 'github.com'], { encoding: 'utf8' })
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || '').trim() || 'gh auth logout failed' }
  return { ok: true }
}

/** Run a gh subcommand in a repo and collapse the result into { ok, output, error }. */
function runGh(cwd: string, args: string[]): { ok: boolean; output: string; error?: string } {
  if (!ghAvailable()) return { ok: false, output: '', error: 'gh CLI not found in PATH' }
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8' })
  const output = ((r.stdout ?? '') + (r.stderr ?? '')).trim()
  if (r.status !== 0) return { ok: false, output, error: output || `gh ${args[0]} ${args[1]} failed` }
  return { ok: true, output }
}

export type RepoCreateOpts = PublishRepoOpts

/** Publish a local folder completely, including its first commit and push. */
function repoCreate(cwd: string, opts: RepoCreateOpts): { ok: boolean; output: string; error?: string } {
  if (!ghAvailable()) return { ok: false, output: '', error: 'gh CLI not found in PATH' }

  return publishRepository(opts, (command, args) => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8' })
    const output = ((r.stdout ?? '') + (r.stderr ?? '')).trim()
    if (r.status !== 0) return { ok: false, output, error: output || `${command} ${args.join(' ')} failed` }
    return { ok: true, output }
  })
}

export function registerGhIpc(): void {
  ipcMain.handle('gh:status', () => ghStatus())
  ipcMain.handle('gh:loginStart', () => startLogin())
  ipcMain.handle('gh:loginCancel', () => cancelLogin())
  ipcMain.handle('gh:logout', () => logout())

  // Pull-request operations for the Git Sidebar.
  ipcMain.handle('gh:prCreate',  (_e, cwd: string) =>
    runGh(cwd, ['pr', 'create', '--fill']))
  ipcMain.handle('gh:prMerge',   (_e, cwd: string, num: number) =>
    runGh(cwd, ['pr', 'merge', String(num), '--squash']))
  ipcMain.handle('gh:prApprove', (_e, cwd: string, num: number) =>
    runGh(cwd, ['pr', 'review', String(num), '--approve']))

  // Publish a local folder to GitHub (init + first commit + repo create + push).
  ipcMain.handle('gh:repoCreate', (_e, cwd: string, opts: RepoCreateOpts) =>
    repoCreate(cwd, opts))
}

export function killActiveGhLogin(): void {
  if (activeLogin) {
    try { activeLogin.kill('SIGKILL') } catch { /* already gone */ }
    activeLogin = null
  }
}

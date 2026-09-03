import { ipcMain, BrowserWindow, shell } from 'electron'
import { spawn, spawnSync, ChildProcess } from 'child_process'
import { publishRepository, type PublishRepoOpts } from './github-publish'
import { getGitHubAvatar, getPullRequestCatalogue, getPullRequestCheckLog, getPullRequestChecksContext, getPullRequestCreateContext, getPullRequestDetail, getPullRequestDiff, getPullRequestManagementContext, getPullRequestReviewContext, ghAvailable, getGhStatus, preparePullRequestConflictResolution, pullRequestActionArgs, pullRequestCommentArgs, pullRequestCreateArgs, pullRequestEditArgs, pullRequestMergeArgs, pullRequestMetadataArgs, pullRequestReviewArgs, rerunPullRequestCheck, runGh, submitPullRequestReview, updatePullRequestMergeAutomation, updatePullRequestReviewThread, updatePullRequestViewedFile } from './github-service'
import type { GitHubMergeMethod, GitHubPullRequestCheckRerunOptions, GitHubPullRequestCreateOptions, GitHubPullRequestEditOptions, GitHubPullRequestMergeAutomationOptions, GitHubPullRequestMetadataOptions, GitHubPullRequestReviewOptions, GitHubPullRequestViewedFileOptions } from '../shared/github-types'

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

let activeLogin: ChildProcess | null = null
const authListeners = new Set<(event: GhAuthEvent) => void>()

function broadcast(event: GhAuthEvent): void {
  for (const listener of authListeners) listener(event)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('gh:authEvent', event)
  }
}

export function startGhLogin(): { ok: boolean; error?: string } {
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

export function cancelGhLogin(): { ok: boolean } {
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

export type RepoCreateOpts = PublishRepoOpts

/** Publish a local folder completely, including its first commit and push. */
export function createGhRepository(cwd: string, opts: RepoCreateOpts): { ok: boolean; output: string; error?: string } {
  if (!ghAvailable()) return { ok: false, output: '', error: 'gh CLI not found in PATH' }

  return publishRepository(opts, (command, args) => {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8' })
    const output = ((r.stdout ?? '') + (r.stderr ?? '')).trim()
    if (r.status !== 0) return { ok: false, output, error: output || `${command} ${args.join(' ')} failed` }
    return { ok: true, output }
  })
}

export function registerGhIpc(): void {
  ipcMain.handle('gh:status', () => getGhStatus())
  ipcMain.handle('gh:loginStart', () => startGhLogin())
  ipcMain.handle('gh:loginCancel', () => cancelGhLogin())
  ipcMain.handle('gh:logout', () => logout())

  ipcMain.handle('github:prCreateContext', (_e, cwd: string, base: string) =>
    getPullRequestCreateContext(cwd, base))
  ipcMain.handle('github:prCatalogue', (_e, cwd: string) =>
    getPullRequestCatalogue(cwd))
  ipcMain.handle('github:prDetail', (_e, cwd: string, num: number) =>
    getPullRequestDetail(cwd, num))
  ipcMain.handle('github:prDiff', (_e, cwd: string, num: number) =>
    getPullRequestDiff(cwd, num))
  ipcMain.handle('github:prReviewContext', (_e, cwd: string, num: number) =>
    getPullRequestReviewContext(cwd, num))
  ipcMain.handle('github:prManagementContext', (_e, cwd: string, num: number) =>
    getPullRequestManagementContext(cwd, num))
  ipcMain.handle('github:prChecksContext', (_e, cwd: string, num: number) =>
    getPullRequestChecksContext(cwd, num))
  ipcMain.handle('github:prCheckLog', (_e, cwd: string, num: number, headCommitId: string, runId: number, jobId: number) =>
    getPullRequestCheckLog(cwd, num, headCommitId, runId, jobId))
  ipcMain.handle('github:avatar', (_e, cwd: string, login: string) =>
    getGitHubAvatar(cwd, login))
  ipcMain.handle('gh:prPrepareConflictResolution', (_e, cwd: string, head: string, base: string) =>
    preparePullRequestConflictResolution(cwd, head, base))

  // Pull-request operations for the Git Sidebar.
  ipcMain.handle('gh:prCreate',  (_e, cwd: string, options: GitHubPullRequestCreateOptions) => {
    try { return runGh(cwd, pullRequestCreateArgs(options)) }
    catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('gh:prMerge',   (_e, cwd: string, num: number, method: GitHubMergeMethod, headCommitId?: string) => {
    try { return runGh(cwd, pullRequestMergeArgs(num, method, headCommitId)) }
    catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('gh:prApprove', (_e, cwd: string, num: number) => {
    try { return runGh(cwd, pullRequestActionArgs('approve', num)) }
    catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('gh:prUpdateBranch', (_e, cwd: string, num: number) => {
    try { return runGh(cwd, pullRequestActionArgs('update-branch', num)) }
    catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('gh:prReady', (_e, cwd: string, num: number) => {
    try { return runGh(cwd, pullRequestActionArgs('ready', num)) }
    catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('gh:prDraft', (_e, cwd: string, num: number) => {
    try { return runGh(cwd, pullRequestActionArgs('draft', num)) }
    catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('gh:prReopen', (_e, cwd: string, num: number) => {
    try { return runGh(cwd, pullRequestActionArgs('reopen', num)) }
    catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('gh:prEdit', (_e, cwd: string, num: number, options: GitHubPullRequestEditOptions) => {
    try { return runGh(cwd, pullRequestEditArgs(num, options)) }
    catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('gh:prMetadata', (_e, cwd: string, num: number, options: GitHubPullRequestMetadataOptions) => {
    try { return runGh(cwd, pullRequestMetadataArgs(num, options)) }
    catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('gh:prCheckRerun', (_e, cwd: string, num: number, options: GitHubPullRequestCheckRerunOptions) =>
    rerunPullRequestCheck(cwd, num, options))
  ipcMain.handle('gh:prMergeAutomation', (_e, cwd: string, num: number, options: GitHubPullRequestMergeAutomationOptions) =>
    updatePullRequestMergeAutomation(cwd, num, options))
  ipcMain.handle('gh:prComment', (_e, cwd: string, num: number, body: string) => {
    try { return runGh(cwd, pullRequestCommentArgs(num, body)) }
    catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('gh:prClose', (_e, cwd: string, num: number) => {
    try { return runGh(cwd, pullRequestActionArgs('close', num)) }
    catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('gh:prReview', (_e, cwd: string, num: number, options: GitHubPullRequestReviewOptions) => {
    if (options.comments?.length) return submitPullRequestReview(cwd, num, options)
    try { return runGh(cwd, pullRequestReviewArgs(num, options)) }
    catch (error) { return { ok: false, output: '', error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('gh:prViewedFile', (_e, cwd: string, num: number, options: GitHubPullRequestViewedFileOptions) =>
    updatePullRequestViewedFile(cwd, num, options))
  ipcMain.handle('gh:prReviewThread', (_e, cwd: string, num: number, threadId: string, resolved: boolean) =>
    updatePullRequestReviewThread(cwd, num, threadId, resolved))

  // Publish a local folder to GitHub (init + first commit + repo create + push).
  ipcMain.handle('gh:repoCreate', (_e, cwd: string, opts: RepoCreateOpts) =>
    createGhRepository(cwd, opts))
}

export function subscribeGhAuth(listener: (event: GhAuthEvent) => void): () => void {
  authListeners.add(listener)
  return () => authListeners.delete(listener)
}

export function killActiveGhLogin(): void {
  if (activeLogin) {
    try { activeLogin.kill('SIGKILL') } catch { /* already gone */ }
    activeLogin = null
  }
}

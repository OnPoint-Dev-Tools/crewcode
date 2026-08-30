import { execFile } from 'child_process'
import { parseLog, parseStatus } from './git-porcelain-parse'
import { unstagePaths } from './git-unstage'
import { discardPath } from './git-discard'

interface GitResult { stdout: string; stderr: string }

function validRef(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !value.startsWith('-') && !/[\x00-\x20~^:?*[\\]/.test(value) && !value.includes('..') && !value.includes('@{')
}

/** Headless git operations. Callers must enforce registered-workspace ownership. */
export class GitService {
  private run(cwd: string, args: string[]): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      execFile('git', args, {
        cwd, maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout: stdout ?? '', stderr: stderr ?? '' }))
        else resolve({ stdout: stdout ?? '', stderr: stderr ?? '' })
      })
    })
  }

  private message(error: unknown): string {
    const value = error as Error & { stderr?: string }
    return value.stderr?.trim() || value.message
  }

  async status(cwd: string) { try { return { ok: true, ...parseStatus((await this.run(cwd, ['status', '--porcelain=v1', '-b'])).stdout) } } catch (error) { return { error: this.message(error) } } }
  async stage(cwd: string, paths: string[]) { try { await this.run(cwd, ['add', '--', ...paths.map(String)]); return { ok: true } } catch (error) { return { error: this.message(error) } } }
  async stageAll(cwd: string) { try { await this.run(cwd, ['add', '--all']); return { ok: true } } catch (error) { return { error: this.message(error) } } }
  async unstage(cwd: string, paths: string[]) { try { await unstagePaths(paths.map(String), args => this.run(cwd, args)); return { ok: true } } catch (error) { return { error: this.message(error) } } }
  async discard(cwd: string, path: string) { try { await discardPath(String(path), args => this.run(cwd, args)); return { ok: true } } catch (error) { return { error: this.message(error) } } }

  async diff(cwd: string, path: string, staged: boolean) {
    try {
      const prefix = ['--src-prefix=a/', '--dst-prefix=b/']
      const args = staged ? ['diff', ...prefix, '--cached', '--', path] : ['diff', ...prefix, '--', path]
      const result = await this.run(cwd, args)
      if (result.stdout.trim()) return { ok: true, diff: result.stdout }
      try { return { ok: true, diff: (await this.run(cwd, ['diff', ...prefix, '--no-index', '--', '/dev/null', path])).stdout } }
      catch (error) { return { ok: true, diff: (error as { stdout?: string }).stdout ?? '' } }
    } catch (error) { return { error: this.message(error) } }
  }

  async changesVsRef(cwd: string, ref: string) {
    if (!validRef(ref)) return { error: 'invalid comparison branch' }
    try {
      const stdout = (await this.run(cwd, ['diff', '--name-status', ref])).stdout
      const files: Array<{ path: string; status: string; staged: boolean }> = []
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const parts = line.split('\t')
        const code = (parts[0] ?? '').trim()
        const path = parts.length >= 3 ? parts[parts.length - 1] : (parts[1] ?? '')
        if (path) files.push({ path, status: code[0] ?? 'M', staged: false })
      }
      const status = parseStatus((await this.run(cwd, ['status', '--porcelain=v1', '-b'])).stdout)
      for (const file of status.untracked) {
        if (!files.some(candidate => candidate.path === file.path)) files.push(file)
      }
      return { ok: true, files }
    } catch (error) { return { error: this.message(error) } }
  }

  async diffVsRef(cwd: string, ref: string, path: string) {
    if (!validRef(ref)) return { error: 'invalid comparison branch' }
    try {
      const prefix = ['--src-prefix=a/', '--dst-prefix=b/']
      const stdout = (await this.run(cwd, ['diff', ...prefix, ref, '--', path])).stdout
      if (stdout.trim()) return { ok: true, diff: stdout }
      try { return { ok: true, diff: (await this.run(cwd, ['diff', ...prefix, '--no-index', '--', '/dev/null', path])).stdout } }
      catch (error) { return { ok: true, diff: (error as { stdout?: string }).stdout ?? '' } }
    } catch (error) { return { error: this.message(error) } }
  }

  async log(cwd: string, rawLimit = 20) {
    const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)))
    try { return { ok: true, commits: parseLog((await this.run(cwd, ['log', '--format=%H\x1f%an\x1f%ar\x1f%s', `-${limit}`])).stdout) } }
    catch (error) { return { error: this.message(error) } }
  }

  async branches(cwd: string) {
    try {
      const stdout = (await this.run(cwd, ['branch', '--format=%(refname:short)\x1f%(HEAD)'])).stdout
      return { ok: true, branches: stdout.trim().split('\n').filter(Boolean).map(line => { const [name = '', head = ''] = line.split('\x1f'); return { name, current: head.trim() === '*' } }) }
    } catch (error) { return { error: this.message(error) } }
  }

  async remotes(cwd: string) {
    try {
      const names = (await this.run(cwd, ['remote'])).stdout.trim().split('\n').map(value => value.trim()).filter(Boolean)
      const remoteUrls = await Promise.all(names.map(async name => (await this.run(cwd, ['remote', 'get-url', name])).stdout.trim()))
      return { ok: true, isRepo: true, remotes: names, remoteUrls }
    } catch (error) {
      const message = this.message(error)
      return /not a git repository/i.test(message) ? { ok: true, isRepo: false, remotes: [] as string[], remoteUrls: [] as string[] } : { error: message }
    }
  }

  async commit(cwd: string, message: string, amend = false, noSign = false) {
    if (!message.trim() || message.length > 20_000) return { error: 'commit message is required' }
    try { const args = ['commit', '-m', message]; if (amend) args.push('--amend'); if (noSign) args.push('--no-gpg-sign'); return { ok: true, output: (await this.run(cwd, args)).stdout } }
    catch (error) { return { error: this.message(error) } }
  }

  async simple(cwd: string, operation: 'push' | 'pull' | 'fetch' | 'init') {
    const args = operation === 'fetch' ? ['fetch', '--prune'] : [operation]
    try { const result = await this.run(cwd, args); return { ok: true, output: result.stdout || result.stderr } }
    catch (error) { return { error: this.message(error) } }
  }

  async checkout(cwd: string, branch: string, create: boolean) {
    if (!validRef(branch)) return { error: 'invalid branch name' }
    try { await this.run(cwd, create ? ['checkout', '-b', branch] : ['checkout', branch]); return { ok: true } }
    catch (error) { return { error: this.message(error) } }
  }

  async merge(cwd: string, ref: string) {
    if (!validRef(ref)) return { error: 'invalid merge ref' }
    try { return { ok: true, output: (await this.run(cwd, ['merge', '--no-edit', ref])).stdout } }
    catch (error) { return { error: this.message(error) } }
  }

  async mergeAbort(cwd: string) { try { await this.run(cwd, ['merge', '--abort']); return { ok: true } } catch (error) { return { error: this.message(error) } } }
  async mergeContinue(cwd: string) { try { return { ok: true, output: (await this.run(cwd, ['commit', '--no-edit'])).stdout } } catch (error) { return { error: this.message(error) } } }
  async resolveConflict(cwd: string, file: string, strategy: string) {
    if (strategy !== 'ours' && strategy !== 'theirs') return { error: `unsupported strategy: ${strategy}` }
    try { await this.run(cwd, ['checkout', `--${strategy}`, '--', file]); await this.run(cwd, ['add', '--', file]); return { ok: true } }
    catch (error) { return { error: this.message(error) } }
  }
}

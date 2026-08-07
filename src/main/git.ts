import electron from 'electron'
import { execFile } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { isRemoteRoot, parseRemoteTarget } from './remote/ssh-target'
import { execRemote } from './remote/ssh-pool'
import { parseStatus, parseLog, isSigningFailure, isMergeConflictOutput, type GitStatusFile } from './git-porcelain-parse'
import { mergeDelegatedBranch } from './delegated-merge'
import { unstagePaths } from './git-unstage'

const { ipcMain } = electron

// Single-quote an argument for safe interpolation into the remote git command.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function runGit(cwd: string, args: string[], extraEnv?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  // Remote workspaces carry an ssh:// root — run git on the host via the pooled
  // connection. `git -C <path>` reproduces the local cwd behavior, so every
  // handler that funnels through runGit() works remotely unchanged. The reject
  // shape mirrors execFile's (Error augmented with stdout/stderr) so callers'
  // error handling is identical.
  if (isRemoteRoot(cwd)) {
    const t = parseRemoteTarget(cwd)
    if (!t) return Promise.reject(Object.assign(new Error('invalid remote root'), { stdout: '', stderr: 'invalid remote root' }))
    const cmd = ['git', '-C', t.path, ...args].map(shq).join(' ')
    return execRemote(t, cmd).then(r => {
      if (r.code === 0) return { stdout: r.stdout, stderr: r.stderr }
      throw Object.assign(new Error(r.stderr.trim() || `git exited ${r.code}`), { stdout: r.stdout, stderr: r.stderr })
    })
  }
  return new Promise((resolve, reject) => {
    // GIT_TERMINAL_PROMPT=0 makes git fail fast instead of blocking forever on an
    // askpass/credential prompt it can never satisfy in this GUI-spawned process.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv }
    execFile('git', args, { cwd, env, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout: stdout ?? '', stderr: stderr ?? '' }))
      else resolve({ stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

function gitAskpassEnv(username: string, password: string): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(os.tmpdir(), 'crewcode-git-ask-'))
  const isWin = process.platform === 'win32'
  const askPath = join(dir, isWin ? 'askpass.cmd' : 'askpass.sh')
  const script = isWin
    ? '@echo off\r\necho %* | findstr /I "Username" >nul\r\nif %errorlevel%==0 (echo %CREWCODE_GIT_USERNAME%) else (echo %CREWCODE_GIT_PASSWORD%)\r\n'
    : '#!/bin/sh\ncase "$1" in\n  *sername*) printf "%s\\n" "$CREWCODE_GIT_USERNAME" ;;\n  *) printf "%s\\n" "$CREWCODE_GIT_PASSWORD" ;;\nesac\n'
  writeFileSync(askPath, script, { mode: 0o700 })
  const env: NodeJS.ProcessEnv = isWin
    ? {
        GIT_ASKPASS: askPath,
        SSH_ASKPASS: askPath,
        GIT_TERMINAL_PROMPT: '1',
        CREWCODE_GIT_USERNAME: username,
        CREWCODE_GIT_PASSWORD: password,
        DISPLAY: process.env.DISPLAY || ':0',
      }
    : {
        GIT_ASKPASS: askPath,
        SSH_ASKPASS: askPath,
        GIT_TERMINAL_PROMPT: '1',
        SSH_ASKPASS_REQUIRE: 'force',
        CREWCODE_GIT_USERNAME: username,
        CREWCODE_GIT_PASSWORD: password,
        DISPLAY: process.env.DISPLAY || ':0',
      }
  return {
    env,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } },
  }
}

// Signing a commit takes a key passphrase that git can't prompt for in a
// GUI-spawned process. Unlike push (which uses GIT_ASKPASS for both HTTPS and
// SSH), signing splits by format: OpenPGP keys are unlocked by gpg's own
// pinentry, SSH keys by ssh-keygen via SSH_ASKPASS. This builds the right
// injection for the repo's configured gpg.format.
async function gitSigningEnv(cwd: string, passphrase: string): Promise<{ configArgs: string[]; env: NodeJS.ProcessEnv; cleanup: () => void }> {
  const dir = mkdtempSync(join(os.tmpdir(), 'crewcode-git-sign-'))
  const isWin = process.platform === 'win32'
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }

  const readConfig = async (key: string): Promise<string> => {
    try { return (await runGit(cwd, ['config', '--get', key])).stdout.trim() }
    catch { return '' }
  }

  const format = (await readConfig('gpg.format')) || 'openpgp'

  if (format === 'ssh') {
    // ssh-keygen -Y sign reads the key passphrase from SSH_ASKPASS when there's
    // no controlling terminal (our case). Same mechanism as push over SSH.
    const askPath = join(dir, isWin ? 'sign-askpass.cmd' : 'sign-askpass.sh')
    const script = isWin
      ? '@echo off\r\necho %CREWCODE_SIGN_PASSPHRASE%\r\n'
      : '#!/bin/sh\nprintf "%s\\n" "$CREWCODE_SIGN_PASSPHRASE"\n'
    writeFileSync(askPath, script, { mode: 0o700 })
    return {
      configArgs: [],
      env: {
        SSH_ASKPASS: askPath,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: process.env.DISPLAY || ':0',
        GIT_TERMINAL_PROMPT: '0',
        CREWCODE_SIGN_PASSPHRASE: passphrase,
      },
      cleanup,
    }
  }

  // OpenPGP: point gpg.program at a wrapper that forces loopback pinentry and
  // feeds the passphrase from a 0600 temp file (never on the argv, never in ps).
  // Requires `allow-loopback-pinentry` in gpg-agent.conf; if it's off, gpg errors
  // and that message surfaces back to the modal.
  const gpgProgram = (await readConfig('gpg.program')) || 'gpg'
  const passFile = join(dir, 'pass')
  writeFileSync(passFile, passphrase, { mode: 0o600 })
  const wrapPath = join(dir, isWin ? 'gpg-wrap.cmd' : 'gpg-wrap.sh')
  const wrapScript = isWin
    ? `@echo off\r\n"${gpgProgram}" --pinentry-mode loopback --passphrase-file "${passFile}" %*\r\n`
    : `#!/bin/sh\nexec "${gpgProgram}" --pinentry-mode loopback --passphrase-file "${passFile}" "$@"\n`
  writeFileSync(wrapPath, wrapScript, { mode: 0o700 })
  return {
    configArgs: ['-c', `gpg.program=${wrapPath}`],
    env: { GIT_TERMINAL_PROMPT: '0' },
    cleanup,
  }
}

export function registerGitIpc(): void {
  ipcMain.handle('git:status', async (_e, cwd: string) => {
    try {
      const { stdout } = await runGit(cwd, ['status', '--porcelain=v1', '-b'])
      return { ok: true, ...parseStatus(stdout) }
    } catch (err: unknown) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('git:stage', async (_e, cwd: string, paths: string[]) => {
    try {
      await runGit(cwd, ['add', '--', ...paths])
      return { ok: true }
    } catch (err: unknown) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('git:stageAll', async (_e, cwd: string) => {
    try {
      // Let Git discover the current working-tree state atomically. Replaying a
      // renderer snapshot can fail when files are moved/deleted before this runs.
      await runGit(cwd, ['add', '--all'])
      return { ok: true }
    } catch (err: unknown) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('git:unstage', async (_e, cwd: string, paths: string[]) => {
    try {
      await unstagePaths(paths, args => runGit(cwd, args))
      return { ok: true }
    } catch (err: unknown) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('git:diff', async (_e, cwd: string, path: string, staged: boolean) => {
    try {
      // Force standard a/ b/ prefixes — the user's diff.mnemonicPrefix/noprefix
      // config would otherwise emit i/ w/ (or none), which the Pierre diff parser
      // can't read and chokes on, falling back to raw for every file.
      const prefix = ['--src-prefix=a/', '--dst-prefix=b/']
      const args = staged
        ? ['diff', ...prefix, '--cached', '--', path]
        : ['diff', ...prefix, '--', path]
      const { stdout } = await runGit(cwd, args)
      if (stdout && stdout.trim()) return { ok: true, diff: stdout }
      // Untracked files have no tracked counterpart, so `git diff` is empty.
      // Fall back to `diff --no-index /dev/null <path>` which produces a proper
      // "new file" patch the diff viewer can render.
      try {
        const { stdout: noIdx } = await runGit(cwd, ['diff', ...prefix, '--no-index', '--', '/dev/null', path])
        return { ok: true, diff: noIdx }
      } catch (e: unknown) {
        // `diff --no-index` exits 1 when files differ but still prints the patch.
        const stdout = (e as { stdout?: string }).stdout ?? ''
        return { ok: true, diff: stdout }
      }
    } catch (err: unknown) {
      return { error: (err as Error).message }
    }
  })

  // Files changed on this checkout relative to a base ref — committed work
  // included. `git diff --name-status <ref>` compares the ref to the working
  // tree (so committed + unstaged tracked changes both show), and untracked
  // files are folded in from status. This is what the crew compare view needs:
  // after a lane commits, its working tree is clean but it still differs from base.
  ipcMain.handle('git:changesVsRef', async (_e, cwd: string, ref: string) => {
    try {
      const { stdout } = await runGit(cwd, ['diff', '--name-status', ref])
      const files: GitStatusFile[] = []
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const parts = line.split('\t')
        const code  = (parts[0] ?? '').trim()
        // Rename/copy lines are "R100\told\tnew" — keep the destination path.
        const path  = parts.length >= 3 ? parts[parts.length - 1] : (parts[1] ?? '')
        if (!path) continue
        files.push({ path, status: code[0] ?? 'M', staged: false })
      }
      // Untracked files aren't part of `git diff <ref>` — pull them from status.
      const { stdout: st } = await runGit(cwd, ['status', '--porcelain=v1', '-b'])
      for (const f of parseStatus(st).untracked) {
        if (!files.some(x => x.path === f.path)) files.push(f)
      }
      return { ok: true, files }
    } catch (err: unknown) {
      return { error: (err as Error).message }
    }
  })

  // Unified diff of one file relative to a base ref — committed work included.
  ipcMain.handle('git:diffVsRef', async (_e, cwd: string, ref: string, path: string) => {
    try {
      const prefix = ['--src-prefix=a/', '--dst-prefix=b/']
      const { stdout } = await runGit(cwd, ['diff', ...prefix, ref, '--', path])
      if (stdout && stdout.trim()) return { ok: true, diff: stdout }
      // Untracked file (no counterpart in ref) — render it as a new-file patch.
      try {
        const { stdout: noIdx } = await runGit(cwd, ['diff', ...prefix, '--no-index', '--', '/dev/null', path])
        return { ok: true, diff: noIdx }
      } catch (e: unknown) {
        return { ok: true, diff: (e as { stdout?: string }).stdout ?? '' }
      }
    } catch (err: unknown) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('git:commit', async (_e, cwd: string, message: string, amend?: boolean, noSign?: boolean) => {
    try {
      const args = ['commit', '-m', message]
      if (amend)  args.push('--amend')
      // --no-gpg-sign overrides commit.gpgsign for this commit only; the user opts
      // into it from the sidebar after a signing failure.
      if (noSign) args.push('--no-gpg-sign')
      const { stdout } = await runGit(cwd, args)
      return { ok: true, output: stdout }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string }
      const msg = e.stderr?.trim() || e.message
      // Flag signing failures so the renderer can offer to retry without signing.
      return { error: msg, signingFailure: !noSign && isSigningFailure(msg) }
    }
  })

  // Retry a signed commit with a user-supplied key passphrase. Forces signing
  // (-S) and injects the passphrase per the repo's gpg.format. Used after a
  // git:commit signingFailure when the user opts to unlock their key.
  ipcMain.handle('git:commitWithPassphrase', async (_e, cwd: string, message: string, amend: boolean | undefined, passphrase: string) => {
    if (isRemoteRoot(cwd)) return { error: 'signing passphrase entry is only available for local workspaces right now' }
    if (!passphrase) return { error: 'a passphrase is required' }
    const signer = await gitSigningEnv(cwd, passphrase)
    try {
      const args = [...signer.configArgs, 'commit', '-S', '-m', message]
      if (amend) args.push('--amend')
      const { stdout } = await runGit(cwd, args, signer.env)
      return { ok: true, output: stdout }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string }
      const msg = e.stderr?.trim() || e.message
      return { error: msg, signingFailure: isSigningFailure(msg) }
    } finally {
      signer.cleanup()
    }
  })

  ipcMain.handle('git:push', async (_e, cwd: string) => {
    try {
      const { stdout, stderr } = await runGit(cwd, ['push'])
      return { ok: true, output: stdout || stderr }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string }
      return { error: e.stderr?.trim() || e.message }
    }
  })

  ipcMain.handle('git:pushWithCredentials', async (_e, cwd: string, username: string, password: string) => {
    if (isRemoteRoot(cwd)) return { error: 'credential prompt is only available for local workspaces right now' }
    if (!username.trim() || !password) return { error: 'username and password/token are required' }
    const ask = gitAskpassEnv(username.trim(), password)
    try {
      const { stdout, stderr } = await runGit(cwd, ['push'], ask.env)
      return { ok: true, output: stdout || stderr }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string }
      return { error: e.stderr?.trim() || e.message }
    } finally {
      ask.cleanup()
    }
  })

  ipcMain.handle('git:pull', async (_e, cwd: string) => {
    try {
      const { stdout } = await runGit(cwd, ['pull'])
      return { ok: true, output: stdout }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string }
      return { error: e.stderr?.trim() || e.message }
    }
  })

  ipcMain.handle('git:fetch', async (_e, cwd: string) => {
    try {
      await runGit(cwd, ['fetch', '--prune'])
      return { ok: true }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string }
      return { error: e.stderr?.trim() || e.message }
    }
  })

  ipcMain.handle('git:log', async (_e, cwd: string, limit: number = 20) => {
    try {
      const fmt = '%H\x1f%an\x1f%ar\x1f%s'
      const { stdout } = await runGit(cwd, ['log', `--format=${fmt}`, `-${limit}`])
      return { ok: true, commits: parseLog(stdout) }
    } catch (err: unknown) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('git:branches', async (_e, cwd: string) => {
    try {
      const { stdout } = await runGit(cwd, ['branch', '--format=%(refname:short)\x1f%(HEAD)'])
      const branches = stdout.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('\x1f')
        return { name: parts[0] ?? '', current: (parts[1] ?? '').trim() === '*' }
      })
      return { ok: true, branches }
    } catch (err: unknown) {
      return { error: (err as Error).message }
    }
  })

  ipcMain.handle('git:checkout', async (_e, cwd: string, branch: string) => {
    try {
      await runGit(cwd, ['checkout', branch])
      return { ok: true }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string }
      return { error: e.stderr?.trim() || e.message }
    }
  })

  ipcMain.handle('git:createBranch', async (_e, cwd: string, name: string) => {
    try {
      await runGit(cwd, ['checkout', '-b', name])
      return { ok: true }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string }
      return { error: e.stderr?.trim() || e.message }
    }
  })

  // Delegated-thread merge. The sequence lives in delegated-merge.ts so its
  // decision tree is testable without a repo; this only supplies the runner.
  ipcMain.handle('git:mergeDelegated', async (_e, request: {
    worktreePath: string; repoPath: string; branch: string; base: string
  }) => {
    const run = async (cwd: string, args: string[]) => {
      try {
        const { stdout, stderr } = await runGit(cwd, args)
        return { code: 0, stdout, stderr }
      } catch (err: unknown) {
        const e = err as Error & { stdout?: string; stderr?: string }
        return { code: 1, stdout: e.stdout ?? '', stderr: e.stderr ?? e.message }
      }
    }
    return mergeDelegatedBranch(request, run)
  })

  // Diff of a delegated branch against its base, for review before merging.
  ipcMain.handle('git:diffDelegated', async (_e, worktreePath: string, base: string, branch: string) => {
    try {
      const { stdout } = await runGit(worktreePath, ['diff', '--stat', `${base}...${branch}`])
      const { stdout: patch } = await runGit(worktreePath, ['diff', `${base}...${branch}`])
      return { ok: true, stat: stdout, patch }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string }
      return { error: e.stderr?.trim() || e.message }
    }
  })

  ipcMain.handle('git:merge', async (_e, cwd: string, ref: string) => {
    try {
      const { stdout } = await runGit(cwd, ['merge', '--no-edit', ref])
      return { ok: true, output: stdout }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string; stdout?: string }
      // A merge that hits conflicts exits non-zero but is still "in progress" —
      // that's a successful start, not a failure. The sidebar then drives resolution.
      const out = (e.stdout ?? '') + (e.stderr ?? '')
      if (isMergeConflictOutput(out)) return { ok: true, conflicts: true, output: out }
      return { error: e.stderr?.trim() || e.message }
    }
  })

  ipcMain.handle('git:mergeAbort', async (_e, cwd: string) => {
    try {
      await runGit(cwd, ['merge', '--abort'])
      return { ok: true }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string }
      return { error: e.stderr?.trim() || e.message }
    }
  })

  ipcMain.handle('git:mergeContinue', async (_e, cwd: string) => {
    try {
      // --no-edit so the merge commit doesn't block waiting on $EDITOR.
      const { stdout } = await runGit(cwd, ['commit', '--no-edit'])
      return { ok: true, output: stdout }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string }
      return { error: e.stderr?.trim() || e.message }
    }
  })

  ipcMain.handle('git:init', async (_e, cwd: string) => {
    try {
      await runGit(cwd, ['init'])
      return { ok: true }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string }
      return { error: e.stderr?.trim() || e.message }
    }
  })

  ipcMain.handle('git:remotes', async (_e, cwd: string) => {
    try {
      // `git remote -v` lists each remote twice; fetch names first, then resolve
      // URLs so UI actions can open the remote without requiring gh auth.
      const { stdout } = await runGit(cwd, ['remote'])
      const remotes = stdout.trim().split('\n').map(s => s.trim()).filter(Boolean)
      const remoteUrls = await Promise.all(remotes.map(async (name) => {
        const r = await runGit(cwd, ['remote', 'get-url', name])
        return r.stdout.trim()
      }))
      return { ok: true, isRepo: true, remotes, remoteUrls }
    } catch (err: unknown) {
      // Non-zero here usually means "not a git repository" — report it as such
      // rather than an error so the sidebar can offer to publish.
      const e = err as Error & { stderr?: string }
      if (/not a git repository/i.test(e.stderr ?? e.message)) {
        return { ok: true, isRepo: false, remotes: [] as string[] }
      }
      return { error: e.stderr?.trim() || e.message }
    }
  })

  ipcMain.handle('git:resolveConflict', async (_e, cwd: string, file: string, strategy: string) => {
    try {
      if (strategy === 'ours' || strategy === 'theirs') {
        await runGit(cwd, ['checkout', `--${strategy}`, '--', file])
        await runGit(cwd, ['add', '--', file])
        return { ok: true }
      }
      return { error: `unsupported strategy: ${strategy}` }
    } catch (err: unknown) {
      const e = err as Error & { stderr?: string }
      return { error: e.stderr?.trim() || e.message }
    }
  })
}

import { spawn } from 'child_process'
import type { ClientChannel } from 'ssh2'
import { isRemoteRoot, parseRemoteTarget } from '../remote/ssh-target'
import { execRemoteStream } from '../remote/ssh-pool'

// A spawned agent process, abstracted over local child_process and a remote
// ssh2 exec channel so the provider bridges (codex, pi) read/write JSON over
// stdio without caring where the binary actually runs. Only the subset the
// bridges use is modelled.
export interface AgentProc {
  pid: number | null
  stdin: {
    write(s: string): boolean
    end(): void
    readonly writable: boolean
    readonly destroyed: boolean
  }
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  on(event: 'close', cb: (code: number | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(): void
  killed: boolean
}

export interface SpawnAgentOpts {
  // Bare binary name for remote (resolved on the host via login-shell PATH) or
  // an absolute resolved path for local.
  command: string
  args:    string[]
  // Workspace root: a local path or an ssh:// URI. Remote routing keys off this.
  cwd:     string
  // Extra env beyond the inherited process.env (local) or the *only* env shipped
  // to the host (remote). Never send the full local environment over SSH.
  env?:    Record<string, string>
}

export interface SpawnAgentResult {
  proc:   AgentProc
  // Effective working directory for protocol `cwd` fields — the remote absolute
  // path when remote (never the ssh:// URI), otherwise the local cwd.
  dir:    string
  remote: boolean
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export async function spawnAgentProcess(opts: SpawnAgentOpts): Promise<SpawnAgentResult> {
  if (isRemoteRoot(opts.cwd)) {
    const target = parseRemoteTarget(opts.cwd)
    if (!target) throw new Error(`invalid remote workspace: ${opts.cwd}`)
    const dir = target.path

    // A non-interactive login shell sources ~/.profile but NOT ~/.bashrc, where
    // bun/npm/cargo installers usually put their global-bin PATH lines — so a
    // bare `codex`/`pi` fails with 127 even when installed. Prepend the same
    // well-known install dirs the local resolver searches so the agent is found
    // wherever the host put it. $HOME/$PATH stay unquoted so the host expands
    // them; the surrounding shq() single-quotes the whole inner script, which
    // passes the $-refs through untouched for `bash -lc` to evaluate.
    const pathPrefix = 'export PATH="$HOME/.bun/bin:$HOME/.cache/.bun/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:$PATH";'
    const exports = Object.entries(opts.env ?? {})
      .map(([k, v]) => `export ${k}=${shq(v)};`)
      .join(' ')
    const argv  = opts.args.map(shq).join(' ')
    const inner = `${pathPrefix} ${exports} cd ${shq(dir)} || exit 1; exec ${shq(opts.command)} ${argv}`.trim()
    const channel = await execRemoteStream(target, `bash -lc ${shq(inner)}`)
    return { proc: wrapChannel(channel), dir, remote: true }
  }

  const cp = spawn(opts.command, opts.args, {
    cwd:   opts.cwd,
    env:   { ...process.env, ...(opts.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  // child_process satisfies the AgentProc subset structurally; the cast keeps
  // the bridges on a single type regardless of transport.
  return { proc: cp as unknown as AgentProc, dir: opts.cwd, remote: false }
}

function wrapChannel(channel: ClientChannel): AgentProc {
  // ssh2 reports the remote exit status via 'exit' before the channel 'close'.
  let exitCode: number | null = null
  channel.on('exit', (code: number | null) => {
    exitCode = typeof code === 'number' ? code : null
  })
  return {
    pid: null,
    stdin: {
      write: (s: string) => channel.write(s),
      end:   () => { try { channel.end() } catch { /* already closing */ } },
      get writable()  { return channel.writable },
      get destroyed() { return channel.destroyed },
    },
    stdout: channel,
    stderr: channel.stderr,
    on(event: 'close' | 'error', cb: (arg: never) => void) {
      if (event === 'close') channel.on('close', () => (cb as unknown as (c: number | null) => void)(exitCode))
      else channel.on('error', cb as unknown as (e: Error) => void)
    },
    kill() {
      // Many sshd configs ignore channel signal requests, so also close the
      // channel — ending stdin makes a stdio app-server exit on its own.
      try { channel.signal('KILL') } catch { /* sshd may reject signals */ }
      try { channel.close() } catch { /* already closing */ }
    },
    killed: false,
  }
}

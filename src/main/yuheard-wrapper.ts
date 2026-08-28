/**
 * YuHeard auto-wrap shell shims + Codex notify hook.
 *
 * Every local PTY (plain shell or agent pane) gets a per-pane wrapper
 * directory prepended to PATH. Typing `codex` / `claude` / … runs a shim
 * that reports `running` over the YuHeard socket, then execs the real
 * binary. The shim talks to the socket through a baked-in Python (or
 * Node) helper — it does not depend on `yuheard` being on PATH.
 *
 * Fish and bash rewrite PATH in their rc files, which would otherwise
 * hide the shims. PtyService re-prepends the wrapper dir after rc
 * (fish `-C`, bash `PROMPT_COMMAND`).
 *
 * Codex TUI never goes idle, so the `codex` shim (and direct Codex
 * spawns) inject `-c notify=[python, hook.py]`. Codex then calls the
 * hook on `agent-turn-complete`. We never edit `~/.codex/config.toml`.
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from 'fs'
import os from 'os'
import path from 'path'

export interface YuHeardWrapperOptions {
  baseDir?: string
  socketPath?: string
}

export interface YuHeardHookRuntime {
  cmd: string
  kind: 'python' | 'node'
}

const SHIM_TEMPLATE = (
  realName: string,
  shimName: string,
  extraExec: string,
  runtimeCmd: string,
  hookFile: string,
) => `#!/bin/sh
# CrewCode YuHeard wrapper for "${shimName}" — do not edit.
self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OLD_IFS=$IFS
IFS=:
new_path=
for p in $PATH; do
  [ "$p" = "$self_dir" ] && continue
  if [ -z "$new_path" ]; then new_path=$p; else new_path=$new_path:$p; fi
done
IFS=$OLD_IFS
PATH=$new_path
export PATH
real="$(command -v ${shimName} 2>/dev/null || true)"
if [ -z "$real" ]; then
  printf 'yuheard: cannot find "%s" on PATH (wrapper for ${realName} cannot exec real binary)\\n' "${shimName}" >&2
  exit 127
fi
if [ -n "$YUHEARD_PANE_ID" ]; then
  "${runtimeCmd}" "$self_dir/${hookFile}" running >/dev/null 2>&1 || true
fi
exec "$real"${extraExec} "$@"
`

function defaultBaseDir(): string {
  return path.join(os.homedir(), '.crewcode', 'wrappers')
}

function defaultSocketPath(): string {
  return process.env.YUHEARD_SOCKET
    ?? path.join(os.homedir(), '.crewcode', 'yuheard.sock')
}

export function quoteSh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function tomlStr(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function findExecutable(name: string, pathEnv = process.env.PATH ?? ''): string | null {
  const direct = [`/usr/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`]
  for (const candidate of direct) {
    if (existsSync(candidate)) return candidate
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function resolveHookRuntime(): YuHeardHookRuntime {
  const python = findExecutable('python3')
  if (python) return { cmd: python, kind: 'python' }
  const node = findExecutable('node')
  if (node) return { cmd: node, kind: 'node' }
  return { cmd: 'python3', kind: 'python' }
}

export function tomlNotifyOverride(runtimeCmd: string, scriptPath: string): string {
  return `notify=[${tomlStr(runtimeCmd)}, ${tomlStr(scriptPath)}]`
}

export function codexNotifyArgv(runtimeCmd: string, scriptPath: string): string[] {
  // Default TUI notify is unfocused-only. CrewCode's xterm PTY reports focused,
  // so BEL/OSC never lands unless we force always + bel.
  return [
    '-c', tomlNotifyOverride(runtimeCmd, scriptPath),
    '-c', 'tui.notifications=true',
    '-c', 'tui.notification_method="bel"',
    '-c', 'tui.notification_condition="always"',
  ]
}

export function argvAsShExtra(argv: string[]): string {
  return argv.map(arg => ` ${quoteSh(arg)}`).join('')
}

export function fishKeepWrapCommand(wrapperDir: string, commands: readonly string[] = []): string {
  const pathBit = `set -gx PATH ${quoteSh(wrapperDir)} $PATH`
  if (commands.length === 0) return pathBit
  // config.fish functions shadow PATH. Redefine after rc so `codex` hits the shim.
  const fns = commands.map(name => (
    `function ${name}; ${quoteSh(wrapperDir)}/${name} $argv; end`
  )).join('; ')
  return `${pathBit}; ${fns}`
}

export function fishKeepWrapArgv(
  wrapperDir: string,
  argv: string[],
  commands: readonly string[] = [],
): string[] {
  return ['-C', fishKeepWrapCommand(wrapperDir, commands), ...argv]
}

export function bashKeepWrapPrompt(
  wrapperDir: string,
  existing?: string,
  commands: readonly string[] = [],
): string {
  const drop = commands.length > 0
    ? `unset -f ${commands.join(' ')} 2>/dev/null; unalias ${commands.join(' ')} 2>/dev/null; `
    : ''
  const keep = `${drop}PATH=${quoteSh(wrapperDir)}:\${PATH}`
  return existing ? `${keep}; ${existing}` : keep
}

function buildHookPython(paneId: string, socketPath: string): string {
  return `#!/usr/bin/env python3
# CrewCode YuHeard hook — do not edit.
import json, os, socket, sys, time
PANE_ID = ${JSON.stringify(paneId)}
SOCKET_PATH = ${JSON.stringify(socketPath)}

def send(state, source, message):
    payload = json.dumps({
        "pane_id": PANE_ID,
        "state": state,
        "source": source,
        "message": message,
        "ts": int(time.time() * 1000),
    }) + "\\n"
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(1.0)
    try:
        sock.connect(SOCKET_PATH)
        sock.sendall(payload.encode("utf-8"))
    except Exception:
        pass
    finally:
        try:
            sock.close()
        except Exception:
            pass

def main():
    args = sys.argv[1:]
    if args and args[0] in ("running", "complete"):
        message = " ".join(args[1:]).strip() or None
        send(args[0], "shim", message)
        return
    raw = args[-1] if args else ""
    if (not raw.startswith("{")) and (not sys.stdin.isatty()):
        try:
            raw = sys.stdin.read(8192)
        except Exception:
            pass
    type_name = ""
    message = None
    try:
        parsed = json.loads(raw) if raw.startswith("{") else {}
        if isinstance(parsed, dict):
            type_name = str(parsed.get("type") or "")
            last = parsed.get("last-assistant-message") or parsed.get("last_assistant_message")
            if isinstance(last, str) and last.strip():
                message = last.strip()[:140]
    except Exception:
        if "agent-turn-complete" in raw:
            type_name = "agent-turn-complete"
        elif "approval-requested" in raw:
            type_name = "approval-requested"
    lowered = type_name.lower()
    if lowered not in ("agent-turn-complete", "approval-requested"):
        return
    if lowered == "approval-requested":
        message = "needs approval"
    send("complete", "codex-notify", message)

if __name__ == "__main__":
    main()
`
}

export function hookScriptPath(paneId: string, opts: YuHeardWrapperOptions = {}): string {
  const base = opts.baseDir ?? defaultBaseDir()
  return path.join(base, paneId, 'yuheard-hook.py')
}

function buildHookJs(paneId: string, socketPath: string): string {
  return `#!/usr/bin/env node
const net = require('node:net')
const paneId = ${JSON.stringify(paneId)}
const socketPath = ${JSON.stringify(socketPath)}
const args = process.argv.slice(2)
function send(state, source, message) {
  const line = JSON.stringify({
    pane_id: paneId, state, source, message, ts: Date.now(),
  }) + '\\n'
  const sock = net.createConnection(socketPath)
  sock.on('error', () => process.exit(0))
  sock.on('connect', () => sock.end(line))
  setTimeout(() => process.exit(0), 1500)
}
if (args[0] === 'running' || args[0] === 'complete') {
  send(args[0], 'shim', args.slice(1).join(' ').trim() || null)
} else {
  let raw = args[args.length - 1] || ''
  if (!raw.startsWith('{') && process.stdin && typeof process.stdin.isTTY === 'boolean' && !process.stdin.isTTY) {
    try { raw = require('node:fs').readFileSync(0, 'utf8').slice(0, 8192) } catch {}
  }
  let type = ''
  let message = null
  try {
    const parsed = JSON.parse(raw)
    type = typeof parsed.type === 'string' ? parsed.type : ''
    const last = parsed['last-assistant-message'] ?? parsed.last_assistant_message
    if (typeof last === 'string' && last.trim()) message = last.trim().slice(0, 140)
  } catch {
    if (raw.includes('agent-turn-complete')) type = 'agent-turn-complete'
    else if (raw.includes('approval-requested')) type = 'approval-requested'
  }
  const lowered = type.toLowerCase()
  if (lowered !== 'agent-turn-complete' && lowered !== 'approval-requested') process.exit(0)
  if (lowered === 'approval-requested') message = 'needs approval'
  send('complete', 'codex-notify', message)
}
`
}

export function installYuHeardHook(
  paneId: string,
  opts: YuHeardWrapperOptions = {},
): { dir: string; hookPath: string; runtime: YuHeardHookRuntime } {
  const base = opts.baseDir ?? defaultBaseDir()
  const socket = opts.socketPath ?? defaultSocketPath()
  const dir = path.join(base, paneId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const runtime = resolveHookRuntime()
  const hookPath = path.join(dir, runtime.kind === 'node' ? 'yuheard-hook.js' : 'yuheard-hook.py')
  writeFileSync(
    hookPath,
    runtime.kind === 'node' ? buildHookJs(paneId, socket) : buildHookPython(paneId, socket),
    { mode: 0o700 },
  )
  return { dir, hookPath, runtime }
}

/** @deprecated use installYuHeardHook — kept so older call sites compile. */
export function installYuHeardCodexNotify(paneId: string, opts: YuHeardWrapperOptions = {}): string {
  return installYuHeardHook(paneId, opts).hookPath
}

export function installYuHeardWrapper(
  paneId: string,
  agentIds: string[],
  opts: YuHeardWrapperOptions = {},
): string {
  const base = opts.baseDir ?? defaultBaseDir()
  const dir = path.join(base, paneId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(dir)) {
    try { rmSync(path.join(dir, entry), { force: true }) } catch { /* ignore */ }
  }
  const { hookPath, runtime } = installYuHeardHook(paneId, opts)
  const extraExec = agentIds.includes('codex')
    ? argvAsShExtra(codexNotifyArgv(runtime.cmd, hookPath))
    : ''
  for (const id of agentIds) {
    const extra = id === 'codex' ? extraExec : ''
    writeFileSync(
      path.join(dir, id),
      SHIM_TEMPLATE(id, id, extra, runtime.cmd, path.basename(hookPath)),
      { mode: 0o700 },
    )
  }
  return dir
}

export function uninstallYuHeardWrapper(paneId: string, opts: YuHeardWrapperOptions = {}): void {
  const base = opts.baseDir ?? defaultBaseDir()
  const dir = path.join(base, paneId)
  if (!existsSync(dir)) return
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

export function pruneYuHeardWrappers(maxAgeMs = 24 * 60 * 60 * 1000, opts: YuHeardWrapperOptions = {}): number {
  const base = opts.baseDir ?? defaultBaseDir()
  if (!existsSync(base)) return 0
  const now = Date.now()
  let pruned = 0
  for (const entry of readdirSync(base)) {
    const full = path.join(base, entry)
    try {
      const st = statSync(full)
      if (!st.isDirectory()) continue
      if (now - st.mtimeMs > maxAgeMs) {
        rmSync(full, { recursive: true, force: true })
        pruned += 1
      }
    } catch { /* ignore */ }
  }
  return pruned
}

export function prependWrapperToPath(dir: string, currentPath: string | undefined): string {
  return currentPath ? `${dir}${path.delimiter}${currentPath}` : dir
}

export function executableBaseName(exe: string): string {
  return exe.replace(/\\/g, '/').split('/').pop() ?? exe
}

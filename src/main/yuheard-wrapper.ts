/**
 * YuHeard auto-wrap shell shims.
 *
 * For a plain shell pane (no agent), when `settings.yuheardAutoWrap` is on,
 * main process generates a per-pane wrapper directory at
 * `~/.crewcode/wrappers/<paneId>/` containing a shell shim per enabled
 * agent from `AGENT_DEFS`. The wrapper directory is prepended to the
 * shell's `PATH`, so typing `claude` runs the shim, which fires
 * `yuheard running` and execs the real `claude` from the un-prefixed PATH.
 *
 * The shim design:
 *  - exits 127 if the real binary is not on PATH (so the user gets a
 *    clear error instead of a silent no-op);
 *  - calls `yuheard running "$YUHEARD_PANE_ID"` with stderr/stdout
 *    redirected to /dev/null so socket latency never blocks startup;
 *  - uses `exec` to replace itself, preserving TTY, signals, exit codes,
 *    and stdin/stdout/stderr behavior.
 *
 * The directory is removed on pane close. If cleanup fails (process
 * crashed), the next server startup prunes stale dirs older than 24h.
 */

import { mkdirSync, writeFileSync, chmodSync, existsSync, readdirSync, rmSync, statSync } from 'fs'
import os from 'os'
import path from 'path'

/** Subset of AGENT_DEFS we need to know about. Mirrors the shape used in
 *  src/main/index.ts so we can import it without pulling in Electron. */
export interface YuHeardAgentDef {
  id: string
  cmd: string
}

export interface YuHeardWrapperOptions {
  /** Override the wrapper base directory. Defaults to
   *  ~/.crewcode/wrappers. */
  baseDir?: string
  /** Override the socket path baked into the shim. Defaults to env
   *  YUHEARD_SOCKET or ~/.crewcode/yuheard.sock. */
  socketPath?: string
  /** Override the socket binary used inside the shim. Defaults to
   *  `yuheard` (resolved via PATH at shim-install time, written as a
   *  literal command). */
  socketCommand?: string
}

const SHIM_TEMPLATE = (realName: string, shimName: string, socket: string) => `#!/bin/sh
# CrewCode YuHeard wrapper for "${shimName}" — do not edit.
# Generated automatically; removed when the owning pane closes.
# Sends a 'running' report to ${socket} then execs the real binary.
real="$(command -v ${shimName} 2>/dev/null || true)"
if [ -z "$real" ]; then
  printf 'yuheard: cannot find "%s" on PATH (wrapper for ${realName} cannot exec real binary)\\n' "${shimName}" >&2
  exit 127
fi
if [ -n "$YUHEARD_PANE_ID" ] && [ -n "${socket}" ]; then
  # Fire-and-forget; never block startup on socket latency.
  yuheard running "$YUHEARD_PANE_ID" "$@" >/dev/null 2>&1 || true
fi
exec "$real" "$@"
`

function defaultBaseDir(): string {
  return path.join(os.homedir(), '.crewcode', 'wrappers')
}

function defaultSocketPath(): string {
  return process.env.YUHEARD_SOCKET
    ?? path.join(os.homedir(), '.crewcode', 'yuheard.sock')
}

/** Install a wrapper directory for one pane. Returns the absolute path
 *  that should be prepended to PATH. */
export function installYuHeardWrapper(
  paneId: string,
  agentIds: string[],
  opts: YuHeardWrapperOptions = {},
): string {
  const base = opts.baseDir ?? defaultBaseDir()
  const socket = opts.socketPath ?? defaultSocketPath()
  const dir = path.join(base, paneId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Clear any stale shims from a previous install of this pane.
  for (const entry of readdirSync(dir)) {
    try { rmSync(path.join(dir, entry), { force: true }) } catch { /* ignore */ }
  }
  for (const id of agentIds) {
    const shimName = id
    const filePath = path.join(dir, shimName)
    const body = SHIM_TEMPLATE(id, shimName, socket)
    writeFileSync(filePath, body, { mode: 0o700 })
  }
  return dir
}

/** Remove the wrapper directory for one pane. Idempotent. */
export function uninstallYuHeardWrapper(paneId: string, opts: YuHeardWrapperOptions = {}): void {
  const base = opts.baseDir ?? defaultBaseDir()
  const dir = path.join(base, paneId)
  if (!existsSync(dir)) return
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

/** Prune any wrapper directories older than `maxAgeMs` (default 24h).
 *  Called at server startup so a crashed pane's directory doesn't leak. */
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

/** Return a PATH value with the wrapper dir prepended. */
export function prependWrapperToPath(dir: string, currentPath: string | undefined): string {
  return currentPath ? `${dir}:${currentPath}` : dir
}

/**
 * YuHeard — universal terminal agent-done alerts.
 *
 * A provider-neutral channel that lets any agent running inside a CrewCode
 * PtyPane signal "running" and "complete" so the app can play a knock sound
 * and fire a native OS notification. See docs/yuheard.md for the full
 * protocol and the rationale.
 *
 * This file is the single source of truth for the protocol types and the
 * canonical state-literal strings. Imported by main, preload, and renderer.
 */

export type YuHeardState = 'running' | 'complete'

/** Sentinel strings an out-of-band client (Claude hook, etc.) can match on.
 *  The JSON protocol uses 'running'|'complete' as the state values; the
 *  literal forms are documentation and grep anchors only. */
export const YUHEARD_RUNNING_LITERAL = 'YuHeard:Running'
export const YUHEARD_COMPLETE_LITERAL = 'YuHeard:Complete'

/** JSON-line payload sent by clients to the YuHeard socket server. */
export interface YuHeardReport {
  pane_id: string
  state: YuHeardState
  source?: string
  message?: string
  session_id?: string
  ts: number
}

/** Server -> client (one JSON line per inbound report). */
export interface YuHeardResponse {
  ok: boolean
  result?: 'applied' | 'duplicate' | 'unknown-pane'
  paneId?: string
  error?: string
}

/** Special control method for resolving a pane id by cwd (used by the CLI
 *  when YUHEARD_PANE_ID env is missing). */
export interface YuHeardPaneIdLookup {
  method: 'pane-id-lookup'
  cwd: string
}

export type YuHeardRequest = YuHeardReport | YuHeardPaneIdLookup

/** Renderer-side IPC payload (server -> BrowserWindow.webContents). */
export interface YuHeardRendererEvent {
  paneId: string
  state: YuHeardState
  message: string | null
  source: string
  at: number
}

/** Default socket path used when YUHEARD_SOCKET env is unset. */
export function defaultYuHeardSocketPath(homedir: string): string {
  // Keep in sync with the renderer/docs: ~/.crewcode/yuheard.sock
  return pathJoin(homedir, '.crewcode', 'yuheard.sock')
}

// Tiny inline path join to avoid pulling node:path into the shared module
// (preload runs in a context where it can import node modules, but keeping
// this file dependency-free is safer for tree-shaking and test imports).
function pathJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/')
}

/** State values, frozen, for runtime validation. */
export const YUHEARD_STATES: readonly YuHeardState[] = ['running', 'complete']

export function isYuHeardState(value: unknown): value is YuHeardState {
  return value === 'running' || value === 'complete'
}

/** Agent binaries the auto-wrap shim should intercept. Ids and common
 *  command names, independent of which providers are enabled as chat
 *  connections — typing `codex` in a shell must wrap even when Codex
 *  is not the default chat agent. */
/** Solo/Crew chat tabs have their own notification path. YuHeard is only
 *  for terminal tabs (and canvas terminal panes whose tab kind is unknown). */
export function tabKindAllowsYuHeard(kind: string | undefined): boolean {
  return kind !== 'chat' && kind !== 'crew'
}

export const YUHEARD_WRAP_COMMANDS = [
  'claude',
  'codex',
  'opencode',
  'opencode-cli',
  'grok',
  'hermes',
  'pi',
  'crewcoder',
  'ollama',
] as const

/** Flags the renderer sends on `ptyCreate` so main can wrap/idle-detect. */
export function yuheardPtySpawnFlags(opts: {
  tabKind?: string
  shell?: string
  agentId?: string | null
  autoWrapEnabled: boolean
}): {
  yuheard: boolean
  autoWrap: boolean
  wrapAgentIds: string[]
  agentId: string | null
} {
  const yuheard = tabKindAllowsYuHeard(opts.tabKind)
  const wrapAgentIds = opts.autoWrapEnabled && yuheard ? [...YUHEARD_WRAP_COMMANDS] : []
  return {
    yuheard,
    autoWrap: opts.autoWrapEnabled && yuheard && opts.shell !== 'ssh',
    wrapAgentIds,
    agentId: opts.agentId ?? null,
  }
}

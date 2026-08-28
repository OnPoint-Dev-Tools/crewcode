/**
 * Detect a finished terminal-agent turn from PTY output.
 *
 * Socket hooks remain the preferred signal. This is the fallback for agents
 * that never call `yuheard complete` mid-session (interactive CLIs that stay
 * running after a reply):
 *
 * - BEL / OSC 9 / OSC 777 → complete immediately
 * - A burst of output followed by idle → complete
 *
 * Plain shells with no YuHeard `running` session are never fed into this
 * detector, so `ls` in a regular terminal does not knock.
 */

export const YUHEARD_TURN_IDLE_MS = 2800
export const YUHEARD_TURN_MIN_BYTES = 160

export type YuHeardTurnSource = 'pty-bell' | 'pty-idle'

export function outputLooksLikeBell(data: string): boolean {
  return data.includes('\x07') || data.includes('\x1b]9;') || data.includes('\x1b]777;')
}

/** Return the known agent CLI that begins a submitted PTY line. Used so a
 *  plain shell can retain the active agent identity even when Fish/aliases
 *  skip the PATH shim. */
export function submittedAgentCommand(line: string, commands: readonly string[]): string | null {
  if (!line || commands.length === 0) return null
  const cleaned = line
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .trim()
  if (!cleaned) return null
  const tokens = cleaned.split(/\s+/).filter(t => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
  let i = 0
  while (
    i < tokens.length
    && (tokens[i] === 'command' || tokens[i] === 'exec' || tokens[i] === 'sudo' || tokens[i] === 'noglob')
  ) {
    i += 1
  }
  const cmd = tokens[i]
  if (!cmd) return null
  const base = cmd.replace(/\\/g, '/').split('/').pop() ?? cmd
  return commands.includes(base) ? base : null
}

export function submittedLineLooksLikeAgent(line: string, commands: readonly string[]): boolean {
  return submittedAgentCommand(line, commands) !== null
}

export function applyPtyKeystroke(buffer: string, data: string): { buffer: string; submitted: string[] } {
  let buf = buffer
  const submitted: string[] = []
  for (const ch of data) {
    if (ch === '\r' || ch === '\n') {
      if (buf) submitted.push(buf)
      buf = ''
    } else if (ch === '\x7f' || ch === '\b') {
      buf = buf.slice(0, -1)
    } else if (ch === '\x15') {
      buf = ''
    } else if (ch >= ' ' || ch === '\t') {
      buf += ch
    }
  }
  return { buffer: buf, submitted }
}

/** Visible payload after stripping CSI/OSC. TUI status-bar redraws are
 *  mostly escapes; counting them as activity makes Codex never look idle. */
export function substantialBytes(data: string): number {
  const stripped = data
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  const visible = stripped.replace(/\s+/g, ' ').trim()
  return byteLength(visible)
}

export class YuHeardTurnDetector {
  private readonly bytes = new Map<string, number>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly armed = new Set<string>()

  constructor(
    private readonly complete: (paneId: string, source: YuHeardTurnSource) => void,
    private readonly idleMs = YUHEARD_TURN_IDLE_MS,
    private readonly minBytes = YUHEARD_TURN_MIN_BYTES,
  ) {}

  onData(paneId: string, data: string): void {
    if (!data || !this.armed.has(paneId)) return
    if (outputLooksLikeBell(data)) {
      this.fire(paneId, 'pty-bell')
      return
    }
    const added = substantialBytes(data)
    if (added < 4) return
    this.bytes.set(paneId, (this.bytes.get(paneId) ?? 0) + added)
    this.armIdle(paneId)
  }

  /** A user submitted a line (Enter). Next substantial burst is a reply. */
  onSubmit(paneId: string): void {
    this.armed.add(paneId)
    this.bytes.set(paneId, 0)
    this.clearTimer(paneId)
  }

  /** Starting an interactive agent is not itself a turn. Its initial TUI
   *  paint (and any startup BEL) must be ignored until the user submits the
   *  first prompt inside the agent. */
  onAgentLaunch(paneId: string): void {
    this.armed.delete(paneId)
    this.bytes.set(paneId, 0)
    this.clearTimer(paneId)
  }

  clear(paneId: string): void {
    this.clearTimer(paneId)
    this.bytes.delete(paneId)
    this.armed.delete(paneId)
  }

  dispose(): void {
    for (const paneId of [...this.timers.keys()]) this.clear(paneId)
  }

  private armIdle(paneId: string): void {
    this.clearTimer(paneId)
    const timer = setTimeout(() => {
      this.timers.delete(paneId)
      if ((this.bytes.get(paneId) ?? 0) < this.minBytes) return
      this.fire(paneId, 'pty-idle')
    }, this.idleMs)
    this.timers.set(paneId, timer)
  }

  private fire(paneId: string, source: YuHeardTurnSource): void {
    this.clearTimer(paneId)
    this.bytes.set(paneId, 0)
    this.armed.delete(paneId)
    this.complete(paneId, source)
  }

  private clearTimer(paneId: string): void {
    const timer = this.timers.get(paneId)
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(paneId)
  }
}

function byteLength(data: string): number {
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(data)
  return data.length
}

// Full Access "tripwire": a hard denylist of catastrophic shell commands that
// must pause for human confirmation even when the agent is running in Full Access
// (approval-free) mode. This is the safety net for residual risk #5 — it keeps
// Full Access fast for the 99% of benign commands while forcing a conscious
// decision on the irreversible/system-level/RCE-exfil few.
//
// Pure and Electron-free so it can be unit-tested and reused by every bridge.
// The policy lives here in ONE place; bridges only decide how to surface it.

export interface DangerVerdict {
  /** True when the command trips the denylist and must be confirmed/blocked. */
  dangerous: boolean
  /** Stable rule id, e.g. 'recursive-force-delete'. */
  rule?: string
  /** Human-readable reason to show in the confirmation prompt. */
  reason?: string
}

const SAFE: DangerVerdict = { dangerous: false }

// Each rule: a test against the normalized command and the reason to surface.
// Ordered from most to least catastrophic; the first match wins. Patterns are
// intentionally conservative — they aim to catch the well-known destructive
// shapes without flagging everyday commands (see dangerous-command.test.ts).
interface Rule {
  id: string
  reason: string
  test: (cmd: string) => boolean
}

const RULES: Rule[] = [
  {
    id: 'fork-bomb',
    reason: 'Shell fork bomb — will exhaust system process table.',
    // :(){ :|:& };:  and common whitespace variants
    test: (c) => /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(c),
  },
  {
    id: 'disk-overwrite',
    reason: 'Writes directly to a raw disk/partition device — irreversible data loss.',
    test: (c) =>
      /\bmkfs(\.\w+)?\b/.test(c) ||
      /\bwipefs\b/.test(c) ||
      /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|vd|hd|disk|mmcblk)/.test(c) ||
      />\s*\/dev\/(sd|nvme|vd|hd|disk|mmcblk)/.test(c),
  },
  {
    id: 'recursive-force-delete',
    reason: 'Recursive force delete (rm -rf) — permanently removes files with no undo.',
    // rm with both recursive and force flags, in any order / long form.
    test: (c) => {
      if (!/\brm\b/.test(c)) return false
      const hasR = /\brm\b[^\n|;&]*\s-[a-z]*r[a-z]*\b/i.test(c) || /--recursive\b/.test(c)
      const hasF = /\brm\b[^\n|;&]*\s-[a-z]*f[a-z]*\b/i.test(c) || /--force\b/.test(c)
      return hasR && hasF
    },
  },
  {
    id: 'pipe-to-shell',
    reason: 'Downloads and executes remote code (curl/wget piped into a shell) — arbitrary RCE.',
    test: (c) =>
      /\b(curl|wget|fetch)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|python[0-9.]*|node|perl|ruby)\b/.test(c),
  },
  {
    id: 'privilege-escalation',
    reason: 'Runs a command as root via sudo/doas/su — escalates beyond the workspace user.',
    test: (c) => /(^|[\n;|&]|\s)(sudo|doas)\s+\S/.test(c) || /(^|[\n;|&]|\s)su\s+-\b/.test(c),
  },
  {
    id: 'git-history-destroy',
    reason: 'Force-pushes or force-deletes remote git history — can overwrite others’ work irrecoverably.',
    test: (c) =>
      /\bgit\b[^\n]*\bpush\b[^\n]*(--force(?!-with-lease)|\s-f\b|\s\+)/.test(c) ||
      /\bgit\b[^\n]*\bpush\b[^\n]*--delete\b/.test(c),
  },
  {
    id: 'git-hard-discard',
    reason: 'Discards local work irreversibly (git reset --hard / clean -fd).',
    test: (c) =>
      /\bgit\b[^\n]*\breset\b[^\n]*--hard\b/.test(c) ||
      /\bgit\b[^\n]*\bclean\b[^\n]*-[a-z]*f[a-z]*d|\bclean\b[^\n]*-[a-z]*d[a-z]*f/.test(c),
  },
  {
    id: 'permission-wipe',
    reason: 'Recursively opens permissions on a root/home path (chmod/chown -R) — breaks system security.',
    test: (c) =>
      /\bchmod\b[^\n]*\s-[a-z]*R[a-z]*\s[^\n]*\s(777|a\+rwx)\b/.test(c) ||
      /\bchmod\b[^\n]*\s(777|a\+rwx)\s+\/($|\s)/.test(c) ||
      /\bchown\b[^\n]*\s-[a-z]*R[a-z]*\s[^\n]*\s\/($|\s|etc|usr|bin|var)\b/.test(c),
  },
  {
    id: 'system-path-clobber',
    reason: 'Redirects output over a system path (/etc, /boot, /usr, /bin) — can brick the OS.',
    test: (c) => />\s*\/(etc|boot|usr\/bin|bin|sbin|lib|System)\b/.test(c),
  },
  {
    id: 'secure-erase',
    reason: 'Irrecoverable data destruction (shred / crontab -r).',
    test: (c) => /\bshred\b/.test(c) || /\bcrontab\b[^\n]*\s-r\b/.test(c),
  },
  {
    id: 'infra-destroy',
    reason: 'Destroys managed infrastructure/resources (terraform destroy, kubectl delete, docker prune -f).',
    test: (c) =>
      /\bterraform\b[^\n]*\bdestroy\b/.test(c) ||
      /\bkubectl\b[^\n]*\bdelete\b[^\n]*(--all|-A|--all-namespaces)\b/.test(c) ||
      /\bdocker\b[^\n]*\b(system|volume)\s+prune\b[^\n]*-[a-z]*f/.test(c),
  },
]

/**
 * Classify a raw shell command string against the denylist. Whitespace is
 * collapsed so flag spacing does not evade a rule. First matching rule wins.
 */
export function classifyCommand(rawCommand: string): DangerVerdict {
  if (typeof rawCommand !== 'string') return SAFE
  const cmd = rawCommand.replace(/\s+/g, ' ').trim()
  if (!cmd) return SAFE
  for (const rule of RULES) {
    if (rule.test(cmd)) return { dangerous: true, rule: rule.id, reason: rule.reason }
  }
  return SAFE
}

// Tool names (lowercased) that carry an executable shell command. Different
// agents name their shell tool differently; the payload key also varies.
const SHELL_TOOL_NAMES = new Set(['bash', 'shell', 'exec', 'execute', 'run', 'run_command', 'local_shell', 'shell_command'])
const COMMAND_KEYS = ['command', 'cmd', 'script', 'input', 'commandLine', 'command_line']

/** Pull a shell command string out of a tool-call input payload, if present. */
export function extractShellCommand(toolName: string | undefined, input: unknown): string | null {
  const name = (toolName ?? '').toLowerCase()
  const looksShell = SHELL_TOOL_NAMES.has(name) || name.includes('bash') || name.includes('shell') || name.includes('exec')
  if (!looksShell) return null
  if (typeof input === 'string') return input
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  for (const key of COMMAND_KEYS) {
    const v = obj[key]
    if (typeof v === 'string' && v.trim()) return v
    // Some agents pass argv arrays (e.g. ['bash','-lc','rm -rf x']).
    if (Array.isArray(v) && v.every(e => typeof e === 'string')) return (v as string[]).join(' ')
  }
  return null
}

/**
 * Combined helper for bridges: given a tool call, return the danger verdict.
 * Non-shell tools and empty commands are always safe.
 */
export function tripwireForToolCall(toolName: string | undefined, input: unknown): DangerVerdict {
  const command = extractShellCommand(toolName, input)
  if (!command) return SAFE
  return classifyCommand(command)
}

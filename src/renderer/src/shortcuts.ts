/**
 * Shared shortcut definitions. Settings reads this for the bindings list,
 * App reads it to wire the keydown handler. Storage format uses glyph
 * tokens (⌘, ⌃, ⌥, ⇧, ↵, ⇥, ⌫) regardless of platform — UI translates
 * them for display, the matcher translates them for comparison.
 */

export interface ShortcutItem { act: string; keys: string[] }
export interface ShortcutGroup { title: string; items: ShortcutItem[] }

// Action identifiers used by the App's keydown handler. Stable across UI
// label tweaks — the SHORTCUT_GROUPS table maps each id to a display label.
export type ActionId =
  | 'palette'
  | 'workspaces'
  | 'next-tab'
  | 'prev-tab'
  | 'next-workspace'
  | 'prev-workspace'
  | 'settings-search'
  | 'prompt-picker'
  | 'send-message'
  | 'cycle-mode'
  | 'insert-context'
  | 'switch-model'
  | 'start-voice'
  | 'end-voice'
  | 'new-terminal'
  | 'clear-pane'
  | 'toggle-terminal-column'
  | 'focus-next-session'
  | 'new-tab'
  | 'close-tab'
  | 'reopen-tab'
  | 'fullscreen'
  | 'split-terminal-right'
  | 'split-terminal-down'
  | 'prev-chat'
  | 'next-chat'
  | 'open-vscode'
  | 'open-folder'
  | 'clone-repo'
  | 'start-crew'
  | 'new-session'
  | 'duplicate-session'
  | 'toggle-theme'
  | 'cycle-theme'
  | 'toggle-density'

export interface ShortcutDef {
  id:    ActionId
  group: string
  act:   string       // human-readable label (shown in Settings)
  keys:  string[]     // default key chord using glyph tokens
}

// Shortcuts handled by component-local listeners (Composer, terminal panes)
// rather than the global App-level dispatcher. The global keydown handler
// skips these ids so the same keypress doesn't fire twice. `handleAction` in
// App.tsx still covers them — it dispatches a synthetic keydown matching the
// chord so the local listener picks the action up from anywhere.
export const LOCAL_SHORTCUTS: ReadonlySet<ActionId> = new Set<ActionId>([
  'send-message',
  'cycle-mode',
  'insert-context',
  'switch-model',
  'start-voice',
  'end-voice',
  'clear-pane',
  'focus-next-session',
])

export const SHORTCUTS: ShortcutDef[] = [
  // navigation
  { id: 'palette',          group: 'navigation', act: 'Open command palette',     keys: ['⌘','K'] },
  { id: 'workspaces',       group: 'navigation', act: 'Toggle workspaces drawer', keys: ['⌘','B'] },
  { id: 'next-tab',         group: 'navigation', act: 'Next tab',                 keys: ['⌘','⇧',']'] },
  { id: 'prev-tab',         group: 'navigation', act: 'Previous tab',             keys: ['⌘','⇧','['] },
  { id: 'next-workspace',   group: 'navigation', act: 'Next workspace',           keys: ['⌃','⌥','⇥'] },
  { id: 'prev-workspace',   group: 'navigation', act: 'Previous workspace',       keys: ['⌃','⌥','⇧','⇥'] },
  { id: 'settings-search',  group: 'navigation', act: 'Focus settings search',    keys: ['⌘','/'] },
  { id: 'prompt-picker',    group: 'navigation', act: 'Open prompt picker',       keys: ['⌘','P'] },
  // Ctrl+Tab / Ctrl+Shift+Tab cycle the most-recently-active chats (across
  // workspaces). Stays consistent across Mac/Linux/Windows because ⌃ maps to
  // ctrlKey in matchesChord.
  { id: 'prev-chat',        group: 'navigation', act: 'Previous recent chat',     keys: ['⌃','⇧','⇥'] },
  { id: 'next-chat',        group: 'navigation', act: 'Next recent chat',         keys: ['⌃','⇥'] },

  // composer
  { id: 'send-message',     group: 'composer', act: 'Send message',                      keys: ['⌘','↵'] },
  { id: 'cycle-mode',       group: 'composer', act: 'Cycle mode (ask/plan/build/full access)',  keys: ['⌃','M'] },
  { id: 'insert-context',   group: 'composer', act: 'Insert context chip',               keys: ['⌘','/'] },
  { id: 'switch-model',     group: 'composer', act: 'Switch model',                      keys: ['⌘','⇧','M'] },
  { id: 'start-voice',      group: 'composer', act: 'Start voice orb microphone',         keys: ['⌃','⌥','V'] },
  { id: 'end-voice',        group: 'composer', act: 'End voice orb microphone',           keys: ['⌃','⌥','X'] },

  // terminal
  { id: 'new-terminal',           group: 'terminal', act: 'New terminal session',   keys: ['⌃','⇧','T'] },
  { id: 'clear-pane',             group: 'terminal', act: 'Clear active pane',      keys: ['⌘','L'] },
  { id: 'toggle-terminal-column', group: 'terminal', act: 'Toggle terminal column', keys: ['⌘','J'] },
  { id: 'focus-next-session',     group: 'terminal', act: 'Focus next session',     keys: ['⌃','`'] },
  { id: 'split-terminal-right',   group: 'terminal', act: 'Split terminal right',   keys: ['⌘','⇧','D'] },
  { id: 'split-terminal-down',    group: 'terminal', act: 'Split terminal down',    keys: ['⌥','⇧','D'] },

  // window
  { id: 'new-tab',      group: 'window', act: 'New tab',            keys: ['⌘','T'] },
  { id: 'close-tab',    group: 'window', act: 'Close tab',          keys: ['⌘','W'] },
  { id: 'reopen-tab',   group: 'window', act: 'Reopen closed tab',  keys: ['⌘','⇧','T'] },
  { id: 'fullscreen',   group: 'window', act: 'Toggle full screen', keys: ['⌃','⌘','F'] },

  // workspace
  { id: 'open-vscode',   group: 'workspace', act: 'Open in VS Code',          keys: ['⌘','E'] },
  { id: 'open-folder',   group: 'workspace', act: 'Open local folder…',       keys: ['⌘','O'] },
  { id: 'clone-repo',    group: 'workspace', act: 'Clone repository…',        keys: ['⌘','⇧','C'] },
  { id: 'start-crew',    group: 'workspace', act: 'Start Crew Workers',        keys: [] },

  // session
  { id: 'new-session',        group: 'session', act: 'New agent session',         keys: ['⌘','N'] },
  { id: 'duplicate-session',  group: 'session', act: 'Duplicate current session', keys: ['⌘','⇧','N'] },

  // view
  { id: 'toggle-theme',   group: 'view', act: 'Toggle light / dark theme',  keys: ['⌘','⇧','L'] },
  { id: 'cycle-theme',    group: 'view', act: 'Cycle color theme', keys: [] },
  { id: 'toggle-density', group: 'view', act: 'Density: compact · regular', keys: ['⌘','⌥','D'] },
]

export function groupedShortcuts(): ShortcutGroup[] {
  const map = new Map<string, ShortcutItem[]>()
  for (const s of SHORTCUTS) {
    if (!map.has(s.group)) map.set(s.group, [])
    map.get(s.group)!.push({ act: s.act, keys: s.keys })
  }
  return [...map.entries()].map(([title, items]) => ({ title, items }))
}

const MODIFIER_TOKENS = new Set(['⌘','⌃','⌥','⇧','Ctrl','Alt','Shift','Meta','Cmd','Command','Option'])

// US-layout shifted symbols → their unshifted base. When a chord binds a symbol
// like `]` together with Shift, the browser reports the shifted glyph (`}`) in
// `e.key`, so comparing against `]` would never match. We accept either form.
const SHIFT_BASE: Record<string, string> = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6',
  '&': '7', '*': '8', '(': '9', ')': '0', '_': '-', '+': '=',
  '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/',
}

/**
 * Returns true if the given keyboard event matches the chord. The chord is
 * an array of glyph tokens (modifiers + one main key). On non-Mac platforms,
 * ⌘ is interpreted as the platform's primary modifier (ctrl) so a Mac binding
 * Just Works for the Linux/Windows user without an explicit Ctrl rebind.
 */
export function matchesChord(e: KeyboardEvent, chord: string[]): boolean {
  if (chord.length === 0) return false
  const isMac = navigator.userAgent.includes('Mac')

  let wantMeta = false, wantCtrl = false, wantAlt = false, wantShift = false
  let mainKey: string | null = null

  for (const token of chord) {
    if (token === '⌘' || token === 'Cmd' || token === 'Command' || token === 'Meta') { isMac ? (wantMeta = true) : (wantCtrl = true) }
    else if (token === '⌃' || token === 'Ctrl')                  { wantCtrl  = true }
    else if (token === '⌥' || token === 'Alt' || token === 'Option') { wantAlt = true }
    else if (token === '⇧' || token === 'Shift')                 { wantShift = true }
    else if (!MODIFIER_TOKENS.has(token))                        { mainKey   = token }
  }
  if (!mainKey) return false
  if (e.metaKey  !== wantMeta)  return false
  if (e.ctrlKey  !== wantCtrl)  return false
  if (e.altKey   !== wantAlt)   return false
  if (e.shiftKey !== wantShift) return false

  // Normalize glyph aliases to KeyboardEvent.key.
  const normalized =
      mainKey === '↵' ? 'Enter'
    : mainKey === '⇥' ? 'Tab'
    : mainKey === '⌫' ? 'Backspace'
    : mainKey

  // Compare case-insensitively for single-char keys, accepting both the raw
  // event key and its unshifted base (so Shift+] → `}` still matches `]`).
  if (normalized.length === 1) {
    const target = normalized.toLowerCase()
    if (e.key.toLowerCase() === target) return true
    const base = SHIFT_BASE[e.key]
    return base !== undefined && base.toLowerCase() === target
  }
  return e.key === normalized
}

/**
 * Resolve the effective chord for an action: user override (matched by
 * group + act label) falls back to the default chord from SHORTCUTS.
 */
export function effectiveChord(
  id: ActionId,
  overrides: Record<string, Record<string, string[]>>,
): string[] {
  const def = SHORTCUTS.find(s => s.id === id)
  if (!def) return []
  return overrides[def.group]?.[def.act] ?? def.keys
}

export type ShortcutOverrides = Record<string, Record<string, string[]>>

// keys.json is keyed by stable ActionId (human-friendly to hand-edit), while the
// runtime overrides map is keyed by group → label. These two helpers convert
// between the on-disk form and the in-memory form. Unknown / `_`-prefixed keys
// in the file (e.g. comments) are ignored.
export function keysFileToOverrides(file: Record<string, unknown>): ShortcutOverrides {
  const out: ShortcutOverrides = {}
  for (const def of SHORTCUTS) {
    const keys = file[def.id]
    if (!Array.isArray(keys) || !keys.every(k => typeof k === 'string')) continue
    if (!out[def.group]) out[def.group] = {}
    out[def.group][def.act] = keys as string[]
  }
  return out
}

export function overridesToKeysFile(overrides: ShortcutOverrides): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const def of SHORTCUTS) {
    const keys = overrides[def.group]?.[def.act]
    if (keys) out[def.id] = keys
  }
  return out
}

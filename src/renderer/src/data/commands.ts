import { SHORTCUTS, type ActionId } from '../shortcuts'
import type { CommandGroup } from '../types'

// Visual metadata for palette rows. Anything missing here falls back to a
// neutral default so adding a new shortcut doesn't require touching the icon
// map unless you want a richer entry.
const META: Partial<Record<ActionId, { icon: string; hint: string }>> = {
  'palette':                 { icon: 'sparkle',   hint: 'open command palette' },
  'workspaces':              { icon: 'crew',      hint: 'open Workspaces drawer' },
  'next-tab':                { icon: 'chevRight', hint: '' },
  'prev-tab':                { icon: 'chevLeft',  hint: '' },
  'settings-search':         { icon: 'search',    hint: 'focus settings search' },
  'prompt-picker':           { icon: 'fileText',  hint: 'browse saved prompts' },
  'send-message':            { icon: 'send',      hint: 'send chat message' },
  'cycle-mode':              { icon: 'bolt',      hint: 'ask → plan → build → full access' },
  'insert-context':          { icon: 'tag',       hint: '@ chip' },
  'switch-model':            { icon: 'brain',     hint: 'pick model' },
  'start-voice':             { icon: 'mic',       hint: 'start voice orb microphone' },
  'end-voice':               { icon: 'x',         hint: 'stop the active voice orb' },
  'new-terminal':            { icon: 'terminal',  hint: 'open new shell' },
  'clear-pane':              { icon: 'trash',     hint: 'clear terminal output' },
  'toggle-terminal-column':  { icon: 'sidebar',   hint: 'show/hide terminal' },
  'focus-next-session':      { icon: 'chevRight', hint: '' },
  'split-terminal-right':    { icon: 'panel',     hint: 'split right' },
  'split-terminal-down':     { icon: 'panel',     hint: 'split down' },
  'new-tab':                 { icon: 'plus',      hint: 'new chat tab' },
  'close-tab':               { icon: 'x',         hint: 'close active tab' },
  'reopen-tab':              { icon: 'refresh',   hint: '' },
  'fullscreen':              { icon: 'max',       hint: '' },
  'open-vscode':             { icon: 'code',      hint: 'current workspace' },
  'open-folder':             { icon: 'projects',  hint: 'add to workspaces' },
  'clone-repo':              { icon: 'globe',     hint: 'from URL' },
  'start-crew':              { icon: 'crew',      hint: 'run agents in parallel' },
  'new-session':             { icon: 'crew',      hint: 'fresh chat thread' },
  'duplicate-session':       { icon: 'copy',      hint: '' },
  'toggle-theme':            { icon: 'sun',       hint: '' },
  'cycle-theme':             { icon: 'refresh',   hint: 'carbon → midnight → graphite → …' },
  'toggle-density':          { icon: 'sliders',   hint: '' },
}

function titleCase(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)
}

export const COMMAND_GROUPS: CommandGroup[] = (() => {
  const seenGroups: string[] = []
  const grouped: Record<string, typeof SHORTCUTS> = {}
  for (const s of SHORTCUTS) {
    if (!grouped[s.group]) { grouped[s.group] = []; seenGroups.push(s.group) }
    grouped[s.group].push(s)
  }
  return seenGroups.map(group => ({
    group: titleCase(group),
    items: grouped[group].map(s => {
      const meta = META[s.id]
      return {
        id:    s.id,
        label: s.act,
        icon:  meta?.icon ?? 'sparkle',
        hint:  meta?.hint ?? '',
        kbd:   s.keys.join(''),
      }
    }),
  }))
})()

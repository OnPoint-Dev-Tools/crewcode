import type { TweakConfig, Workspace, ModeLevel } from './types'
import type { Mode } from './components/composer/ModeSegment'

export const TWEAK_DEFAULTS: TweakConfig = {
  density:        'regular',
  drawerHeight:   360,
  drawerWidth:    300,
  drawerPosition: 'bottom',
  showTerminal:   false,
}

export const DEFAULT_MODE: ModeLevel = 'build'

export const MODE_FROM_SETTINGS: Record<'ask' | 'plan' | 'build' | 'full', Mode> = {
  // `full` is the persisted wire value; 'Full' is only its display token.
  ask: 'Ask', plan: 'Plan', build: 'Build', full: 'Full',
}

export const MODE_TO_LEVEL: Record<Mode, ModeLevel> = {
  Ask: 'ask', Plan: 'plan', Build: 'build', Full: 'full',
}

// Wire values that shipped under an older name. `yolo` became `full` (displayed
// as "Full Access"), but saved sessions and the persisted `defaultMode` still
// carry it. An unrecognized level is not harmless: `MODE_FROM_SETTINGS` returns
// undefined, which crashes the mode picker's `MODE_META` lookup, and
// `buildModePreamble` would prepend a literal "undefined" to the prompt.
const LEGACY_MODE_LEVELS: Record<string, ModeLevel> = { yolo: 'full' }

export function normalizeModeLevel(value: unknown): ModeLevel {
  if (typeof value !== 'string') return DEFAULT_MODE
  if (value in MODE_FROM_SETTINGS) return value as ModeLevel
  return LEGACY_MODE_LEVELS[value] ?? DEFAULT_MODE
}

export const EMPTY_WS: Workspace = {
  id: '', name: 'no workspace', path: '~', branch: null, dirty: 0,
  status: 'idle', kind: 'folder', pinned: false, folder: null, agents: [], updated: '',
  worktrees: [], github: null,
}

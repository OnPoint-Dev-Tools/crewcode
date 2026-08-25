import React, { createContext, useContext, useEffect, useState, useCallback, useMemo, useRef } from 'react'
import type { McpServerConfig } from '../../../shared/mcp-types'
import type { CompletionProviderId } from '../../../shared/agent-completion-types'
import { isEditorThemeId, type EditorThemeId } from '../../../shared/editor-theme-types'
import { keysFileToOverrides, overridesToKeysFile } from '../shortcuts'
import { normalizeNotificationSound, type NotificationSoundId } from '../notifications/notification-sounds'
import {
  LOCAL_VOICE_SPEED_DEFAULT,
  normalizeLocalVoiceSpeed,
  type LocalVoiceDevice,
  type VoiceProviderId,
} from '../../../shared/voice-types'
import { DEFAULT_MODE_PROMPTS, type ModePromptConfig } from './chat-session-send'
import { getCrewCodeClient } from '../runtime/crewcode-client'

export type { McpServerConfig } from '../../../shared/mcp-types'

export type DefaultMode = 'ask' | 'plan' | 'build' | 'full'
export type OnLaunch    = 'blank' | 'last session' | 'workspaces drawer'
export type AppTheme    = 'system' | 'dark' | 'light'
export type ColorTheme  = 'carbon' | 'midnight' | 'graphite' | 'solar-dark' | 'paper' | 'tomorrow'
export type Gpu         = 'auto' | 'on' | 'off'
export type Cursor      = 'off' | 'slow' | 'fast'
export type ShellChoice = 'auto' | 'bash' | 'zsh' | 'fish' | 'custom'
export type AgentId         = 'claude' | 'codex' | 'opencode' | 'hermes' | 'crewcoder' | 'grok' | 'pi' | 'ollama'
// Two release trains only. Nightly maps to "accept GitHub prereleases"; there is
// no separate beta feed to point a third option at.
export type Channel         = 'stable' | 'nightly'
// One axis instead of two booleans. The fourth combination (manual download +
// auto-install) is nonsensical, so an enum makes it unreachable.
export type UpdatePolicy    = 'manual' | 'download' | 'automatic'
export type ProfileIconKind = 'initial' | 'icon' | 'image'
// Retention is a review prompt, not a scheduler: 0 means "never expire", and no
// value here ever authorizes an automatic delete.
export type ArchiveRetentionDays = 0 | 30 | 60 | 90
export const ARCHIVE_RETENTION_CHOICES: ArchiveRetentionDays[] = [0, 30, 60, 90]

export interface SSHConn {
  id:   string
  host: string
  addr: string
  key:  string
}

// Map of "Group title → action label → key chord (raw glyph or plain key)"
export type ShortcutOverrides = Record<string, Record<string, string[]>>

export interface SettingsState {
  zoom: number
  defaultMode: DefaultMode
  // Workspace-scoped branch defaults for newly-created chat sessions. Empty or
  // missing entries use the workspace's primary checkout.
  defaultBranchByWorkspace: Record<string, string>
  // Prompt text is configurable, but enablement is stored per chat session and
  // provider-native permission enforcement never depends on these strings.
  modePrompts: ModePromptConfig
  onLaunch: OnLaunch
  showTweaksPanel: boolean
  username: string
  profileIconKind: ProfileIconKind
  profileIconValue: string
  appTheme: AppTheme
  theme: ColorTheme
  fontFamily: string
  fontSize: number
  fontWeight: 300 | 400 | 500 | 600
  lineHeight: number
  ligatures: boolean
  // Per-surface overrides. Empty string / 0 means "inherit from the global mono
  // settings above". Code editor and terminal each get their own family/size
  // because operators usually want a denser font in panes than in chat chips.
  editorFontFamily: string
  editorFontSize: number
  editorLineHeight: number
  terminalFontFamily: string
  terminalFontSize: number
  terminalLineHeight: number
  gpu: Gpu
  gpuLive: boolean
  cursor: Cursor
  // Terminal shell selection used for "+ shell" panes. 'auto' honors the user's
  // login shell ($SHELL); 'fish'/'bash'/'zsh' force an installed copy; 'custom'
  // uses customShellPath verbatim.
  defaultShell: ShellChoice
  customShellPath: string
  defaultAgent: AgentId
  connections: Record<AgentId, boolean>
  channel: Channel
  updatePolicy: UpdatePolicy
  // Integrations
  githubConnected: boolean
  // SSH
  sshConns: SSHConn[]
  // Shortcuts
  shortcutOverrides: ShortcutOverrides
  // Per-agent launch path overrides (binary path or absolute path).
  // Empty string / missing entry = use auto-detected default.
  agentPathOverrides: Record<string, string>
  // Per-workspace plugin activation. Missing workspace/plugin entries inherit
  // true so existing local plugins keep working until a user disables them for
  // a specific workspace.
  pluginWorkspaceEnabled: Record<string, Record<string, boolean>>
  // MCP (Model Context Protocol). Off by default — even with servers in the
  // registry, nothing is sent to an agent until the user opts a session in via
  // the composer picker.
  mcpEnabled: boolean
  mcpServers: McpServerConfig[]
  // First-run onboarding. False for a brand-new install (no stored settings);
  // returning users are seeded true in loadInitial so they never see it.
  onboardingCompleted: boolean
  // Native OS notification when an agent finishes a turn. Only fires while the
  // CrewCode window is unfocused, so it never interrupts active watching.
  nativeNotifications: boolean
  // Native OS notifications can use the platform sound, a restrained CrewCode
  // tone, or remain silent. Custom tones are synthesized without bundled media.
  notificationSound: NotificationSoundId
  // Hide internal reasoning/tool/work-log rows in chat surfaces, leaving the
  // conversation focused on user prompts and final agent replies.
  hideVerboseAgentLogs: boolean
  // Todo activity is presentation-only; approvals and questions remain visible
  // even when this global preference is disabled.
  showTodoActivity: boolean
  // Skip the signing-key passphrase prompt on commit and always commit unsigned
  // when the signing key can't be unlocked in-process.
  alwaysCommitUnsigned: boolean
  // Delegation is enabled per solo chat (`Session.delegationEnabled`), not
  // globally. These two are the global guardrails around it.
  // Cap on a delegating agent's simultaneously open threads. An agent in a retry
  // loop can otherwise create hundreds, each a full model context.
  maxDelegatedThreads: number
  // Whether a delegated thread may run in Full Access. Off by default: threads
  // you are not watching should still ask before destructive tools.
  allowFullAccessDelegation: boolean
  // Whether a finished delegated thread may start a turn in an IDLE parent chat.
  // Off, its report is buffered until you next speak. On, the parent reacts on
  // its own — bounded by MAX_AUTONOMOUS_WAKES per user turn, the same brake crew
  // uses (MAX_SUPERVISOR_ROUNDS), because an unbounded wake loop can chain all
  // night with nobody watching.
  wakeParentOnDelegatedReport: boolean
  // How long an archived chat may sit before CrewCode flags it as expired.
  // 0 = never expire. This only ever FLAGS chats for review in the Archive
  // page — nothing is deleted without an explicit user action.
  archiveRetentionDays: ArchiveRetentionDays
  // The editor palette is independent from the app chrome theme.
  editorTheme: EditorThemeId
  // Editor completions are isolated from chat selection so users can choose a
  // small, low-latency model without changing their primary agent workflow.
  editorCompletionEnabled: boolean
  editorCompletionProvider: CompletionProviderId
  editorCompletionModel: string
  // Voice is opt-in and provider-neutral. Paid providers remain inert until
  // their main-process key status reports configured.
  voiceProvider: VoiceProviderId
  voiceOpenAIModel: string
  voiceOpenAIVoice: string
  voiceXaiModel: string
  voiceXaiVoice: string
  voiceLocalPythonPath: string
  voiceLocalVoice: string
  voiceLocalDevice: LocalVoiceDevice
  voiceLocalSpeed: number
}

export const DEFAULT_SETTINGS: SettingsState = {
  zoom: 100,
  defaultMode: 'build',
  defaultBranchByWorkspace: {},
  modePrompts: { ...DEFAULT_MODE_PROMPTS },
  onLaunch: 'last session',
  showTweaksPanel: true,
  username: 'CrewCode User',
  profileIconKind: 'initial',
  profileIconValue: '',
  appTheme: 'dark',
  theme: 'carbon',
  fontFamily: 'JetBrains Mono',
  fontSize: 13,
  fontWeight: 500,
  lineHeight: 1.55,
  ligatures: true,
  editorFontFamily: '',
  editorFontSize: 0,
  editorLineHeight: 0,
  terminalFontFamily: '',
  terminalFontSize: 0,
  terminalLineHeight: 0,
  gpu: 'auto',
  gpuLive: true,
  cursor: 'slow',
  defaultShell: 'auto',
  customShellPath: '',
  defaultAgent: 'codex',
  connections: { claude: true, pi: true, codex: false, opencode: false, hermes: false, crewcoder: false, grok: false, ollama: false },
  channel: 'stable',
  updatePolicy: 'automatic',
  githubConnected: true,
  sshConns: [],
  shortcutOverrides: {},
  agentPathOverrides: {},
  pluginWorkspaceEnabled: {},
  mcpEnabled: false,
  mcpServers: [],
  onboardingCompleted: false,
  nativeNotifications: true,
  notificationSound: 'system',
  hideVerboseAgentLogs: false,
  showTodoActivity: true,
  alwaysCommitUnsigned: false,
  archiveRetentionDays: 0,
  maxDelegatedThreads: 4,
  allowFullAccessDelegation: false,
  wakeParentOnDelegatedReport: true,
  editorTheme: 'crewcode',
  editorCompletionEnabled: false,
  editorCompletionProvider: 'opencode-go',
  editorCompletionModel: '',
  voiceProvider: 'off',
  voiceOpenAIModel: 'gpt-realtime-2.1',
  voiceOpenAIVoice: 'marin',
  voiceXaiModel: 'grok-voice-latest',
  voiceXaiVoice: 'eve',
  voiceLocalPythonPath: '',
  voiceLocalVoice: 'am_michael',
  voiceLocalDevice: 'auto',
  voiceLocalSpeed: LOCAL_VOICE_SPEED_DEFAULT,
}

const STORAGE_KEY = 'crewcode:settings'

// SF Mono / Monaco were removed from the font picker (Apple-proprietary, can't
// bundle or render off macOS). Remap any persisted selection to the default so
// upgraders don't stay stuck on a font that silently falls back.
const REMOVED_FONT_FAMILIES = new Set(['SF Mono', 'Monaco'])
function migrateFontFamily(value: string | undefined, fallback: string): string {
  if (value && REMOVED_FONT_FAMILIES.has(value.trim())) return fallback
  return value ?? fallback
}

// 'beta' was offered before the channel actually did anything. Anyone holding it
// falls back to stable rather than to an option that no longer renders.
function migrateChannel(value: unknown): Channel {
  return value === 'nightly' ? 'nightly' : 'stable'
}

function normalizeLocalVoiceDevice(value: unknown): LocalVoiceDevice {
  return value === 'gpu' || value === 'cpu' ? value : 'auto'
}

// Collapses the earlier autoUpdate/installOnQuit booleans onto the single
// policy axis for upgraders. New installs carry updatePolicy directly.
function normalizeModePrompts(value: unknown): ModePromptConfig {
  const stored = value && typeof value === 'object' ? value as Partial<ModePromptConfig> : {}
  return {
    ask: typeof stored.ask === 'string' ? stored.ask : DEFAULT_MODE_PROMPTS.ask,
    plan: typeof stored.plan === 'string' ? stored.plan : DEFAULT_MODE_PROMPTS.plan,
    build: typeof stored.build === 'string' ? stored.build : DEFAULT_MODE_PROMPTS.build,
    full: typeof stored.full === 'string' ? stored.full : DEFAULT_MODE_PROMPTS.full,
  }
}

function migrateUpdatePolicy(parsed: Partial<SettingsState> & { autoUpdate?: unknown; installOnQuit?: unknown }): UpdatePolicy {
  if (parsed.updatePolicy === 'manual' || parsed.updatePolicy === 'download' || parsed.updatePolicy === 'automatic') {
    return parsed.updatePolicy
  }
  if (parsed.autoUpdate === false) return 'manual'
  return parsed.installOnQuit === false ? 'download' : 'automatic'
}

// Renderer's single enum -> the two independent flags main's applyConfig wants.
export function updatePolicyToConfig(policy: UpdatePolicy): { autoDownload: boolean; installOnQuit: boolean } {
  return {
    autoDownload: policy !== 'manual',
    installOnQuit: policy === 'automatic',
  }
}

function loadInitial(): SettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<SettingsState>
    // Shallow merge so newly-added fields fall back to defaults.
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      // '' on the override fields means "inherit the global mono family".
      fontFamily:         migrateFontFamily(parsed.fontFamily, DEFAULT_SETTINGS.fontFamily),
      editorFontFamily:   migrateFontFamily(parsed.editorFontFamily, ''),
      terminalFontFamily: migrateFontFamily(parsed.terminalFontFamily, ''),
      connections: { ...DEFAULT_SETTINGS.connections, ...(parsed.connections ?? {}) },
      shortcutOverrides: parsed.shortcutOverrides ?? {},
      sshConns: parsed.sshConns ?? [],
      agentPathOverrides: parsed.agentPathOverrides ?? {},
      pluginWorkspaceEnabled: parsed.pluginWorkspaceEnabled ?? {},
      defaultBranchByWorkspace: parsed.defaultBranchByWorkspace ?? {},
      mcpServers: parsed.mcpServers ?? [],
      channel: migrateChannel(parsed.channel),
      updatePolicy: migrateUpdatePolicy(parsed),
      modePrompts: normalizeModePrompts(parsed.modePrompts),
      editorTheme: isEditorThemeId(parsed.editorTheme) ? parsed.editorTheme : DEFAULT_SETTINGS.editorTheme,
      notificationSound: normalizeNotificationSound(parsed.notificationSound),
      voiceLocalDevice: normalizeLocalVoiceDevice(parsed.voiceLocalDevice),
      voiceLocalSpeed: normalizeLocalVoiceSpeed(parsed.voiceLocalSpeed),
      // A corrupt/unknown retention value must fall back to "never expire" —
      // never to a window that would flag history as deletable.
      archiveRetentionDays: ARCHIVE_RETENTION_CHOICES.includes(parsed.archiveRetentionDays as ArchiveRetentionDays)
        ? parsed.archiveRetentionDays as ArchiveRetentionDays
        : DEFAULT_SETTINGS.archiveRetentionDays,
      // A stored settings blob means this isn't a first run, so don't replay
      // onboarding for upgraders who predate the flag.
      onboardingCompleted: parsed.onboardingCompleted ?? true,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export type SetSetting = <K extends keyof SettingsState>(key: K, value: SettingsState[K]) => void

interface SettingsCtx {
  state:   SettingsState
  set:     SetSetting
  reset:   () => void
  // For displaying the "saved · just now" chip
  savedAt: number
}

const Ctx = createContext<SettingsCtx | null>(null)

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SettingsState>(loadInitial)
  const [savedAt, setSavedAt] = useState<number>(Date.now())

  // keys.json is the source of truth for shortcut overrides. On startup, load it
  // and apply; if it doesn't exist yet, create it (seeded from whatever overrides
  // localStorage carried) so it always exists and stays editable. Runs once.
  const initialOverridesRef = useRef(state.shortcutOverrides)
  useEffect(() => {
    let cancelled = false
    window.electronAPI?.keybindsRead?.()
      .then(res => {
        if (cancelled || !res?.ok) return
        if (res.data) {
          setState(prev => ({ ...prev, shortcutOverrides: keysFileToOverrides(res.data!) }))
        } else {
          void window.electronAPI?.keybindsWrite(overridesToKeysFile(initialOverridesRef.current))
        }
      })
      .catch(() => { /* unreadable — keep localStorage overrides */ })
    return () => { cancelled = true }
  }, [])

  // Hot-reload: re-apply overrides whenever keys.json changes on disk (manual
  // edit, or our own write echoing back — harmless, content is identical).
  // A deleted/empty file falls back to defaults.
  useEffect(() => {
    const off = window.electronAPI?.onKeybindsChanged?.(event => {
      if (!event?.ok) return
      const overrides = event.data ? keysFileToOverrides(event.data) : {}
      setState(prev => ({ ...prev, shortcutOverrides: overrides }))
    })
    return off
  }, [])

  // Persist on every change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      setSavedAt(Date.now())
    } catch {
      /* quota or serialization error — non-fatal */
    }
  }, [state])

  useEffect(() => {
    if (state.voiceProvider !== 'local') return
    // Let the first paint settle, then hide Parakeet's cold start behind normal
    // app use. Kokoro remains unloaded until an orb turn needs speech.
    const timer = window.setTimeout(() => {
      void getCrewCodeClient().voiceLocalPrewarm({
        pythonPath: state.voiceLocalPythonPath,
        device: state.voiceLocalDevice,
      }, 'transcription')
        .catch(() => { /* The voice UI reports actionable sidecar errors when used. */ })
    }, 750)
    return () => window.clearTimeout(timer)
  }, [state.voiceProvider, state.voiceLocalPythonPath, state.voiceLocalDevice])

  const set = useCallback<SetSetting>((key, value) => {
    setState(prev => ({ ...prev, [key]: value }))
  }, [])

  const reset = useCallback(() => setState(DEFAULT_SETTINGS), [])

  const value = useMemo(() => ({ state, set, reset, savedAt }), [state, set, reset, savedAt])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSettings(): SettingsCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useSettings must be used within <SettingsProvider>')
  return ctx
}

// Resolve per-surface typography against the global mono fallback. Empty
// string / 0 in the override fields means "inherit", so the caller gets back
// a concrete value it can apply without further checks.
export function resolveEditorFont(state: SettingsState): { family: string; size: number; lineHeight: number } {
  return {
    family:     state.editorFontFamily.trim() || state.fontFamily,
    size:       state.editorFontSize > 0 ? state.editorFontSize : state.fontSize,
    lineHeight: state.editorLineHeight > 0 ? state.editorLineHeight : state.lineHeight,
  }
}

export function resolveTerminalFont(state: SettingsState): { family: string; size: number; lineHeight: number } {
  return {
    family:     state.terminalFontFamily.trim() || state.fontFamily,
    size:       state.terminalFontSize > 0 ? state.terminalFontSize : state.fontSize,
    lineHeight: state.terminalLineHeight > 0 ? state.terminalLineHeight : state.lineHeight,
  }
}

export function quoteFontFamilyName(family: string): string {
  const trimmed = family.trim()
  if (!trimmed) return 'monospace'
  if (/^['"].*['"]$/.test(trimmed)) return trimmed
  return /[\s,]/.test(trimmed) ? `"${trimmed.replace(/"/g, '\\"')}"` : trimmed
}

export function monoFontStack(family: string): string {
  return `${quoteFontFamilyName(family)}, ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace`
}

// Reduce the user's shell preference to the string we hand to pty:create.
// Returns undefined for "auto" so the main process falls through to its own
// $SHELL/fish/zsh/bash resolution.
export function effectiveShell(state: SettingsState): string | undefined {
  if (state.defaultShell === 'auto') return undefined
  if (state.defaultShell === 'custom') {
    const p = state.customShellPath.trim()
    return p.length > 0 ? p : undefined
  }
  return state.defaultShell
}

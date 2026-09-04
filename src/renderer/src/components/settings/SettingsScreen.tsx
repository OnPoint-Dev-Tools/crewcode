import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Icon, type IconName } from '../ui/Icon'
import {
  useSettings,
  DEFAULT_SETTINGS,
  type SetSetting,
  type SettingsState,
  type DefaultMode,
  type OnLaunch,
  type AppTheme,
  type ColorTheme,
  type Gpu,
  type Cursor,
  type ShellChoice,
  type AgentId,
  type Channel,
  type UpdatePolicy,
  updatePolicyToConfig,
  type SSHConn,
  type McpServerConfig,
} from '../../hooks/useSettings'
import { groupedShortcuts, overridesToKeysFile } from '../../shortcuts'
import { useMcpFileServers } from '../../hooks/useMcpFileServers'
import { useProviderModels } from '../../hooks/useProviderModels'
import { GhAuthModal } from './GhAuthModal'
import { SshKeysModal } from './SshKeysModal'
import {
  PROFILE_ICON_PRESETS,
  UserProfileAvatar,
  normalizeUserDisplayName,
  type ProfileIconPreset,
} from '../profile/UserProfileAvatar'
import { PROVIDER_IMAGES, providerImageClass } from '../composer/provider-meta'
import { SETTINGS_SECTION_EVENT, takePendingSettingsSection } from './settings-section-focus'
import type { AppBuildInfo, UpdaterEvent, GhStatus, AgentInfo, Workspace } from '../../types'
import type { CompletionProviderId } from '../../../../shared/agent-completion-types'
import {
  LOCAL_VOICE_SPEED_MAX,
  LOCAL_VOICE_SPEED_MIN,
  type LocalVoiceDevice,
} from '../../../../shared/voice-types'
import { getCrewCodeClient, getCrewCodeRuntime } from '../../runtime/crewcode-client'
import { BrainAuthorizationSection } from './BrainAuthorizationSection'
import type { EditorThemeId } from '../../../../shared/editor-theme-types'
import type { HubMachineSummary } from '../../../../shared/hub-machine-types'
import type {
  RemoteVoiceProviderId,
  VoiceProviderAvailabilityMap,
  VoiceProviderId,
  LocalVoiceServiceStatus,
} from '../../../../shared/voice-types'
import { EDITOR_THEME_OPTIONS } from '../editor/editor-theme-registry'
import {
  NOTIFICATION_SOUND_IDS,
  normalizeNotificationSound,
  playNotificationSound,
} from '../../notifications/notification-sounds'
import { DEFAULT_MODE_PROMPTS } from '../../hooks/chat-session-send'
import { MAX_AUTONOMOUS_WAKES } from '../../hooks/delegation-report'

/* ---------- Platform-aware kbd glyphs ---------- */

const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
const KEY_MAP: Record<string, string> = IS_MAC
  ? { '⌘': '⌘', '⌃': '⌃', '⌥': '⌥', '⇧': '⇧', '↵': '↵', '⇥': '⇥', '⌫': '⌫' }
  : { '⌘': 'Ctrl', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift', '↵': 'Enter', '⇥': 'Tab', '⌫': 'Backspace' }
const k = (key: string) => KEY_MAP[key] ?? key

/* ---------- Generic controls ---------- */

type SegOption<T extends string> = T | { value: T; label: string; icon?: IconName }

function Seg<T extends string>({ value, options, onChange }: {
  value: T; options: SegOption<T>[]; onChange: (v: T) => void
}) {
  return (
    <div className="ss-seg" role="radiogroup">
      {options.map(opt => {
        const v = typeof opt === 'string' ? opt : opt.value
        const lbl = typeof opt === 'string' ? opt : opt.label
        const ico = typeof opt === 'object' ? opt.icon : null
        return (
          <button
            key={v}
            className={value === v ? 'on' : ''}
            onClick={() => onChange(v as T)}
            role="radio"
            aria-checked={value === v}
          >
            {ico ? <Icon name={ico} size={12} /> : null}{lbl}
          </button>
        )
      })}
    </div>
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={'ss-toggle' + (value ? ' on' : '')}
      onClick={() => onChange(!value)}
      role="switch"
      aria-checked={value}
    />
  )
}

function Slider({ value, min, max, step = 1, unit = '', onChange, commitOnRelease = false }: {
  value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void
  /** Avoid relayout feedback while dragging controls whose value resizes the UI. */
  commitOnRelease?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const dragging = useRef(false)

  useEffect(() => {
    if (!dragging.current) setDraft(value)
  }, [value])

  const update = (next: number) => {
    setDraft(next)
    if (!commitOnRelease || !dragging.current) onChange(next)
  }
  const commit = () => {
    if (!dragging.current) return
    dragging.current = false
    if (draft !== value) onChange(draft)
  }

  return (
    <div className="ss-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        onPointerDown={() => { dragging.current = true }}
        onPointerUp={commit}
        onPointerCancel={commit}
        onBlur={commit}
        onChange={e => update(Number(e.target.value))}
      />
      <span className="val">{draft}{unit}</span>
    </div>
  )
}

function Select({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const fn = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [])
  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="ss-select" onClick={() => setOpen(o => !o)}>
        <span>{value}</span>
        <Icon name="chevDown" size={12} />
      </button>
      {open && (
        <div className="ss-menu" style={{ top: 'calc(100% + 4px)', right: 0, minWidth: 220 }}>
          {options.map(opt => (
            <button key={opt} className="ss-menu-item" onClick={() => { onChange(opt); setOpen(false) }}>
              {opt}
              {opt === value && <Icon name="check" size={12} className="ck" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------- Section: User ---------- */

const PROFILE_IMAGE_TYPES = new Set(['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp', 'image/gif'])
const PROFILE_IMAGE_ACCEPT = Array.from(PROFILE_IMAGE_TYPES).join(',')
const PROFILE_IMAGE_MAX_BYTES = 1024 * 1024

function ProfileSection({ state, set }: { state: SettingsState; set: SetSetting }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const displayName = normalizeUserDisplayName(state.username)

  const choosePreset = (icon: ProfileIconPreset) => {
    setError(null)
    set('profileIconKind', 'icon')
    set('profileIconValue', icon)
  }

  const chooseInitial = () => {
    setError(null)
    set('profileIconKind', 'initial')
    set('profileIconValue', '')
  }

  const chooseImage = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!PROFILE_IMAGE_TYPES.has(file.type)) {
      setError('Choose a png, svg, jpg, webp, or gif image.')
      return
    }
    if (file.size > PROFILE_IMAGE_MAX_BYTES) {
      setError('Choose an image under 1 MB so settings stay fast.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const data = typeof reader.result === 'string' ? reader.result : ''
      if (!data) {
        setError('Could not read that image.')
        return
      }
      setError(null)
      set('profileIconKind', 'image')
      set('profileIconValue', data)
    }
    reader.onerror = () => setError('Could not read that image.')
    reader.readAsDataURL(file)
  }

  return (
    <section id="user" className="ss-section">
      <div className="ss-section-h">
        <h2>User</h2>
        <span className="desc">name &amp; global profile icon</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-profile-editor" data-q="user profile username avatar icon png svg image">
          <div className="ss-profile-preview">
            <UserProfileAvatar
              username={state.username}
              iconKind={state.profileIconKind}
              iconValue={state.profileIconValue}
              size={56}
              className="large"
            />
            <div>
              <div className="label">{displayName}</div>
              <div className="help">Shown in chat bubbles and the settings footer.</div>
            </div>
          </div>

          <label className="ss-profile-field">
            <span>Username</span>
            <input
              className="ss-agent-edit-input"
              value={state.username}
              maxLength={40}
              placeholder="user"
              onChange={e => set('username', e.target.value)}
            />
          </label>

          <div className="ss-profile-picker">
            <div className="ss-profile-picker-head">
              <span>Profile icon</span>
              <button className="ss-btn" type="button" onClick={() => fileRef.current?.click()}>
                <Icon name="download" size={12} />choose image
              </button>
              <button className="ss-btn" type="button" onClick={chooseInitial}>use initial</button>
            </div>
            <input ref={fileRef} type="file" accept={PROFILE_IMAGE_ACCEPT} onChange={chooseImage} hidden />
            <div className="ss-profile-icons" role="list" aria-label="profile icon presets">
              {PROFILE_ICON_PRESETS.map(icon => (
                <button
                  key={icon}
                  type="button"
                  className={state.profileIconKind === 'icon' && state.profileIconValue === icon ? 'on' : ''}
                  onClick={() => choosePreset(icon)}
                  aria-label={`use ${icon} icon`}
                >
                  <Icon name={icon} size={16} />
                </button>
              ))}
            </div>
            <div className="help">Supports local png, svg, jpg, webp, and gif files. Images stay in local settings.</div>
            {error && <div className="ss-profile-error">{error}</div>}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ---------- Section: General ---------- */

function GeneralSection({ state, set, workspace }: { state: SettingsState; set: SetSetting; workspace?: Workspace | null }) {
  const [detectedBranches, setDetectedBranches] = useState<string[]>([])
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [branchesError, setBranchesError] = useState('')

  useEffect(() => {
    let cancelled = false
    if (!workspace || workspace.kind !== 'repo') {
      setDetectedBranches([])
      setBranchesError('')
      setBranchesLoading(false)
      return () => { cancelled = true }
    }
    setBranchesLoading(true)
    setBranchesError('')
    void window.electronAPI?.gitBranches(workspace.path)
      .then(result => {
        if (cancelled) return
        if (result?.error) {
          setDetectedBranches([])
          setBranchesError(result.error)
          return
        }
        const names = new Set((result?.branches ?? []).map(branch => branch.name).filter(Boolean))
        if (workspace.branch) names.add(workspace.branch)
        for (const worktree of workspace.worktrees ?? []) if (worktree.branch) names.add(worktree.branch)
        setDetectedBranches([...names].sort((a, b) => a.localeCompare(b)))
      })
      .catch(error => {
        if (!cancelled) setBranchesError((error as Error).message || 'Unable to detect branches')
      })
      .finally(() => { if (!cancelled) setBranchesLoading(false) })
    return () => { cancelled = true }
  }, [workspace?.id, workspace?.kind, workspace?.path, workspace?.branch, workspace?.worktrees])

  const selectedDefaultBranch = workspace ? state.defaultBranchByWorkspace[workspace.id] ?? '' : ''
  const setDefaultBranch = (branch: string) => {
    if (!workspace) return
    const next = { ...state.defaultBranchByWorkspace }
    if (branch) next[workspace.id] = branch
    else delete next[workspace.id]
    set('defaultBranchByWorkspace', next)
  }
  const selectNotificationSound = (value: string) => {
    const sound = normalizeNotificationSound(value)
    set('notificationSound', sound)
    playNotificationSound(sound)
  }

  return (
    <section id="general" className="ss-section">
      <div className="ss-section-h">
        <h2>General</h2>
        <span className="desc">workspace defaults &amp; scaling</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-row" data-q="ui zoom scale interface">
          <div>
            <div className="label">UI Zoom</div>
            <div className="help">Scale the interface using native desktop zoom, like VS Code. Use <span className="kbd">{k('⌃')} +</span> / <span className="kbd">{k('⌃')} −</span> when not in a terminal pane.</div>
          </div>
          <Slider value={state.zoom} min={75} max={150} step={5} unit="%" commitOnRelease onChange={v => set('zoom', v)} />
        </div>
        <div className="ss-row" data-q="default mode build plan ask full full access">
          <div>
            <div className="label">Default composer mode</div>
            <div className="help">Applied to new threads. Override per thread with <span className="kbd">{k('⌃')}M</span>.</div>
          </div>
          <Seg<DefaultMode> value={state.defaultMode} options={['ask','plan','build','full']} onChange={v => set('defaultMode', v)} />
        </div>
        <div className="ss-row" data-q="default branch git detected branches new chat session worktree comparison base sidebar workspace">
          <div>
            <div className="label">Default branch</div>
            <div className="help">New chats in {workspace?.name ?? 'the active workspace'} start on this branch. Git Workspace and Git Sidebar also compare the active worktree against it; existing chats keep their current branch.</div>
            {branchesError ? <div className="help" style={{ color: 'var(--destructive)' }}>{branchesError}</div> : null}
          </div>
          <select
            className="ss-select mono"
            value={selectedDefaultBranch}
            disabled={!workspace || workspace.kind !== 'repo' || branchesLoading}
            onChange={event => setDefaultBranch(event.target.value)}
            aria-label="Default branch"
          >
            <option value="">{branchesLoading ? 'Detecting branches…' : workspace?.branch ? `Workspace checkout (${workspace.branch})` : 'Workspace checkout'}</option>
            {selectedDefaultBranch && !detectedBranches.includes(selectedDefaultBranch) ? <option value={selectedDefaultBranch}>{selectedDefaultBranch} (unavailable)</option> : null}
            {detectedBranches.map(branch => <option key={branch} value={branch}>{branch}</option>)}
          </select>
        </div>
        <div className="ss-row" data-q="start on launch reopen tabs">
          <div>
            <div className="label">On launch</div>
            <div className="help">What to open when CrewCode starts.</div>
          </div>
          <Seg<OnLaunch> value={state.onLaunch} options={['blank','last session','workspaces drawer']} onChange={v => set('onLaunch', v)} />
        </div>
        {typeof window.electronAPI?.trayConfigure === 'function' && <div className="ss-row" data-q="system tray background close window keep running open quit">
          <div>
            <div className="label">Keep running in background</div>
            <div className="help">When you close the CrewCode window, keep terminals and agents running and reopen the app from the system tray. Use <b>Quit CrewCode</b> in the tray menu to exit fully.</div>
          </div>
          <Toggle value={state.keepRunningInBackground} onChange={v => set('keepRunningInBackground', v)} />
        </div>}
        <div className="ss-row" data-q="tweaks panel floating controls visibility">
          <div>
            <div className="label">Layout panel</div>
            <div className="help">Show the floating layout controls in the workspace.</div>
          </div>
          <Toggle value={state.showTweaksPanel} onChange={v => set('showTweaksPanel', v)} />
        </div>
        <div className="ss-row" data-q="todo task plan agent activity overlay visibility">
          <div>
            <div className="label">Todo activity</div>
            <div className="help">Show agent todo, task, and planning progress above the composer. Approvals and questions always remain visible.</div>
          </div>
          <Toggle value={state.showTodoActivity} onChange={v => set('showTodoActivity', v)} />
        </div>
        <div className="ss-row" data-q="delegation delegated threads limit concurrent spawn agents">
          <div>
            <div className="label">Max delegated threads</div>
            <div className="help">How many threads one agent may have open at once. Delegation is turned on per chat from the chat header; this is the ceiling. Past it, spawns are refused.</div>
          </div>
          <select
            className="ss-select mono"
            value={String(state.maxDelegatedThreads)}
            onChange={e => set('maxDelegatedThreads', Math.max(1, Number(e.target.value) || 4))}
          >
            {[2, 4, 6, 8].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div className="ss-row" data-q="delegation full access delegated threads permission bypass">
          <div>
            <div className="label">Full Access in delegated threads</div>
            <div className="help">Allow a delegated thread to run with every tool pre-approved. Off by default: threads you are not watching should still ask before destructive tools.</div>
          </div>
          <Toggle value={state.allowFullAccessDelegation} onChange={v => set('allowFullAccessDelegation', v)} />
        </div>
        <div className="ss-row" data-q="delegation wake parent chat report finished worker autonomous">
          <div>
            <div className="label">Wake chat on delegated report</div>
            <div className="help">When a delegated thread finishes and its chat is idle, let the agent start a turn on its own to handle the result. Capped at {MAX_AUTONOMOUS_WAKES} wake-ups per message you send, then it waits for you. Off, reports are held until you next speak.</div>
          </div>
          <Toggle value={state.wakeParentOnDelegatedReport !== false} onChange={v => set('wakeParentOnDelegatedReport', v)} />
        </div>
        <div className="ss-row" data-q="native desktop notifications agent turn finished done">
          <div>
            <div className="label">Desktop notifications</div>
            <div className="help">Send a native OS notification when an agent finishes a turn. Only fires while CrewCode is unfocused.</div>
          </div>
          <Toggle value={state.nativeNotifications} onChange={v => set('nativeNotifications', v)} />
        </div>
        <div className="ss-row" data-q="notification sound system bell ding knock silent none preview">
          <div>
            <div className="label">Notification sound</div>
            <div className="help">Choose the sound used for completed-agent desktop notifications. Custom sounds preview when selected.</div>
          </div>
          <Select
            value={state.notificationSound}
            options={[...NOTIFICATION_SOUND_IDS]}
            onChange={selectNotificationSound}
          />
        </div>
        <div className="ss-row" data-q="yuheard terminal agent alert knock">
          <div>
            <div className="label">YuHeard alerts</div>
            <div className="help">Play a knock sound (and optional OS notification) when an agent in a CrewCode terminal pane finishes a turn. Does not replace chat notifications — those still use Desktop notifications / Notification sound above. See <code>docs/yuheard.md</code>.</div>
          </div>
          <Toggle value={state.yuheardEnabled} onChange={v => set('yuheardEnabled', v)} />
        </div>
        <div className="ss-row" data-q="yuheard auto wrap shell function shim">
          <div>
            <div className="label">Auto-wrap agent commands</div>
            <div className="help">In plain shell panes, prepend a shim directory to PATH so typing <code>claude</code>, <code>codex</code>, <code>opencode</code>, <code>grok</code>, <code>hermes</code>, <code>pi</code>, <code>crewcoder</code>, or <code>ollama</code> auto-reports lifecycle to YuHeard. The real binary is exec'd unchanged.</div>
          </div>
          <Toggle value={state.yuheardAutoWrap} onChange={v => set('yuheardAutoWrap', v)} />
        </div>
        <div className="ss-row" data-q="yuheard test knock sound">
          <div>
            <div className="label">Test knock sound</div>
            <div className="help">Play the knock that YuHeard plays on agent completion.</div>
          </div>
          <button className="ss-btn" onClick={() => playNotificationSound('knock')}>Play</button>
        </div>
        <div className="ss-row" data-q="git commit signing gpg ssh passphrase unsigned sign key">
          <div>
            <div className="label">Always commit unsigned</div>
            <div className="help">Skip the signing-key passphrase prompt and commit without a signature when the key can't be unlocked. Leave off to be prompted for your passphrase.</div>
          </div>
          <Toggle value={state.alwaysCommitUnsigned} onChange={v => set('alwaysCommitUnsigned', v)} />
        </div>
        <div className="ss-row" data-q="onboarding welcome tour first run replay">
          <div>
            <div className="label">Onboarding</div>
            <div className="help">Replay the first-run welcome and setup tour.</div>
          </div>
          <button className="ss-btn" onClick={() => set('onboardingCompleted', false)}>
            <Icon name="sparkle" size={12} />replay tour
          </button>
        </div>
      </div>
    </section>
  )
}

function BrainContinuitySection() {
  const [status, setStatus] = useState<import('../../../../shared/brain-desktop-types').BrainDesktopStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(() => {
    void window.electronAPI?.brainDesktopStatus(true).then(setStatus).catch(cause => setError((cause as Error).message))
  }, [])
  useEffect(refresh, [refresh])

  const enable = async () => {
    setBusy(true); setError('')
    try {
      const next = await window.electronAPI!.brainDesktopSetEnabled(true)
      setStatus(next)
      if (next.attached) window.location.reload()
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  const stop = async () => {
    setBusy(true); setError('')
    try {
      setStatus(await window.electronAPI!.brainDesktopStop())
      window.location.reload()
    } catch (cause) { setError((cause as Error).message) }
    finally { setBusy(false) }
  }
  const openHub = async () => {
    if (!status?.hubBrowserOrigin) return
    setError('')
    try {
      const result = await window.electronAPI!.openExternal(status.hubBrowserOrigin)
      if (!result.ok) setError('CrewCode could not open the Hub browser URL.')
    } catch (cause) { setError((cause as Error).message) }
  }

  const loopbackHub = status?.hubBrowserOrigin
    ? ['localhost', '127.0.0.1', '::1'].includes(new URL(status.hubBrowserOrigin).hostname)
    : false

  return (
    <section id="brain-continuity" className="ss-section">
      <div className="ss-section-h">
        <h2>Desktop &amp; Web</h2>
        <span className="desc">Brain continuity</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-row" data-q="brain background web continuity remote conversations workspaces">
          <div>
            <div className="label">Background Brain</div>
            <div className="help">Make this machine's Brain authoritative for workspaces, conversations, terminals, and agents. Closing the desktop window leaves enrolled web access available; <b>Stop Brain</b> removes that availability.</div>
            <div className="help mono">{status?.running ? 'running · desktop attached' : status?.enabled ? 'enabled · not reachable' : status?.enrolled ? 'ready to enable' : 'Hub enrollment required'}</div>
            {status?.hubBrowserOrigin ? (
              <>
                <div className="help mono">Hub browser · {status.hubBrowserOrigin}{loopbackHub ? ' · this PC only' : ''}</div>
                <div className="help">The Hub web server is separate from the Brain and must be running and reachable at this address.</div>
              </>
            ) : status?.hubOrigin ? <div className="help mono">Hub browser · {status.hubReachable === false ? 'not reachable' : 'origin unavailable'} · enrolled through {status.hubOrigin}</div> : null}
            {(error || status?.error) ? <div className="help" style={{ color: 'var(--destructive)' }}>{error || status?.error}</div> : null}
          </div>
          <div className="ss-brain-actions">
            {status?.hubBrowserOrigin ? <button className="ss-btn" type="button" disabled={busy} onClick={() => void openHub()}><Icon name="globe" size={12} />Open Hub</button> : null}
            {status?.running || status?.enabled
              ? <button className="ss-btn danger" type="button" disabled={busy} onClick={() => void stop()}>{busy ? 'stopping…' : 'Stop Brain'}</button>
              : <button className="ss-btn primary" type="button" disabled={busy || !status?.enrolled} onClick={() => void enable()}>{busy ? 'starting…' : 'Enable'}</button>}
          </div>
        </div>
      </div>
    </section>
  )
}

function HubMachinesSection() {
  const client = getCrewCodeClient()
  const currentMachineId = new URLSearchParams(window.location.search).get('machine')
  const [machines, setMachines] = useState<HubMachineSummary[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    if (!client.hubMachinesList) return
    try {
      const result = await client.hubMachinesList()
      setMachines(result.machines)
      setError('')
    } catch (cause) {
      setError((cause as Error).message)
    }
  }, [client])

  useEffect(() => { void refresh() }, [refresh])

  const setEnabled = async (machine: HubMachineSummary, enabled: boolean) => {
    if (!client.hubMachineSetEnabled) return
    if (!enabled && !window.confirm(`Disable ${machine.name}? Its Hub relay and connected browser sessions will be disconnected until you enable it again.`)) return
    setBusyId(machine.id)
    setError('')
    try {
      await client.hubMachineSetEnabled(machine.id, enabled)
      await refresh()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section id="hub-machines" className="ss-section">
      <div className="ss-section-h">
        <h2>Hub Machines</h2>
        <span className="desc">enrolled machine access</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-row" data-q="hub machines enrolled enable disable remote access">
          <div>
            <div className="label">Enrolled machines</div>
            <div className="help">Disabling suspends the machine credential and disconnects its Hub relay. It does not delete the enrollment, local files, or Brain data.</div>
            {error ? <div className="help" style={{ color: 'var(--destructive)' }}>{error}</div> : null}
          </div>
          <button className="ss-btn" type="button" disabled={busyId !== null} onClick={() => void refresh()}>
            <Icon name="refresh" size={12} />Refresh
          </button>
        </div>
        {machines === null ? (
          <div className="ss-row"><div className="help">Loading enrolled machines…</div></div>
        ) : machines.length === 0 ? (
          <div className="ss-row"><div className="help">No machines are enrolled with this Hub.</div></div>
        ) : machines.map(machine => {
          const disabled = machine.status === 'disabled'
          const revoked = machine.status === 'revoked'
          const lastSeen = machine.lastSeenAt === null ? 'never seen' : new Date(machine.lastSeenAt).toLocaleString()
          return (
            <div className="ss-row ss-hub-machine" data-q="hub machine online offline disabled revoked" key={machine.id}>
              <div>
                <div className="label">{machine.name}{machine.id === currentMachineId ? ' · current' : ''}</div>
                <div className="help mono">{machine.status} · {machine.platform || 'platform unknown'}{machine.version ? ` · ${machine.version}` : ''}</div>
                <div className="help">Last seen {lastSeen}</div>
              </div>
              {revoked ? (
                <span className="ss-pill">revoked</span>
              ) : (
                <button
                  className={`ss-btn${disabled ? ' primary' : ' danger'}`}
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void setEnabled(machine, disabled)}
                >
                  {busyId === machine.id ? (disabled ? 'enabling…' : 'disabling…') : (disabled ? 'Enable' : 'Disable')}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

/* ---------- Section: Mode prompts ---------- */

const MODE_PROMPT_OPTIONS: SegOption<DefaultMode>[] = [
  { value: 'ask', label: 'Ask' },
  { value: 'plan', label: 'Plan' },
  { value: 'build', label: 'Build' },
  { value: 'full', label: 'Full Access' },
]

function ModePromptsSection({ state, set }: { state: SettingsState; set: SetSetting }) {
  const [activeMode, setActiveMode] = useState<DefaultMode>('build')
  const prompt = state.modePrompts[activeMode]
  const isDefault = prompt === DEFAULT_MODE_PROMPTS[activeMode]

  const updatePrompt = (value: string) => {
    set('modePrompts', { ...state.modePrompts, [activeMode]: value })
  }

  const restoreDefault = () => {
    if (isDefault) return
    if (!window.confirm(`Restore CrewCode's default ${activeMode === 'full' ? 'Full Access' : activeMode} prompt?`)) return
    updatePrompt(DEFAULT_MODE_PROMPTS[activeMode])
  }

  return (
    <section id="mode-prompts" className="ss-section">
      <div className="ss-section-h">
        <h2>Mode prompts</h2>
        <span className="desc">session-start agent guidance</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-mode-prompt-editor" data-q="custom edit ask plan build full access system prompt reset restore default">
          <div className="ss-mode-prompt-toolbar">
            <Seg<DefaultMode> value={activeMode} options={MODE_PROMPT_OPTIONS} onChange={setActiveMode} />
            <button className="ss-btn" type="button" disabled={isDefault} onClick={restoreDefault}>
              restore default
            </button>
          </div>
          <textarea
            value={prompt}
            onChange={event => updatePrompt(event.target.value)}
            aria-label={`${activeMode} mode prompt`}
            spellCheck={false}
          />
          <div className="help">Edit the shared defaults here, then enable or disable prompt injection per new Solo Chat from its header. CrewCode adds spacing before the user message; blank text sends no prompt for this mode.</div>
        </div>
      </div>
    </section>
  )
}

/* ---------- Section: Updates ---------- */

const UPDATE_POLICY_HELP: Record<UpdatePolicy, string> = {
  manual:    'Check, download, and install all by hand.',
  download:  'Fetch updates in the background, but stay running until you click restart.',
  automatic: 'Fetch updates and install them on next quit.',
}

function UpdatesSection({ state, set }: { state: SettingsState; set: SetSetting }) {
  const [phase, setPhase]   = useState<'idle' | 'checking' | 'not-available' | 'available' | 'downloading' | 'downloaded' | 'error' | 'unconfigured'>('idle')
  const [version, setVersion] = useState<string | null>(null)
  const [percent, setPercent] = useState<number>(0)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // null until a check actually completes — seeding a fake timestamp made the UI
  // claim "last checked 4 min ago" before anything had ever run.
  const [lastChecked, setLastChecked] = useState<number | null>(null)
  const [build, setBuild] = useState<AppBuildInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI?.appBuildInfo?.()
      .then(info => { if (!cancelled && info) setBuild(info) })
      .catch(() => { /* falls back to the unknown-build label */ })
    return () => { cancelled = true }
  }, [])

  // Settings live in renderer localStorage, so main only learns the user's
  // channel/auto-download preference by being told. Re-push on every change.
  useEffect(() => {
    void window.electronAPI?.updaterConfigure?.({
      channel: state.channel,
      ...updatePolicyToConfig(state.updatePolicy),
    })
  }, [state.channel, state.updatePolicy])

  useEffect(() => {
    const off = window.electronAPI?.onUpdaterEvent((event: UpdaterEvent) => {
      if (event.type === 'checking')      setPhase('checking')
      else if (event.type === 'available')      { setPhase('available');     setVersion(event.version ?? null) }
      else if (event.type === 'not-available')  { setPhase('not-available'); setLastChecked(Date.now()) }
      else if (event.type === 'progress')       { setPhase('downloading');   setPercent(event.percent ?? 0) }
      else if (event.type === 'downloaded')     { setPhase('downloaded');    setVersion(event.version ?? null) }
      else if (event.type === 'error')          { setPhase('error');         setErrorMsg(event.message ?? 'updater error') }
      else if (event.type === 'unconfigured')   { setPhase('unconfigured');  setErrorMsg(event.message ?? null) }
    })
    return () => off?.()
  }, [])

  const onCheck = async () => {
    setErrorMsg(null)
    setPhase('checking')
    const r = await window.electronAPI?.updaterCheck()
    if (!r?.ok && r?.error === 'dev build') {
      // 'unconfigured' event already fired via broadcast.
    } else if (r?.ok) {
      setLastChecked(Date.now())
    }
  }

  const onDownload = async () => {
    setPhase('downloading')
    const r = await window.electronAPI?.updaterDownload()
    if (!r?.ok && r?.error) setErrorMsg(r.error)
  }

  const onInstall = async () => {
    await window.electronAPI?.updaterQuitAndInstall()
  }

  const sinceLabel = (() => {
    if (lastChecked === null) return 'never checked'
    const mins = Math.max(0, Math.round((Date.now() - lastChecked) / 60_000))
    return mins < 1 ? 'just now' : `${mins} min ago`
  })()

  const status =
      phase === 'checking'      ? 'checking…'
    : phase === 'available'     ? `update available: ${version}`
    : phase === 'downloading'   ? `downloading… ${percent}%`
    : phase === 'downloaded'    ? `update ready: ${version} · restart to install`
    : phase === 'error'         ? (errorMsg ?? 'updater error')
    : phase === 'unconfigured'  ? (errorMsg ?? 'no updater configured')
    : lastChecked === null      ? 'never checked'
    : `up to date · last checked ${sinceLabel}`

  return (
    <section id="updates" className="ss-section">
      <div className="ss-section-h">
        <h2>Updates</h2>
        <span className="desc">release channel &amp; auto-update behavior</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-update" data-q="updates version build">
          <div className="ss-update-icon"><Icon name="download" size={16} /></div>
          <div className="ss-update-text">
            <div className="t">CrewCode {build?.version ?? '—'} <span style={{ fontFamily: 'var(--font-family-mono)', fontWeight: 400, fontSize: 11, color: 'var(--muted-foreground)' }}>build {build?.buildHash ?? 'dev'} · {state.channel}</span></div>
            <div className="s">{status}</div>
          </div>
          {phase === 'available'  && <button className="ss-btn primary" onClick={onDownload}><Icon name="download" size={12} />download {version}</button>}
          {phase === 'downloaded' && <button className="ss-btn primary" onClick={onInstall}><Icon name="refresh" size={12} />restart to install</button>}
          {phase !== 'available' && phase !== 'downloaded' && (
            <button className="ss-btn" onClick={onCheck} disabled={phase === 'checking' || phase === 'downloading'}>
              <Icon name="refresh" size={12} />check for updates
            </button>
          )}
        </div>
        <div className="ss-row" data-q="release channel beta stable">
          <div>
            <div className="label">Release channel</div>
            <div className="help">Stable installs tagged releases only. Nightly also accepts pre-releases — newer, less tested.</div>
          </div>
          <Seg<Channel> value={state.channel} options={['stable','nightly']} onChange={v => set('channel', v)} />
        </div>
        <div className="ss-row" data-q="auto update automatic download install manual">
          <div>
            <div className="label">Automatic updates</div>
            <div className="help">{UPDATE_POLICY_HELP[state.updatePolicy]}</div>
          </div>
          <Seg<UpdatePolicy>
            value={state.updatePolicy}
            options={[
              { value: 'manual',    label: 'manual' },
              { value: 'download',  label: 'download only' },
              { value: 'automatic', label: 'automatic' },
            ]}
            onChange={v => set('updatePolicy', v)}
          />
        </div>
      </div>
    </section>
  )
}

/* ---------- Section: Appearance ---------- */

interface ThemeDef {
  id: ColorTheme; name: string; bg: string; fg: string; kw: string; str: string; cm: string; accent: string
}

const THEMES: ThemeDef[] = [
  { id: 'carbon',     name: 'Carbon Fiber',    bg: '#0f120f', fg: '#fafafa', kw: '#7dd3a8', str: '#fcd452', cm: '#5a625a', accent: '#285a48' },
  { id: 'midnight',   name: 'Midnight',        bg: '#0a0e1a', fg: '#e6e8ed', kw: '#7aa2f7', str: '#9ece6a', cm: '#565f89', accent: '#7aa2f7' },
  { id: 'graphite',   name: 'Graphite',        bg: '#1a1a1a', fg: '#e5e5e5', kw: '#c084fc', str: '#86efac', cm: '#737373', accent: '#a78bfa' },
  { id: 'solar-dark', name: 'Solarized Dark',  bg: '#002b36', fg: '#93a1a1', kw: '#268bd2', str: '#2aa198', cm: '#586e75', accent: '#268bd2' },
  { id: 'paper',      name: 'Paper',           bg: '#fafaf7', fg: '#2a2a2a', kw: '#9333ea', str: '#16a34a', cm: '#a3a3a3', accent: '#285a48' },
  { id: 'tomorrow',   name: 'Tomorrow Night',  bg: '#1d1f21', fg: '#c5c8c6', kw: '#b294bb', str: '#b5bd68', cm: '#969896', accent: '#cc6666' },
]

function AppearanceSection({ state, set }: { state: SettingsState; set: SetSetting }) {
  return (
    <section id="appearance" className="ss-section">
      <div className="ss-section-h">
        <h2>Appearance</h2>
        <span className="desc">theme &amp; color</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-row" data-q="app theme dark light system">
          <div>
            <div className="label">App theme</div>
            <div className="help">Affects all CrewCode chrome. Follows OS when set to system.</div>
          </div>
          <Seg<AppTheme>
            value={state.appTheme}
            options={[
              { value: 'system', label: 'system', icon: 'monitor' },
              { value: 'dark',   label: 'dark',   icon: 'moon'    },
              { value: 'light',  label: 'light',  icon: 'sun'     },
            ]}
            onChange={v => set('appTheme', v)}
          />
        </div>
        <div className="ss-row vertical" data-q="color theme syntax editor terminal">
          <div>
            <div className="label">Color theme</div>
            <div className="help">Applies to terminals, editors, and chat code blocks.</div>
          </div>
          <div className="ss-themes">
            {THEMES.map(th => (
              <div key={th.id} className={'ss-theme' + (state.theme === th.id ? ' on' : '')} onClick={() => set('theme', th.id)}>
                <div className="preview" style={{ background: th.bg, color: th.fg }}>
                  <span style={{ color: th.cm }}>{'// session — claude code'}</span>{'\n'}
                  <span style={{ color: th.kw }}>const</span> <span style={{ color: th.fg }}>greeting</span> ={' '}
                  <span style={{ color: th.str }}>"hello, crew"</span>;{'\n'}
                  <span style={{ color: th.kw }}>function</span> <span style={{ color: th.accent }}>run</span>(){' '}
                  <span style={{ color: th.fg }}>{`{`}</span>{'\n'}
                  {'  '}<span style={{ color: th.fg }}>return</span> <span style={{ color: th.str }}>"aura"</span>;{'\n'}
                  <span style={{ color: th.fg }}>{`}`}</span>
                </div>
                <div className="meta">
                  <span className="name">{th.name}</span>
                  <span className="check">{state.theme === th.id ? <Icon name="check" size={10} /> : null}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

/* ---------- Section: Typography ---------- */

// All families are bundled locally via @fontsource (see styles/fonts.ts), so
// they render on every platform, offline. SF Mono and Monaco were removed —
// they are Apple-proprietary macOS system fonts that cannot be bundled or
// rendered on Linux/Windows. Inter is sans, included for a non-mono UI font.
const FAMILIES = [
  'JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Roboto Mono', 'Source Code Pro',
  'Cascadia Code', 'Inter',
]

// Family options for the override pickers. "Inherit" maps to '' (empty
// string), which resolveEditorFont/resolveTerminalFont treats as "use the
// global mono family above".
const FAMILY_OPTIONS_WITH_INHERIT = ['Inherit', ...FAMILIES]

function TypographySection({ state, set }: { state: SettingsState; set: SetSetting }) {
  const onPickFamily = (key: 'editorFontFamily' | 'terminalFontFamily') => (v: string) => {
    set(key, v === 'Inherit' ? '' : v)
  }
  const familyLabel = (v: string) => (v === '' ? 'Inherit' : v)

  return (
    <section id="typography" className="ss-section">
      <div className="ss-section-h">
        <h2>Typography</h2>
        <span className="desc">global mono · code editor · terminal</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-row" data-q="font family typeface">
          <div>
            <div className="label">Font family</div>
            <div className="help">Used in terminals, editors, and `code chips`. UI labels stay Inter.</div>
          </div>
          <Select value={state.fontFamily} options={FAMILIES} onChange={v => set('fontFamily', v)} />
        </div>
        <div className="ss-row" data-q="font size">
          <div>
            <div className="label">Font size</div>
            <div className="help">Base size for monospace surfaces.</div>
          </div>
          <Slider value={state.fontSize} min={10} max={20} step={0.5} unit="px" onChange={v => set('fontSize', v)} />
        </div>
        <div className="ss-row" data-q="font weight bold regular">
          <div>
            <div className="label">Font weight</div>
            <div className="help">Resting weight; bold tokens still apply.</div>
          </div>
          <Seg<string>
            value={String(state.fontWeight)}
            options={['300','400','500','600']}
            onChange={v => set('fontWeight', Number(v) as 300|400|500|600)}
          />
        </div>
        <div className="ss-row" data-q="line height leading">
          <div>
            <div className="label">Line height</div>
            <div className="help">Vertical rhythm in code panes.</div>
          </div>
          <Slider value={state.lineHeight} min={1.1} max={2} step={0.05} unit="" onChange={v => set('lineHeight', Math.round(v * 100) / 100)} />
        </div>
        <div className="ss-row" data-q="font ligatures fira code">
          <div>
            <div className="label">Font ligatures</div>
            <div className="help">Renders <span className="kbd">{'!='}</span>, <span className="kbd">{'=>'}</span>, <span className="kbd">{'>='}</span> as single glyphs when supported by the font.</div>
          </div>
          <Toggle value={state.ligatures} onChange={v => set('ligatures', v)} />
        </div>
        <div className="ss-row vertical">
          <div>
            <div className="label" style={{ marginBottom: 8 }}>Preview</div>
          </div>
          <pre
            className="ss-type-preview"
            style={{
              fontFamily: state.fontFamily + ', ui-monospace, monospace',
              fontSize: state.fontSize + 'px',
              fontWeight: state.fontWeight,
              lineHeight: state.lineHeight,
              fontFeatureSettings: state.ligatures ? '"liga", "calt"' : '"liga" 0, "calt" 0',
              fontVariantLigatures: state.ligatures ? 'normal' : 'none',
              margin: 0,
            }}
          >
<span className="cm">{`// crewcode — session bootstrap`}</span>{'\n'}
<span className="kw">async function</span> <span className="fn">spawnAgent</span>(name) {'{'}{'\n'}
{'  '}<span className="kw">const</span> shell = <span className="kw">await</span> open(<span className="str">"/usr/bin/bash"</span>);{'\n'}
{'  '}<span className="kw">return</span> shell.run(`whoami && echo ${'${'}name{'}'}`);{'\n'}
{'}'}{'\n'}
<span className="cm">{`// arrows render as ligatures when enabled  =>  !=  >=`}</span>{'\n'}
spawnAgent(<span className="str">"claude"</span>).then(r =&gt; console.log(r));
          </pre>
        </div>
      </div>

      {/* ── Code Editor overrides ───────────────────────────────────────── */}
      <div className="ss-section-h" style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 13 }}>Code Editor</h2>
        <span className="desc">override the global mono settings for the file editor only</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-row" data-q="editor font family code">
          <div>
            <div className="label">Editor font</div>
            <div className="help">Inherit uses the global font above.</div>
          </div>
          <Select
            value={familyLabel(state.editorFontFamily)}
            options={FAMILY_OPTIONS_WITH_INHERIT}
            onChange={onPickFamily('editorFontFamily')}
          />
        </div>
        <div className="ss-row" data-q="editor font size code">
          <div>
            <div className="label">Editor size</div>
            <div className="help">0 = inherit. Slider sets an explicit override.</div>
          </div>
          <Slider
            value={state.editorFontSize > 0 ? state.editorFontSize : state.fontSize}
            min={10} max={22} step={0.5} unit="px"
            onChange={v => set('editorFontSize', v)}
          />
        </div>
        <div className="ss-row" data-q="editor line height leading">
          <div>
            <div className="label">Editor line height</div>
            <div className="help">Affects only the file editor.</div>
          </div>
          <Slider
            value={state.editorLineHeight > 0 ? state.editorLineHeight : state.lineHeight}
            min={1.1} max={2} step={0.05} unit=""
            onChange={v => set('editorLineHeight', Math.round(v * 100) / 100)}
          />
        </div>
        {(state.editorFontFamily || state.editorFontSize > 0 || state.editorLineHeight > 0) && (
          <div className="ss-row" data-q="editor reset override">
            <div>
              <div className="label">Reset editor overrides</div>
              <div className="help">Revert to the global mono settings above.</div>
            </div>
            <button
              className="ss-toggle"
              style={{ width: 'auto', padding: '4px 10px', fontFamily: 'var(--font-family-mono)', fontSize: 11 }}
              onClick={() => {
                set('editorFontFamily', '')
                set('editorFontSize', 0)
                set('editorLineHeight', 0)
              }}
            >
              reset
            </button>
          </div>
        )}
      </div>

      {/* ── Terminal overrides ───────────────────────────────────────────── */}
      <div className="ss-section-h" style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 13 }}>Terminal</h2>
        <span className="desc">override the global mono settings for terminal panes only</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-row" data-q="terminal font family pty xterm">
          <div>
            <div className="label">Terminal font</div>
            <div className="help">Inherit uses the global font above.</div>
          </div>
          <Select
            value={familyLabel(state.terminalFontFamily)}
            options={FAMILY_OPTIONS_WITH_INHERIT}
            onChange={onPickFamily('terminalFontFamily')}
          />
        </div>
        <div className="ss-row" data-q="terminal font size pty xterm">
          <div>
            <div className="label">Terminal size</div>
            <div className="help">0 = inherit. Slider sets an explicit override.</div>
          </div>
          <Slider
            value={state.terminalFontSize > 0 ? state.terminalFontSize : state.fontSize}
            min={10} max={22} step={0.5} unit="px"
            onChange={v => set('terminalFontSize', v)}
          />
        </div>
        <div className="ss-row" data-q="terminal line height leading pty">
          <div>
            <div className="label">Terminal line height</div>
            <div className="help">Affects only terminal panes.</div>
          </div>
          <Slider
            value={state.terminalLineHeight > 0 ? state.terminalLineHeight : state.lineHeight}
            min={1.0} max={2} step={0.05} unit=""
            onChange={v => set('terminalLineHeight', Math.round(v * 100) / 100)}
          />
        </div>
        {(state.terminalFontFamily || state.terminalFontSize > 0 || state.terminalLineHeight > 0) && (
          <div className="ss-row" data-q="terminal reset override">
            <div>
              <div className="label">Reset terminal overrides</div>
              <div className="help">Revert to the global mono settings above.</div>
            </div>
            <button
              className="ss-toggle"
              style={{ width: 'auto', padding: '4px 10px', fontFamily: 'var(--font-family-mono)', fontSize: 11 }}
              onClick={() => {
                set('terminalFontFamily', '')
                set('terminalFontSize', 0)
                set('terminalLineHeight', 0)
              }}
            >
              reset
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

/* ---------- Section: Rendering ---------- */

function RenderingSection({ state, set }: { state: SettingsState; set: SetSetting }) {
  return (
    <section id="rendering" className="ss-section">
      <div className="ss-section-h">
        <h2>Rendering</h2>
        <span className="desc">terminal renderer for live panes &amp; new panes</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-row" data-q="gpu acceleration webgl rendering">
          <div>
            <div className="label">GPU Acceleration</div>
            <div className="help">Auto tries WebGL for performance and falls back to the DOM renderer if WebGL fails, matching VS Code.</div>
          </div>
          <Seg<Gpu> value={state.gpu} options={['auto','on','off']} onChange={v => set('gpu', v)} />
        </div>
        <div className="ss-row" data-q="apply to live panes existing">
          <div>
            <div className="label">Apply to live panes</div>
            <div className="help">Re-attach the renderer in already-open terminal panes. May briefly flash.</div>
          </div>
          <Toggle value={state.gpuLive} onChange={v => set('gpuLive', v)} />
        </div>
        <div className="ss-row" data-q="cursor blink rate">
          <div>
            <div className="label">Cursor blink</div>
            <div className="help">Block caret animation in terminals.</div>
          </div>
          <Seg<Cursor> value={state.cursor} options={['off','slow','fast']} onChange={v => set('cursor', v)} />
        </div>
      </div>
    </section>
  )
}

/* ---------- Section: Terminal ---------- */

function TerminalSection({ state, set }: { state: SettingsState; set: SetSetting }) {
  const [detected, setDetected] = useState<{ bash: string | null; zsh: string | null; fish: string | null; defaultShell: string } | null>(null)

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.shellsDetect) return
    let cancelled = false
    api.shellsDetect().then(r => { if (!cancelled) setDetected(r) }).catch(() => { /* main not ready */ })
    return () => { cancelled = true }
  }, [])

  // Disable a shell button if it isn't installed on the host. "auto" and
  // "custom" are always available.
  const isAvailable = (choice: ShellChoice): boolean => {
    if (!detected) return true
    if (choice === 'bash' || choice === 'zsh' || choice === 'fish') return detected[choice] !== null
    return true
  }

  const choices: ShellChoice[] = ['auto', 'bash', 'zsh', 'fish', 'custom']
  const hint = detected
    ? state.defaultShell === 'auto'
      ? `auto → ${detected.defaultShell}`
      : state.defaultShell === 'custom'
        ? (state.customShellPath.trim() || 'set a path below')
        : (detected[state.defaultShell] ?? 'not installed on this machine')
    : 'detecting…'

  return (
    <section id="terminal" className="ss-section">
      <div className="ss-section-h">
        <h2>Terminal</h2>
        <span className="desc">shell used when opening a new terminal pane</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-row" data-q="default shell fish bash zsh login">
          <div>
            <div className="label">Default Shell</div>
            <div className="help">Auto honors your login shell ($SHELL). Fish, bash, and zsh are auto-detected at common install paths.</div>
            <div className="help mono" style={{ marginTop: 4, opacity: 0.7 }}>{hint}</div>
          </div>
          <div className="ss-seg" role="radiogroup">
            {choices.map(c => (
              <button
                key={c}
                className={state.defaultShell === c ? 'on' : ''}
                onClick={() => set('defaultShell', c)}
                disabled={!isAvailable(c)}
                title={!isAvailable(c) ? `${c} not found on this machine` : c}
                role="radio"
                aria-checked={state.defaultShell === c}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        {state.defaultShell === 'custom' && (
          <div className="ss-row" data-q="custom shell path executable">
            <div>
              <div className="label">Custom Shell Path</div>
              <div className="help">Absolute path to the shell executable (e.g. /opt/homebrew/bin/fish).</div>
            </div>
            <input
              className="ss-agent-edit-input mono"
              type="text"
              value={state.customShellPath}
              onChange={e => set('customShellPath', e.target.value)}
              placeholder="/usr/local/bin/fish"
              style={{ minWidth: 240 }}
            />
          </div>
        )}
      </div>
    </section>
  )
}

/* ---------- Section: Agents ---------- */

interface AgentDef {
  id: AgentId; name: string; cls: string; desc: string;
}

const AGENTS: AgentDef[] = [
  { id: 'claude',   name: 'Claude Agent', cls: 'claude',   desc: 'Powered By Claude Code · SDK' },
  { id: 'codex',    name: 'Codex Agent', cls: 'codex',    desc: 'Powered By Codex · App Server' },
  { id: 'opencode', name: 'OpenCode Agent', cls: 'opencode', desc: 'Powered By OpenCode · Open-Source CLI' },
  { id: 'pi', name: 'Pi Agent', cls: 'pi', desc: 'Powered By Pi · Open-Source CLI' },
  { id: 'hermes', name: 'Hermes Agent', cls: 'hermes', desc: 'Powered By Hermes · Open-Source CLI' },
  { id: 'crewcoder', name: 'CrewCoder Agent', cls: 'crewcoder', desc: 'Powered By CrewCoder · ACP' },
  { id: 'grok', name: 'Grok Build', cls: 'grok', desc: 'Powered By Grok Build · ACP' },
  { id: 'ollama', name: 'Ollama Agent', cls: 'ollama', desc: 'Powered By Ollama · Local-Open Source' },
]

interface AgentRow {
  id: AgentId
  meta: AgentDef
  cmd: string                  // default binary name from main (e.g. 'claude')
  defaultPath: string | null   // auto-detected path
  effectivePath: string | null // after override
  override: string             // current override (settings)
}

function ApiKeyRow({ info, onSaved }: { info: AgentInfo; onSaved: () => void }) {
  const [draft,   setDraft]   = useState('')
  const [reveal,  setReveal]  = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [loaded,  setLoaded]  = useState(false)

  // Pull the stored key once so the field is editable (single-user desktop).
  useEffect(() => {
    let alive = true
    window.electronAPI?.agentGetKey(info.id).then(r => {
      if (alive) { setDraft(r?.key ?? ''); setLoaded(true) }
    }).catch(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [info.id])

  const save = async (value: string | null) => {
    setSaving(true)
    await window.electronAPI?.agentSetKey(info.id, value)
    setSaving(false)
    onSaved()
  }

  return (
    <div className="ss-agent" data-q={'api key ' + info.id + ' ' + info.name}>
      <div className="ss-agent-logo openrouter"><Icon name="key" size={14} /></div>
      <div className="ss-agent-info">
        <div className="ss-agent-name">
          <span className="n">{info.name}</span>
          {info.hasKey
            ? <span className="ss-pill"><span className="dot" />key set</span>
            : <span className="ss-pill muted"><span className="dot" />no key</span>}
        </div>
        <div className="ss-agent-edit-row" style={{ marginTop: 6 }}>
          <input
            className="ss-agent-edit-input mono"
            type={reveal ? 'text' : 'password'}
            placeholder={loaded ? 'sk-or-…' : 'loading…'}
            value={draft}
            spellCheck={false}
            autoComplete="off"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save(draft.trim() || null) } }}
          />
          <button className="ss-btn" title={reveal ? 'hide' : 'reveal'} onClick={() => setReveal(r => !r)}>
            <Icon name={reveal ? 'eyeOff' : 'eye'} size={12} />
          </button>
          <button className="ss-btn primary" disabled={saving} onClick={() => save(draft.trim() || null)}>save</button>
          {info.hasKey && (
            <button className="ss-btn danger" disabled={saving} onClick={() => { setDraft(''); save(null) }}>clear</button>
          )}
        </div>
        <div className="ss-agent-edit-meta">
          <span>Stored locally in the app's user-data folder, never synced. Get a key at <span className="kbd">openrouter.ai/keys</span>.</span>
        </div>
      </div>
    </div>
  )
}

function AgentsSection({ state, set }: { state: SettingsState; set: SetSetting }) {
  const [registry, setRegistry] = useState<AgentInfo[]>([])
  const [editing,  setEditing]  = useState<AgentId | null>(null)
  const [draft,    setDraft]    = useState<string>('')

  const reload = useCallback(async () => {
    const r = await window.electronAPI?.agentRegistry()
    if (r) setRegistry(r)
  }, [])
  useEffect(() => { reload() }, [reload])

  // Hosted providers (e.g. OpenRouter) surface an API-key field instead of a
  // launch-path override; driven entirely by the registry's requiresApiKey flag.
  const keyed = registry.filter(r => r.requiresApiKey)

  const rows: AgentRow[] = AGENTS.map(meta => {
    const info = registry.find(r => r.id === meta.id)
    const override = state.agentPathOverrides?.[meta.id] ?? ''
    return {
      id:           meta.id,
      meta,
      cmd:          info?.cmd ?? meta.id,
      defaultPath:  info?.defaultPath ?? null,
      effectivePath: info?.path ?? null,
      override,
    }
  })

  const startEdit = (row: AgentRow) => {
    setEditing(row.id)
    setDraft(row.override || row.effectivePath || row.defaultPath || row.cmd)
  }

  const commitEdit = async (row: AgentRow) => {
    const trimmed = draft.trim()
    const overrides = { ...(state.agentPathOverrides ?? {}) }
    if (trimmed === '' || trimmed === row.defaultPath) {
      delete overrides[row.id]
      await window.electronAPI?.agentSetPath(row.id, null)
    } else {
      overrides[row.id] = trimmed
      await window.electronAPI?.agentSetPath(row.id, trimmed)
    }
    set('agentPathOverrides', overrides)
    setEditing(null)
    reload()
  }

  const resetEdit = async (row: AgentRow) => {
    const overrides = { ...(state.agentPathOverrides ?? {}) }
    delete overrides[row.id]
    set('agentPathOverrides', overrides)
    await window.electronAPI?.agentSetPath(row.id, null)
    setEditing(null)
    reload()
  }

  return (
    <section id="agents" className="ss-section">
      <div className="ss-section-h">
        <h2>Agents</h2>
        <span className="desc">manage agents · set default · override launch command</span>
      </div>
      <div className="ss-card tight">
        {rows.map(row => {
          const a = row.meta
          const isEditing  = editing === row.id
          const isOverride = !!row.override
          return (
            <React.Fragment key={a.id}>
              <div className="ss-agent" data-q={'agent ' + a.id + ' ' + a.name + ' ' + a.desc}>
                <div className={'ss-agent-logo ' + a.cls}>
                {PROVIDER_IMAGES[a.id] ? (
                  <img src={PROVIDER_IMAGES[a.id]} alt={a.id} width={24} height={24} className={providerImageClass(a.id)} style={{ display: 'block' }} />
                ) : (
                  a.name[0]
                )}
              </div>
                <div className="ss-agent-info">
                  <div className="ss-agent-name">
                    <span className="n">{a.name}</span>
                    {state.connections[a.id]
                      ? <span className="ss-pill"><span className="dot" />connected</span>
                      : <span className="ss-pill muted"><span className="dot" />not connected</span>}
                    {isOverride && <span className="ss-pill" title={row.override}><span className="dot" />custom launch</span>}
                  </div>
                  <div className="ss-agent-meta">
                    <span>{a.desc}</span>
                    {state.connections[a.id]}
                    <span>·</span>
                    <span className="kbd" title="effective launch path">
                      {row.effectivePath ?? `${row.cmd} (not found)`}
                    </span>
                  </div>
                </div>
                <button
                  className={'ss-radio' + (state.defaultAgent === a.id ? ' on' : '')}
                  onClick={() => set('defaultAgent', a.id)}
                >
                  <span className="dot" />default
                </button>
                <div className="ss-agent-actions">
                  <button
                    className="ss-btn"
                    onClick={() => isEditing ? setEditing(null) : startEdit(row)}
                    title="override the binary path or name used to launch this agent"
                  >
                    <Icon name="terminal" size={12} />{isEditing ? 'close' : 'launch cmd'}
                  </button>
                  {state.connections[a.id]
                    ? <button className="ss-btn danger" onClick={() => set('connections', { ...state.connections, [a.id]: false })}>disconnect</button>
                    : <button className="ss-btn primary" onClick={() => set('connections', { ...state.connections, [a.id]: true })}>sign in</button>}
                </div>
              </div>
              {isEditing && (
                <div className="ss-agent-edit">
                  <div className="ss-agent-edit-help">
                    Override the binary path or name used to launch <span className="kbd">{a.name}</span>. Accepts a bare command (resolved via <span className="kbd">$PATH</span>) or an absolute path. Leave empty to restore the auto-detected default.
                  </div>
                  <div className="ss-agent-edit-row">
                    <input
                      className="ss-agent-edit-input"
                      autoFocus
                      placeholder={row.defaultPath ?? row.cmd}
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter')   { e.preventDefault(); commitEdit(row) }
                        if (e.key === 'Escape')  { e.preventDefault(); setEditing(null) }
                      }}
                    />
                    <button className="ss-btn primary" onClick={() => commitEdit(row)}>save</button>
                    {isOverride && (
                      <button className="ss-btn" onClick={() => resetEdit(row)}>reset to default</button>
                    )}
                  </div>
                  <div className="ss-agent-edit-meta">
                    <span>default: <span className="kbd">{row.defaultPath ?? `${row.cmd} (not found on PATH)`}</span></span>
                    <span>·</span>
                    <span>active: <span className="kbd">{row.effectivePath ?? '(unresolved)'}</span></span>
                  </div>
                </div>
              )}
            </React.Fragment>
          )
        })}
      </div>

      {keyed.length > 0 && (
        <>
          <div className="ss-section-h" style={{ marginTop: 18 }}>
            <h2>API keys</h2>
            <span className="desc">hosted providers · keys stored locally on this machine</span>
          </div>
          <div className="ss-card tight">
            {keyed.map(info => (
              <ApiKeyRow key={info.id} info={info} onSaved={reload} />
            ))}
          </div>
        </>
      )}

      <div style={{ marginTop: 14 }}>
        <div className="ss-row" data-q="custom command alias slash">
          <div>
            <div className="label">Custom slash-commands</div>
            <div className="help">
              Reusable prompt snippets you trigger in the composer with <span className="kbd">/name</span>.
              Drop one <span className="kbd">.md</span> file per command into <span className="kbd">~/.crewcode/commands</span> —
              the filename is the trigger, the file body is the prompt. Commands are shared across every provider.
            </div>
          </div>
          <button className="ss-btn" onClick={() => window.electronAPI?.commandsOpenDir()}>
            <Icon name="code" size={12} />open ~/.crewcode/commands
          </button>
        </div>
      </div>
    </section>
  )
}

/* ---------- Section: Voice ---------- */

function VoiceKeyField({
  provider,
  availability,
  onAvailability,
}: {
  provider: RemoteVoiceProviderId
  availability: VoiceProviderAvailabilityMap | null
  onAvailability: (value: VoiceProviderAvailabilityMap) => void
}) {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const configured = availability?.[provider].configured ?? false

  const save = async (key: string | null) => {
    setSaving(true)
    setMessage(null)
    const result = await window.electronAPI?.voiceSetProviderKey(provider, key)
    setSaving(false)
    if (!result?.ok) {
      setMessage(result?.error ?? 'Could not save voice key.')
      return
    }
    if (result.availability) onAvailability(result.availability)
    setValue('')
    setMessage(key ? 'Key saved.' : 'Key cleared.')
  }

  return (
    <div className="ss-row" data-q={`${provider} realtime voice api key`}>
      <div>
        <div className="label">{provider === 'openai' ? 'OpenAI Realtime key' : 'xAI Voice key'}</div>
        <div className="help">
          {configured ? 'Configured. Permanent keys remain in the main process.' : 'Not configured. The voice orb stays disabled.'}
          {message ? ` ${message}` : ''}
        </div>
      </div>
      <div className="ss-agent-edit-row">
        <input
          className="ss-agent-edit-input mono"
          type="password"
          value={value}
          placeholder={configured ? 'replace existing key' : 'paste API key'}
          autoComplete="off"
          spellCheck={false}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && value.trim()) {
              event.preventDefault()
              void save(value.trim())
            }
          }}
        />
        <button className="ss-btn primary" type="button" disabled={saving || !value.trim()} onClick={() => void save(value.trim())}>
          save
        </button>
        {configured ? (
          <button className="ss-btn danger" type="button" disabled={saving} onClick={() => void save(null)}>
            clear
          </button>
        ) : null}
      </div>
    </div>
  )
}

function VoiceSection({ state, set }: { state: SettingsState; set: SetSetting }) {
  const [availability, setAvailability] = useState<VoiceProviderAvailabilityMap | null>(null)
  const [localStatus, setLocalStatus] = useState<LocalVoiceServiceStatus | null>(null)
  const [checkingLocal, setCheckingLocal] = useState(false)

  useEffect(() => {
    let active = true
    getCrewCodeClient().voiceProviderAvailability()
      .then(value => { if (active) setAvailability(value) })
      .catch(() => { /* settings remain safely disabled */ })
    return () => { active = false }
  }, [])

  const checkLocal = async (start: boolean) => {
    setCheckingLocal(true)
    const value = start
      ? await getCrewCodeClient().voiceLocalStart({
          pythonPath: state.voiceLocalPythonPath,
          device: state.voiceLocalDevice,
        })
      : await getCrewCodeClient().voiceLocalStatus()
    setLocalStatus(value ?? null)
    setCheckingLocal(false)
  }

  const providers: SegOption<VoiceProviderId>[] = [
    { value: 'off', label: 'Off' },
    { value: 'openai', label: 'GPT' },
    { value: 'xai', label: 'xAI' },
    { value: 'local', label: 'Local' },
    ...(import.meta.env.DEV ? [{ value: 'fake' as const, label: 'Test' }] : []),
  ]

  return (
    <section className="ss-section" id="voice">
      <div className="ss-section-h">
        <h2>Voice</h2>
        <span className="desc">talk to the active coding agent</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-row" data-q="voice provider realtime gpt xai parakeet local">
          <div>
            <div className="label">Voice provider</div>
            <div className="help">Voice coordinates the selected coding agent; it never receives direct filesystem or terminal authority.</div>
          </div>
          <Seg value={state.voiceProvider} options={providers} onChange={value => set('voiceProvider', value)} />
        </div>
        <VoiceKeyField provider="openai" availability={availability} onAvailability={setAvailability} />
        <VoiceKeyField provider="xai" availability={availability} onAvailability={setAvailability} />
        <div className="ss-row" data-q="openai realtime model voice">
          <div>
            <div className="label">GPT voice</div>
            <div className="help">Defaults follow the current Realtime WebRTC integration.</div>
          </div>
          <div className="ss-agent-edit-row">
            <input className="ss-agent-edit-input mono" value={state.voiceOpenAIModel} onChange={event => set('voiceOpenAIModel', event.target.value)} />
            <select className="ss-agent-edit-input" value={state.voiceOpenAIVoice} onChange={event => set('voiceOpenAIVoice', event.target.value)}>
              {['marin', 'cedar', 'coral', 'alloy', 'verse'].map(voice => <option key={voice} value={voice}>{voice}</option>)}
            </select>
          </div>
        </div>
        <div className="ss-row" data-q="xai grok voice model">
          <div>
            <div className="label">xAI voice</div>
            <div className="help">Uses xAI’s OpenAI-compatible realtime event contract.</div>
          </div>
          <div className="ss-agent-edit-row">
            <input className="ss-agent-edit-input mono" value={state.voiceXaiModel} onChange={event => set('voiceXaiModel', event.target.value)} />
            <select className="ss-agent-edit-input" value={state.voiceXaiVoice} onChange={event => set('voiceXaiVoice', event.target.value)}>
              {['eve', 'ara', 'rex', 'sal', 'leo'].map(voice => <option key={voice} value={voice}>{voice}</option>)}
            </select>
          </div>
        </div>
        <div className="ss-row" data-q="local parakeet transcription kokoro text to speech">
          <div>
            <div className="label">Local voice</div>
            <div className="help">
              Parakeet TDT 0.6B v2 + Kokoro-82M run in an authenticated localhost sidecar outside Electron.
              {localStatus ? ` ${localStatus.ready ? 'Service ready.' : localStatus.error ?? 'Service stopped.'}` : ''}
            </div>
          </div>
          <div className="ss-agent-edit-row">
            <input
              className="ss-agent-edit-input mono"
              value={state.voiceLocalPythonPath}
              placeholder={navigator.userAgent.includes('Windows') ? 'python' : 'python3'}
              onChange={event => set('voiceLocalPythonPath', event.target.value)}
              aria-label="Local voice Python executable"
            />
            <select
              className="ss-agent-edit-input"
              value={state.voiceLocalVoice}
              onChange={event => set('voiceLocalVoice', event.target.value)}
              aria-label="Kokoro voice"
            >
              {['am_michael', 'am_fenrir', 'am_puck', 'am_onyx', 'bm_george', 'bm_fable'].map(voice => (
                <option key={voice} value={voice}>{voice}</option>
              ))}
            </select>
            <select
              className="ss-agent-edit-input"
              value={state.voiceLocalDevice}
              onChange={event => set('voiceLocalDevice', event.target.value as LocalVoiceDevice)}
              aria-label="Local voice device"
            >
              <option value="auto">Automatic</option>
              <option value="gpu">GPU</option>
              <option value="cpu">CPU</option>
            </select>
            <button className="ss-btn" type="button" disabled={checkingLocal} onClick={() => void checkLocal(true)}>
              {checkingLocal ? 'starting…' : 'start & check'}
            </button>
          </div>
        </div>
        <div className="ss-row" data-q="local kokoro speech voice speed faster slower playback">
          <div>
            <div className="label">Local speech speed</div>
            <div className="help">Controls Kokoro playback for the voice orb and chat read-aloud actions.</div>
          </div>
          <Slider
            value={state.voiceLocalSpeed}
            min={LOCAL_VOICE_SPEED_MIN}
            max={LOCAL_VOICE_SPEED_MAX}
            step={0.05}
            unit="×"
            commitOnRelease
            onChange={value => set('voiceLocalSpeed', value)}
          />
        </div>
      </div>
    </section>
  )
}

/* ---------- Section: Integrations ---------- */

function IntegrationsSection({ state, set }: { state: SettingsState; set: SetSetting }) {
  const [gh, setGh] = useState<GhStatus | null>(null)
  const [authOpen, setAuthOpen] = useState(false)

  const refreshGh = useCallback(async () => {
    const status = await window.electronAPI?.ghStatus()
    setGh(status ?? null)
    if (status) set('githubConnected', status.loggedIn)
  }, [set])

  useEffect(() => { refreshGh() }, [refreshGh])

  const onLogout = async () => {
    await window.electronAPI?.ghLogout()
    await refreshGh()
  }

  const onAuthSuccess = async () => {
    await refreshGh()
    // Slight delay so the user sees the "authenticated" state before close.
    setTimeout(() => setAuthOpen(false), 800)
  }

  const ghAvailable  = gh?.available ?? true
  const ghVersion    = gh?.available === false ? 'not installed' : 'gh CLI'
  const ghConnLabel  = gh?.loggedIn
    ? `connected${gh.user ? ` as @${gh.user}` : ''}`
    : 'not connected'

  return (
    <section id="integrations" className="ss-section">
      <div className="ss-section-h">
        <h2>Integrations</h2>
        <span className="desc">third-party services CrewCode talks to</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-prov" data-q="github integration gh-cli auth">
          <div className="ss-prov-logo"><Icon name="github" size={18} /></div>
          <div className="ss-agent-info">
            <div className="ss-agent-name">
              <span className="n">GitHub</span>
              <span className="v">{ghVersion}</span>
              {gh?.loggedIn
                ? <span className="ss-pill"><span className="dot" />{ghConnLabel}</span>
                : <span className="ss-pill muted"><span className="dot" />{ghConnLabel}</span>}
            </div>
            <div className="ss-agent-meta">
              <span>browse repos · open PRs · review diffs from the composer</span>
            </div>
          </div>
          <div className="ss-agent-actions">
            {!ghAvailable && <span className="ss-ssh-status">install gh CLI to enable</span>}
            {ghAvailable && gh?.loggedIn && (
              <>
                <button className="ss-btn" onClick={() => setAuthOpen(true)}><Icon name="refresh" size={12} />re-auth</button>
                <button className="ss-btn danger" onClick={onLogout}>disconnect</button>
              </>
            )}
            {ghAvailable && !gh?.loggedIn && (
              <button className="ss-btn primary" onClick={() => setAuthOpen(true)}>sign in</button>
            )}
          </div>
        </div>
      </div>
      {authOpen && <GhAuthModal onClose={() => setAuthOpen(false)} onSuccess={onAuthSuccess} />}
    </section>
  )
}

/* ---------- Section: SSH ---------- */

type SshProbe =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'ok'; latencyMs: number; at: number }
  | { state: 'err'; error: string; at: number }

function SshProbeStatus({ probe }: { probe: SshProbe }) {
  if (probe.state === 'testing') {
    return <span className="ss-pill muted"><span className="dot" />testing…</span>
  }
  if (probe.state === 'ok') {
    return (
      <span className="ss-pill" title={`tested ${new Date(probe.at).toLocaleTimeString()}`}>
        <span className="dot" />reachable · {probe.latencyMs}ms
      </span>
    )
  }
  if (probe.state === 'err') {
    return (
      <span className="ss-pill muted" title={probe.error}>
        <span className="dot" />unreachable
      </span>
    )
  }
  return <span className="ss-ssh-status">last: never</span>
}

function SSHSection({ state, set }: { state: SettingsState; set: SetSetting }) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft]   = useState<SSHConn>({ id: '', host: '', addr: '', key: 'ed25519' })
  const [keysOpen, setKeysOpen] = useState(false)
  const [probes,   setProbes]   = useState<Record<string, SshProbe>>({})

  const testHost = useCallback(async (id: string, target: string) => {
    setProbes(p => ({ ...p, [id]: { state: 'testing' } }))
    const res = await window.electronAPI?.sshTest(target)
    setProbes(p => ({
      ...p,
      [id]: res?.ok
        ? { state: 'ok',  latencyMs: res.latencyMs ?? 0, at: Date.now() }
        : { state: 'err', error: res?.error || 'failed',  at: Date.now() },
    }))
  }, [])

  // Imported hosts from the user's actual ~/.ssh/config. Rendered alongside
  // app-managed connections so the user sees their real environment.
  const [configHosts, setConfigHosts] = useState<{ host: string; addr: string; key: string }[]>([])
  useEffect(() => {
    window.electronAPI?.sshListConfig().then(list => {
      setConfigHosts((list ?? []).map(h => ({
        host: h.user ? `${h.user}@${h.host}` : h.host,
        addr: `${h.hostname ?? h.host}${h.port ? ':' + h.port : ''}`,
        key:  h.identityFile ? h.identityFile.split('/').pop()! : 'agent',
      })))
    })
  }, [])

  const startAdd = () => {
    setDraft({ id: `s${Date.now().toString(36)}`, host: '', addr: '', key: 'ed25519' })
    setAdding(true)
  }
  const commitAdd = () => {
    if (!draft.host.trim() || !draft.addr.trim()) return
    set('sshConns', [...state.sshConns, draft])
    setAdding(false)
  }
  const remove = (id: string) => set('sshConns', state.sshConns.filter(c => c.id !== id))

  const openConfig = () => { window.electronAPI?.sshOpenConfig() }

  return (
    <section id="ssh" className="ss-section">
      <div className="ss-section-h">
        <h2>SSH</h2>
        <span className="desc">manage remote ssh connections</span>
      </div>
      <p className="help" style={{ margin: '0 0 14px', color: 'var(--muted-foreground)', fontFamily: 'var(--font-family-mono)', fontSize: 11 }}>
        Connect to remote servers to browse files, run terminals, and use git. Keys are read from <span className="kbd" style={{ border: '1px solid var(--border)', padding: '1px 5px', borderRadius: 4, color: 'var(--foreground)' }}>~/.ssh</span>.
      </p>
      <div className="ss-card tight">
        {state.sshConns.map(c => {
          const port   = c.addr.match(/:(\d+)$/)?.[1]
          const target = port && port !== '22' ? `${c.host}:${port}` : c.host
          const probe  = probes[c.id] ?? { state: 'idle' as const }
          return (
            <div key={c.id} className="ss-ssh-row" data-q={'ssh ' + c.host + ' ' + c.addr + ' ' + c.key}>
              <div className="ss-ssh-ico"><Icon name="server" size={14} /></div>
              <div>
                <div className="ss-ssh-host">{c.host}</div>
                <div className="ss-ssh-meta">{c.addr} · <Icon name="key" size={10} /> {c.key}</div>
              </div>
              <SshProbeStatus probe={probe} />
              <button
                className="ss-btn"
                style={{ padding: '3px 8px' }}
                onClick={(e) => { e.stopPropagation(); testHost(c.id, target) }}
                disabled={probe.state === 'testing'}
              >
                {probe.state === 'testing' ? 'testing…' : 'test'}
              </button>
              <button
                className="ss-btn danger"
                style={{ padding: '3px 8px' }}
                onClick={(e) => { e.stopPropagation(); remove(c.id) }}
              >
                remove
              </button>
            </div>
          )
        })}
        {configHosts.map((c, i) => {
          const id = `cfg-${i}`
          const port = c.addr.match(/:(\d+)$/)?.[1]
          const target = port && port !== '22' ? `${c.host}:${port}` : c.host
          const probe = probes[id] ?? { state: 'idle' as const }
          return (
            <div key={id} className="ss-ssh-row" data-q={'ssh ' + c.host + ' ' + c.addr + ' ' + c.key}>
              <div className="ss-ssh-ico"><Icon name="server" size={14} /></div>
              <div>
                <div className="ss-ssh-host">{c.host}</div>
                <div className="ss-ssh-meta">{c.addr} · <Icon name="key" size={10} /> {c.key}</div>
              </div>
              {probe.state === 'idle'
                ? <span className="ss-pill muted"><span className="dot" />from ~/.ssh/config</span>
                : <SshProbeStatus probe={probe} />}
              <button
                className="ss-btn"
                style={{ padding: '3px 8px' }}
                onClick={(e) => { e.stopPropagation(); testHost(id, target) }}
                disabled={probe.state === 'testing'}
              >
                {probe.state === 'testing' ? 'testing…' : 'test'}
              </button>
              <span style={{ width: 0 }} />
            </div>
          )
        })}
        {adding && (
          <div className="ss-ssh-form">
            <input
              autoFocus
              placeholder="user@hostname"
              value={draft.host}
              onChange={e => setDraft(d => ({ ...d, host: e.target.value }))}
            />
            <input
              placeholder="host.example.com:22"
              value={draft.addr}
              onChange={e => setDraft(d => ({ ...d, addr: e.target.value }))}
            />
            <select value={draft.key} onChange={e => setDraft(d => ({ ...d, key: e.target.value }))}>
              <option value="ed25519">ed25519</option>
              <option value="rsa-4096">rsa-4096</option>
              <option value="rsa-2048">rsa-2048</option>
              <option value="ecdsa-p256">ecdsa-p256</option>
            </select>
            <button className="ss-btn primary" onClick={commitAdd}>add</button>
            <button className="ss-btn" onClick={() => setAdding(false)}>cancel</button>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {!adding && <button className="ss-btn primary" onClick={startAdd}><Icon name="plus" size={12} />add ssh connection</button>}
        <button className="ss-btn" onClick={() => setKeysOpen(true)}><Icon name="key" size={12} />manage keys</button>
        <button className="ss-btn" onClick={openConfig}><Icon name="code" size={12} />open ~/.ssh/config</button>
      </div>
      {keysOpen && <SshKeysModal onClose={() => setKeysOpen(false)} />}
    </section>
  )
}

/* ---------- Section: MCP ---------- */

// Args are edited as one whitespace-separated line and stored as a string[].
// Quoting isn't supported — MCP launch args are almost always bare tokens
// (`-y`, a package name, a path). Keep it simple; the registry shape still
// carries a real array so quoting can be added later without a migration.
function splitArgs(line: string): string[] {
  return line.trim().length ? line.trim().split(/\s+/) : []
}

interface McpDraft { id: string; name: string; command: string; argsLine: string }

function McpSection({ state, set }: { state: SettingsState; set: SetSetting }) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState<McpDraft>({ id: '', name: '', command: '', argsLine: '' })
  // Servers defined in ~/.crewcode/mcp.json — read-only here, edited in the file.
  const file = useMcpFileServers()
  // Ids the app-managed list shadows, so we don't show a file entry twice.
  const appIds = new Set(state.mcpServers.map(s => s.id))
  const fileOnly = file.servers.filter(s => !appIds.has(s.id))

  const startAdd = () => {
    setDraft({ id: `m${Date.now().toString(36)}`, name: '', command: '', argsLine: '' })
    setAdding(true)
  }
  const commitAdd = () => {
    if (!draft.name.trim() || !draft.command.trim()) return
    const next: McpServerConfig = {
      id: draft.id,
      name: draft.name.trim(),
      command: draft.command.trim(),
      args: splitArgs(draft.argsLine),
      transport: 'stdio',
    }
    set('mcpServers', [...state.mcpServers, next])
    setAdding(false)
  }
  const remove = (id: string) => set('mcpServers', state.mcpServers.filter(s => s.id !== id))

  return (
    <section id="mcp" className="ss-section">
      <div className="ss-section-h">
        <h2>MCP</h2>
        <span className="desc">model context protocol servers · opt-in per session</span>
      </div>
      <p className="help" style={{ margin: '0 0 14px', color: 'var(--muted-foreground)', fontFamily: 'var(--font-family-mono)', fontSize: 11 }}>
        Define MCP servers here, then pick which ones a chat uses from the composer. Nothing is sent to an agent until you opt a session in — even with MCP enabled. The command must exist on the host the agent runs on (local or remote).
      </p>
      <div className="ss-card tight">
        <div className="ss-row" data-q="mcp enable model context protocol">
          <div>
            <div className="label">Enable MCP</div>
            <div className="help">Master switch. When off, the composer MCP picker is hidden and no servers are attached to any session.</div>
          </div>
          <Toggle value={state.mcpEnabled} onChange={v => set('mcpEnabled', v)} />
        </div>
        {state.mcpServers.map(s => (
          <div key={s.id} className="ss-ssh-row" data-q={'mcp ' + s.name + ' ' + s.command + ' ' + (s.args ?? []).join(' ')}>
            <div className="ss-ssh-ico"><Icon name="box" size={14} /></div>
            <div>
              <div className="ss-ssh-host">{s.name}</div>
              <div className="ss-ssh-meta">{s.command}{s.args && s.args.length ? ' ' + s.args.join(' ') : ''}</div>
            </div>
            <span className="ss-pill muted"><span className="dot" />{s.transport ?? 'stdio'}</span>
            <button
              className="ss-btn danger"
              style={{ padding: '3px 8px' }}
              onClick={(e) => { e.stopPropagation(); remove(s.id) }}
            >
              remove
            </button>
          </div>
        ))}
        {adding && (
          <div className="ss-ssh-form">
            <input
              autoFocus
              placeholder="name (e.g. filesystem)"
              value={draft.name}
              onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
            />
            <input
              placeholder="command (e.g. npx)"
              value={draft.command}
              onChange={e => setDraft(d => ({ ...d, command: e.target.value }))}
            />
            <input
              placeholder="args (e.g. -y @modelcontextprotocol/server-filesystem /tmp)"
              value={draft.argsLine}
              onChange={e => setDraft(d => ({ ...d, argsLine: e.target.value }))}
            />
            <button className="ss-btn primary" onClick={commitAdd}>add</button>
            <button className="ss-btn" onClick={() => setAdding(false)}>cancel</button>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {!adding && <button className="ss-btn primary" onClick={startAdd}><Icon name="plus" size={12} />add mcp server</button>}
      </div>

      {/* ── From mcp.json ──────────────────────────────────────────── */}
      <div className="ss-section-h" style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: 13 }}>From mcp.json</h2>
        <span className="desc">servers you add by editing ~/.crewcode/mcp.json</span>
      </div>
      <p className="help" style={{ margin: '0 0 14px', color: 'var(--muted-foreground)', fontFamily: 'var(--font-family-mono)', fontSize: 11 }}>
        Define servers in <span className="kbd" style={{ border: '1px solid var(--border)', padding: '1px 5px', borderRadius: 4, color: 'var(--foreground)' }}>~/.crewcode/mcp.json</span> using the standard <span className="kbd">{'{ "mcpServers": { … } }'}</span> format. CrewCode watches the file and lists them below; they appear in the composer picker just like the ones above.
      </p>
      <div className="ss-card tight">
        {file.errors.length > 0 && (
          <div className="ss-row" data-q="mcp file errors">
            <div>
              <div className="label">Couldn’t read some entries</div>
              <div className="help" style={{ color: '#fca5a5', display: 'grid', gap: 2, marginTop: 4 }}>
                {file.errors.map((err, i) => <span key={i}>{err}</span>)}
              </div>
            </div>
          </div>
        )}
        {fileOnly.length === 0 && file.errors.length === 0 && (
          <div className="ss-row" data-q="mcp file empty">
            <div>
              <div className="label">No servers in mcp.json</div>
              <div className="help">Open the file to add servers by hand — the seeded example shows the format.</div>
            </div>
          </div>
        )}
        {fileOnly.map(s => (
          <div key={s.id} className="ss-ssh-row" data-q={'mcp file ' + s.name + ' ' + s.command + ' ' + (s.args ?? []).join(' ')}>
            <div className="ss-ssh-ico"><Icon name="box" size={14} /></div>
            <div>
              <div className="ss-ssh-host">{s.name}</div>
              <div className="ss-ssh-meta">{s.command}{s.args && s.args.length ? ' ' + s.args.join(' ') : ''}</div>
            </div>
            <span className="ss-pill muted"><span className="dot" />from mcp.json</span>
            <span style={{ width: 0 }} />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="ss-btn primary" onClick={file.openFile}><Icon name="code" size={12} />open mcp.json</button>
        <button className="ss-btn" onClick={file.refresh}><Icon name="refresh" size={12} />refresh</button>
      </div>
    </section>
  )
}

/* ---------- Section: Shortcuts ---------- */

const SHORTCUT_GROUPS = groupedShortcuts()

function captureKeystroke(e: KeyboardEvent): string[] {
  const keys: string[] = []
  if (e.metaKey)  keys.push('⌘')
  if (e.ctrlKey)  keys.push('⌃')
  if (e.altKey)   keys.push('⌥')
  if (e.shiftKey) keys.push('⇧')
  const main = e.key
  if (main && main.length === 1)                keys.push(main.toUpperCase())
  else if (main === 'Enter')                    keys.push('↵')
  else if (main === 'Tab')                      keys.push('⇥')
  else if (main === 'Backspace')                keys.push('⌫')
  else if (!['Meta','Control','Alt','Shift'].includes(main)) keys.push(main)
  return keys
}

function RebindModal({
  label,
  initial,
  onCommit,
  onCancel,
}: {
  label: string
  initial: string[]
  onCommit: (keys: string[]) => void
  onCancel: () => void
}) {
  const [captured, setCaptured] = useState<string[]>(initial)

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCancel(); return }
      e.preventDefault()
      e.stopPropagation()
      const keys = captureKeystroke(e)
      // Ignore pure-modifier events.
      if (keys.every(k => ['⌘','⌃','⌥','⇧'].includes(k))) return
      setCaptured(keys)
    }
    window.addEventListener('keydown', fn, true)
    return () => window.removeEventListener('keydown', fn, true)
  }, [onCancel])

  return (
    <div className="ss-rebind-backdrop" onClick={onCancel}>
      <div className="ss-rebind-modal" onClick={e => e.stopPropagation()}>
        <div className="ss-rebind-h">rebind shortcut</div>
        <div className="ss-rebind-act">{label}</div>
        <div className="ss-rebind-capture">
          {captured.length > 0
            ? captured.map((key, i) => <span key={i} className="kbd">{k(key)}</span>)
            : <span style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-family-mono)', fontSize: 12 }}>press a key combination…</span>}
        </div>
        <div className="ss-rebind-hint">
          <span className="kbd">{k('⌫')}</span> esc to cancel · <span className="kbd">{k('↵')}</span> enter to confirm
        </div>
        <div className="ss-rebind-actions">
          <button className="ss-btn" onClick={onCancel}>cancel</button>
          <button
            className="ss-btn primary"
            disabled={captured.length === 0}
            onClick={() => onCommit(captured)}
          >
            save
          </button>
        </div>
      </div>
    </div>
  )
}

function ShortcutsSection({ state, set }: { state: SettingsState; set: SetSetting }) {
  const [editing, setEditing] = useState<{ group: string; act: string; keys: string[] } | null>(null)

  const keysFor = (group: string, act: string, fallback: string[]) =>
    state.shortcutOverrides[group]?.[act] ?? fallback

  // keys.json is the source of truth — mirror every change back to disk so a
  // manual edit and a UI rebind never disagree.
  const persistToFile = (overrides: SettingsState['shortcutOverrides']) =>
    window.electronAPI?.keybindsWrite(overridesToKeysFile(overrides))

  const commitRebind = (keys: string[]) => {
    if (!editing) return
    const next = { ...state.shortcutOverrides }
    next[editing.group] = { ...(next[editing.group] ?? {}), [editing.act]: keys }
    set('shortcutOverrides', next)
    void persistToFile(next)
    setEditing(null)
  }

  const resetDefaults = () => { set('shortcutOverrides', {}); void persistToFile({}) }

  const openKeysFile = () =>
    window.electronAPI?.keybindsOpen(overridesToKeysFile(state.shortcutOverrides))

  return (
    <section id="shortcuts" className="ss-section">
      <div className="ss-section-h">
        <h2>Shortcuts</h2>
        <span className="desc">keyboard bindings for common actions · click row to rebind</span>
      </div>
      <div className="ss-card tight">
        {SHORTCUT_GROUPS.map((g, gi) => (
          <div key={gi} className="ss-shortcut-group">
            <div className="ss-shortcut-group-h">{g.title}</div>
            {g.items.map((it, i) => {
              const keys = keysFor(g.title, it.act, it.keys)
              return (
                <div
                  key={i}
                  className="ss-shortcut"
                  data-q={'shortcut ' + it.act + ' ' + g.title}
                  onClick={() => setEditing({ group: g.title, act: it.act, keys })}
                >
                  <span className="act">{it.act}</span>
                  <span className="keys">{keys.map((key, j) => <span key={j} className="kbd">{k(key)}</span>)}</span>
                  <button className="rebind" title="Rebind"><Icon name="edit" size={11} /></button>
                </div>
              )
            })}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="ss-btn" onClick={resetDefaults}><Icon name="refresh" size={12} />reset to defaults</button>
        <button className="ss-btn" onClick={openKeysFile}><Icon name="code" size={12} />open ~/.crewcode/keys.json</button>
      </div>
      {editing && (
        <RebindModal
          label={editing.act}
          initial={editing.keys}
          onCommit={commitRebind}
          onCancel={() => setEditing(null)}
        />
      )}
    </section>
  )
}

/* ---------- Section: Editor completion ---------- */

function CompletionApiKeyField({ provider }: { provider: 'opencode-go' | 'openrouter' }) {
  const [value, setValue] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reveal, setReveal] = useState(false)

  useEffect(() => {
    let active = true
    setLoaded(false)
    window.electronAPI?.agentGetKey(provider).then(result => {
      if (active) { setValue(result.key ?? ''); setLoaded(true) }
    }).catch(() => { if (active) setLoaded(true) })
    return () => { active = false }
  }, [provider])

  const save = async () => {
    setSaving(true)
    await window.electronAPI?.agentSetKey(provider, value.trim() || null)
    setSaving(false)
  }

  return (
    <div className="ss-row" data-q="opencode go api key token completion">
      <div>
        <div className="label">{provider === 'opencode-go' ? 'OpenCode Go API key' : 'OpenRouter API key'}</div>
        <div className="help">Stored locally in CrewCode’s protected user-data key file; never saved in settings or sent to the renderer’s localStorage.</div>
      </div>
      <div className="ss-agent-edit-row">
        <input
          className="ss-agent-edit-input mono"
          type={reveal ? 'text' : 'password'}
          value={value}
          placeholder={loaded ? provider === 'opencode-go' ? 'sk_opencode_go_…' : 'sk-or-…' : 'loading…'}
          autoComplete="off"
          spellCheck={false}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void save() } }}
        />
        <button className="ss-btn" type="button" title={reveal ? 'hide' : 'reveal'} onClick={() => setReveal(value => !value)}>
          <Icon name={reveal ? 'eyeOff' : 'eye'} size={12} />
        </button>
        <button className="ss-btn primary" type="button" disabled={saving} onClick={() => void save()}>save</button>
      </div>
    </div>
  )
}

function EditorCompletionSection({ state, set }: { state: SettingsState; set: SetSetting }) {
  const { list: models, loading } = useProviderModels(state.editorCompletionProvider)
  const providerChoices: Array<{ id: CompletionProviderId; label: string }> = [
    { id: 'opencode-go', label: 'OpenCode Go API' },
    { id: 'openrouter', label: 'OpenRouter API' },
    ...AGENTS.map(agent => ({ id: agent.id as CompletionProviderId, label: agent.name })),
  ]
  const selectedModelKnown = !state.editorCompletionModel || models.some(model => model.id === state.editorCompletionModel)

  return (
    <section id="editor-completion" className="ss-section">
      <div className="ss-section-h">
        <h2>Code Editor</h2>
        <span className="desc">inline code suggestions from a dedicated CrewCode agent</span>
      </div>
      <div className="ss-card tight">
        <div className="ss-row" data-q="code editor theme syntax colors palette light dark">
          <div>
            <div className="label">Editor theme</div>
            <div className="help">Changes the code canvas and syntax palette without changing the rest of CrewCode.</div>
          </div>
          <select
            className="ss-agent-edit-input mono"
            value={state.editorTheme}
            onChange={event => set('editorTheme', event.target.value as EditorThemeId)}
          >
            <optgroup label="CrewCode">
              {EDITOR_THEME_OPTIONS.filter(theme => theme.variant === 'app').map(theme => (
                <option key={theme.id} value={theme.id}>{theme.label}</option>
              ))}
            </optgroup>
            <optgroup label="Dark">
              {EDITOR_THEME_OPTIONS.filter(theme => theme.variant === 'dark').map(theme => (
                <option key={theme.id} value={theme.id}>{theme.label}</option>
              ))}
            </optgroup>
            <optgroup label="Light">
              {EDITOR_THEME_OPTIONS.filter(theme => theme.variant === 'light').map(theme => (
                <option key={theme.id} value={theme.id}>{theme.label}</option>
              ))}
            </optgroup>
          </select>
        </div>
        <div className="ss-row" data-q="editor completion autocomplete ghost text inline suggestions ai">
          <div>
            <div className="label">AI inline completions</div>
            <div className="help">Uses a disposable read-only agent turn. Enable only for a provider account you intend to use for completion traffic.</div>
          </div>
          <Toggle value={state.editorCompletionEnabled} onChange={value => set('editorCompletionEnabled', value)} />
        </div>
        <div className="ss-row" data-q="editor completion provider pi claude codex opencode hermes ollama">
          <div>
            <div className="label">Completion provider</div>
            <div className="help">Separate from your chat agent so you can favor a fast, smaller model.</div>
          </div>
          <select
            className="ss-agent-edit-input mono"
            value={state.editorCompletionProvider}
            disabled={!state.editorCompletionEnabled}
            onChange={event => {
              set('editorCompletionProvider', event.target.value as CompletionProviderId)
              set('editorCompletionModel', '')
            }}
          >
            {providerChoices.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
          </select>
        </div>
        {(state.editorCompletionProvider === 'opencode-go' || state.editorCompletionProvider === 'openrouter') && (
          <CompletionApiKeyField provider={state.editorCompletionProvider} />
        )}
        <div className="ss-row" data-q="editor completion model mini fast low latency">
          <div>
            <div className="label">Completion model</div>
            <div className="help">Choose a mini/fast model when available. This is independent from the active chat model.</div>
          </div>
          <select
            className="ss-agent-edit-input mono"
            value={state.editorCompletionModel}
            disabled={!state.editorCompletionEnabled || loading}
            onChange={event => set('editorCompletionModel', event.target.value)}
          >
            {!selectedModelKnown && <option value={state.editorCompletionModel}>{state.editorCompletionModel}</option>}
            {(models.length ? models : [{ id: '', label: loading ? 'loading models…' : 'default (CLI default)' }]).map(model => (
              <option key={model.id || '__default'} value={model.id}>{model.label}</option>
            ))}
          </select>
        </div>
      </div>
    </section>
  )
}

/* ---------- Sidebar nav data ---------- */

interface NavItem { id: string; label: string; icon: IconName }
interface NavGroup { group: string; items: NavItem[] }

const SECTIONS: NavGroup[] = [
  { group: 'general',      items: [
    { id: 'user',         label: 'User',         icon: 'circle'   },
    { id: 'general',      label: 'General',      icon: 'home'     },
    { id: 'mode-prompts', label: 'Mode Prompts', icon: 'bot'      },
    { id: 'updates',      label: 'Updates',      icon: 'download' },
  ]},
  { group: 'look & feel',  items: [
    { id: 'appearance',   label: 'Appearance',   icon: 'palette'  },
    { id: 'typography',   label: 'Typography',   icon: 'type'     },
    { id: 'rendering',    label: 'Rendering',    icon: 'cpu'      },
    { id: 'terminal',     label: 'Terminal',     icon: 'terminal' },
  ]},
  { group: 'connectivity', items: [
    { id: 'agents',       label: 'Agents',       icon: 'bot'      },
    { id: 'voice',        label: 'Voice',        icon: 'mic'   },
    { id: 'editor-completion', label: 'Code Editor', icon: 'code' },
    { id: 'integrations', label: 'Integrations', icon: 'plug'     },
    { id: 'mcp',          label: 'MCP',          icon: 'box'      },
    { id: 'ssh',          label: 'SSH',          icon: 'server'   },
  ]},
  { group: 'controls',     items: [
    { id: 'shortcuts',    label: 'Shortcuts',    icon: 'keyboard' },
  ]},
]

/* ---------- Root ---------- */

export function SettingsScreen({ activeWorkspace }: { activeWorkspace?: Workspace | null } = {}) {
  const { state, set, savedAt } = useSettings()
  const runtime = getCrewCodeRuntime()
  const webRuntime = runtime.kind === 'web'
  const hubControl = runtime.hubControl === true
  const sections = useMemo(() => webRuntime
    ? SECTIONS.map(group => group.group === 'connectivity'
      ? { ...group, items: [...group.items, ...(hubControl ? [{ id: 'hub-machines', label: 'Hub Machines', icon: 'server' as IconName }] : []), { id: 'brain-authorization', label: 'Brain Access', icon: 'server' as IconName }] }
      : group)
    : SECTIONS.map(group => group.group === 'connectivity'
      ? { ...group, items: [{ id: 'brain-continuity', label: 'Desktop & Web', icon: 'server' as IconName }, ...group.items] }
      : group), [hubControl, webRuntime])

  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  // Mount only the above-the-fold sections on the first frame. The rest fire
  // IPC on mount (agent registry probe, gh status, ssh/mcp config reads) which
  // blocks the first frame; deferring them to after paint makes opening the
  // Settings tab feel instant.
  const [deferRest, setDeferRest] = useState(false)
  useEffect(() => {
    let inner = 0
    const outer = requestAnimationFrame(() => { inner = requestAnimationFrame(() => setDeferRest(true)) })
    return () => { cancelAnimationFrame(outer); cancelAnimationFrame(inner) }
  }, [])

  // Search filter — runs after every render so DOM additions get filtered.
  useEffect(() => {
    const root = detailRef.current
    if (!root) return
    const q = query.trim().toLowerCase()
    const sections = root.querySelectorAll<HTMLElement>('.ss-section')
    sections.forEach(sec => {
      const items = sec.querySelectorAll<HTMLElement>('[data-q]')
      const h2Text = sec.querySelector('h2')?.textContent?.toLowerCase() ?? ''
      let any = false
      if (!q) {
        items.forEach(el => el.classList.remove('hidden'))
        sec.classList.remove('hidden')
        return
      }
      items.forEach(el => {
        const hit = (el.dataset.q ?? '').toLowerCase().includes(q) || h2Text.includes(q)
        el.classList.toggle('hidden', !hit)
        if (hit) any = true
      })
      sec.classList.toggle('hidden', !any && !h2Text.includes(q))
    })
    document.querySelectorAll<HTMLElement>('.ss-nav-item').forEach(btn => {
      const id = btn.dataset.target
      if (!id) return
      const sec = document.getElementById(id)
      if (sec) btn.classList.toggle('hidden', sec.classList.contains('hidden'))
    })
  }, [query, state, deferRest])

  const [active, setActive] = useState('user')
  useEffect(() => {
    const root = detailRef.current
    if (!root) return
    const onScroll = () => {
      const sections = [...root.querySelectorAll<HTMLElement>('.ss-section')].filter(s => !s.classList.contains('hidden'))
      const top = root.scrollTop + 80
      let cur = sections[0]?.id ?? 'user'
      for (const s of sections) {
        if (s.offsetTop <= top) cur = s.id
      }
      setActive(cur)
    }
    root.addEventListener('scroll', onScroll)
    onScroll()
    return () => root.removeEventListener('scroll', onScroll)
  }, [query])

  const scrollTo = (id: string) => {
    const sec = document.getElementById(id)
    const root = detailRef.current
    if (sec && root) root.scrollTo({ top: sec.offsetTop - 12, behavior: 'smooth' })
  }

  // Honor an updater-bar (or other) request to land on a specific section,
  // whether Settings was already open or just mounted.
  useEffect(() => {
    const apply = (id: string) => {
      const run = () => scrollTo(id)
      run()
      requestAnimationFrame(run)
    }
    const pending = takePendingSettingsSection()
    if (pending) apply(pending)
    const onEvent = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      if (typeof id !== 'string' || !id.trim()) return
      takePendingSettingsSection()
      apply(id)
    }
    window.addEventListener(SETTINGS_SECTION_EVENT, onEvent)
    return () => window.removeEventListener(SETTINGS_SECTION_EVENT, onEvent)
  }, [])

  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey
      if (mod && e.key === '/') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
  }, [])

  // "saved · just now" — show fresh label after the persistence effect fires,
  // then fade to a relative timestamp.
  const [savedLabel, setSavedLabel] = useState('just now')
  useEffect(() => {
    setSavedLabel('just now')
    const t = setTimeout(() => setSavedLabel(`${Math.round((Date.now() - savedAt) / 1000)}s ago`), 2000)
    return () => clearTimeout(t)
  }, [savedAt])

  return (
    <div className="settings-shell">
      <aside className="ss-nav">
        <div className="ss-nav-h">
          <span className="t">Settings</span>
          <span className="ver">0.2.1</span>
        </div>
        <div className="ss-search">
          <Icon name="search" size={12} />
          <input
            ref={searchRef}
            placeholder="Search settings…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <span className="kbd">{IS_MAC ? '⌘/' : 'Ctrl+/'}</span>
        </div>
        <nav className="ss-nav-list">
          {sections.map(g => (
            <React.Fragment key={g.group}>
              <div className="sec-label">{g.group}</div>
              {g.items.map(it => (
                <button
                  key={it.id}
                  data-target={it.id}
                  className={'ss-nav-item' + (active === it.id ? ' on' : '')}
                  onClick={() => scrollTo(it.id)}
                >
                  <Icon name={it.icon} size={14} />
                  <span>{it.label}</span>
                </button>
              ))}
            </React.Fragment>
          ))}
        </nav>
        <div className="ss-nav-foot">
          <UserProfileAvatar
            username={state.username}
            iconKind={state.profileIconKind}
            iconValue={state.profileIconValue}
            size={22}
          />
          <span className="ss-nav-user-name">{normalizeUserDisplayName(state.username)}</span>
        </div>
      </aside>

      <div className="ss-detail" ref={detailRef}>
        <div className="ss-detail-inner">
          <div className="ss-detail-h">
            <div>
              <div className="ss-breadcrumb">
                <span>crewcode</span>
                <span className="sep">/</span>
                <span>preferences</span>
                <span className="sep">/</span>
                <span style={{ color: 'var(--foreground)' }}>{active}</span>
              </div>
              <h1 className="ss-h1">Preferences</h1>
            </div>
            <div className="right">
              <span className="ss-saved"><span className="dot" />saved · {savedLabel}</span>
            </div>
          </div>

          <ProfileSection      state={state} set={set} />
          <GeneralSection      state={state} set={set} workspace={activeWorkspace} />
          <ModePromptsSection  state={state} set={set} />
          <UpdatesSection      state={state} set={set} />
          <AppearanceSection   state={state} set={set} />
          <TypographySection   state={state} set={set} />
          {deferRest && (
            <>
              <RenderingSection    state={state} set={set} />
              <TerminalSection     state={state} set={set} />
              <AgentsSection           state={state} set={set} />
              <VoiceSection            state={state} set={set} />
              <EditorCompletionSection state={state} set={set} />
              <IntegrationsSection     state={state} set={set} />
              {hubControl && <HubMachinesSection />}
              {webRuntime && <BrainAuthorizationSection />}
              {!webRuntime && <BrainContinuitySection />}
              <McpSection          state={state} set={set} />
              <SSHSection          state={state} set={set} />
              <ShortcutsSection    state={state} set={set} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Re-export the defaults so callers outside the screen can read the canonical
// initial state without importing the hook directly.
export { DEFAULT_SETTINGS }

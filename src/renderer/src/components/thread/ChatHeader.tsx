import React from 'react'
import { Icon } from '../ui/Icon'
import type { IconName } from '../ui/Icon'
import { StatusPill } from '../ui/StatusPill'
import { useSettings } from '../../hooks/useSettings'
import { useNotifications } from '../../hooks/useNotifications'
import type { GitHubStatus, GitHubRun } from '../../types'
import type { RegisteredPluginChatHeaderItem } from '../../../../shared/plugin-types'
import type { VoiceControlSurface } from '../../../../shared/voice-types'
import { VoiceOrb } from '../voice/VoiceOrb'

type ThreadView = 'chat' | 'code' | 'md'

interface ChatHeaderProps {
  repo:            string
  branch:          string
  path:            string
  view:            ThreadView
  setView:         (v: ThreadView) => void
  github?:         GitHubStatus | null
  dirtyCount?:     number
  worktreeBranch?: string
  isGitRepo?:      boolean
  gitOpen?:        boolean
  onToggleGit?:    () => void
  changesOpen?:    boolean
  onToggleChanges?: () => void
  changesCount?:   number
  onStartCrew?:    () => void
  onOpenCanvas?:   () => void
  onOpenTerminal?: () => void
  onOpenBrowser?:  () => void
  onHandoff?:     () => void
  agentLabel?:     string
  modelLabel?:     string
  voiceControl?:   VoiceControlSurface
  // Per-chat delegation: lets this chat's agent spin up other chat threads.
  // Off by default, and absent entirely on surfaces that don't support it.
  delegationEnabled?: boolean
  onToggleDelegation?: () => void
  // Per-session advisory mode prompt. Locked after the first send because
  // provider context already delivered cannot be revoked retroactively.
  modePromptsEnabled?: boolean
  modePromptsLocked?: boolean
  onToggleModePrompts?: () => void
  pluginChatHeaderItems?: RegisteredPluginChatHeaderItem[]
  onPluginChatHeaderItem?: (target: { pluginId: string; sidebarPanel?: string; tab?: string; command?: string }) => void
}

/** One tool action — rendered as a pill when wide, a menu row when narrow. */
interface HeaderAction {
  key:     string
  icon:    IconName
  label:   string
  title:   string
  onClick?: () => void
  active?: boolean
  badge?:  string | number
  /** Plugin actions sit in their own group, separated from the built-in tools. */
  group:   'plugin' | 'tool'
  disabled?: boolean
}

// Below this header width the tool pills collapse into a single dropdown so a
// narrow chat pane stays clean instead of wrapping the actions onto a new line.
const COLLAPSE_WIDTH = 880

function latestRun(runs: GitHubRun[]): GitHubRun | null {
  if (runs.length === 0) return null
  return runs.reduce((best, r) => r.id > best.id ? r : best, runs[0])
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try { document.execCommand('copy') }
  finally { document.body.removeChild(textarea) }
}

export function ChatHeader({
  repo, branch, path, view, setView,
  github, dirtyCount = 0, worktreeBranch, isGitRepo = true, gitOpen, onToggleGit, changesOpen, onToggleChanges, changesCount, onStartCrew, onOpenCanvas, onOpenTerminal, onOpenBrowser, onHandoff,
  agentLabel, modelLabel, delegationEnabled, onToggleDelegation,
  modePromptsEnabled, modePromptsLocked = false, onToggleModePrompts,
  voiceControl,
  pluginChatHeaderItems = [], onPluginChatHeaderItem,
}: ChatHeaderProps) {
  const { state: settings, set: setSetting } = useSettings()
  const [pathCopied, setPathCopied] = React.useState(false)
  const [collapsed, setCollapsed] = React.useState(() => typeof window !== 'undefined' && window.innerWidth < COLLAPSE_WIDTH)
  const [mobileLayout, setMobileLayout] = React.useState(() => typeof window !== 'undefined' && window.innerWidth <= 768)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const copyResetRef = React.useRef<number | null>(null)
  const headerRef = React.useRef<HTMLDivElement>(null)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const openPRs       = github ? github.prs.filter(p => p.state === 'OPEN').length : 0
  const run           = github ? latestRun(github.runs) : null
  const displayBranch = worktreeBranch ?? branch
  const pathLabel     = isGitRepo ? 'Worktree' : 'Local'
    const { show } = useNotifications()
  const openPullRequests = () => {
    if (!github) return
    window.electronAPI?.openExternal(`https://github.com/${github.owner}/${github.repo}/pulls`)
  }
  const copyPath = React.useCallback(() => {
    const text = path.trim()
    if (!text) return
    void copyText(text).then(() => {
      setPathCopied(true)
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
      copyResetRef.current = window.setTimeout(() => setPathCopied(false), 1200)
    })
  }, [path])

  React.useEffect(() => () => {
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
  }, [])

  // Track header width so the tools can fold into a dropdown when the pane shrinks.
  React.useEffect(() => {
    const el = headerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth
      setCollapsed(w < COLLAPSE_WIDTH)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  React.useEffect(() => {
    const update = () => setMobileLayout(window.innerWidth <= 768)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  // Close the dropdown on outside click / Escape.
  React.useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  // The collapse breakpoint can leave a stale-open menu; close it when we expand.
  React.useEffect(() => { if (!collapsed) setMenuOpen(false) }, [collapsed])

  const actions: HeaderAction[] = [
    ...pluginChatHeaderItems.map((item): HeaderAction => ({
      key:     item.registrationId,
      icon:    (item.icon as IconName) ?? 'plug',
      label:   item.title,
      title:   `${item.title} · ${item.pluginId}`,
      onClick: () => onPluginChatHeaderItem?.(item),
      badge:   item.text,
      group:   'plugin',
    })),
    ...(mobileLayout && onToggleModePrompts ? [{
      key: 'mode-prompt', group: 'tool', icon: 'bot', label: 'Mode prompt',
      title: modePromptsLocked
        ? `Mode prompt ${modePromptsEnabled ? 'was enabled' : 'was disabled'} when this session started`
        : modePromptsEnabled ? 'Turn off the CrewCode mode prompt' : 'Turn on the CrewCode mode prompt',
      onClick: onToggleModePrompts, active: modePromptsEnabled, disabled: modePromptsLocked,
    } as HeaderAction] : []),
    ...(mobileLayout && onToggleDelegation ? [{
      key: 'delegation', group: 'tool', icon: 'crew', label: 'Delegate',
      title: delegationEnabled ? 'Turn agent delegation off' : 'Allow this agent to delegate work',
      onClick: onToggleDelegation, active: delegationEnabled,
    } as HeaderAction] : []),
    {
      key: 'verbose-logs', group: 'tool',
      icon: settings.hideVerboseAgentLogs ? 'eyeOff' : 'eye',
      label: settings.hideVerboseAgentLogs ? 'Replies' : 'Logs',
      title: settings.hideVerboseAgentLogs ? 'Show thinking and tool logs' : 'Hide thinking and tool logs',
      onClick: () => setSetting('hideVerboseAgentLogs', !settings.hideVerboseAgentLogs),
      active: settings.hideVerboseAgentLogs,
    },
    { key: 'canvas',  group: 'tool', icon: 'workbench', label: 'Workbench Mode', title: 'Open Workbench Mode for chats and terminals', onClick: onOpenCanvas },
    ...(!mobileLayout ? [{ key: 'terminal', group: 'tool', icon: 'terminal', label: 'Terminal', title: 'Open a terminal in this worktree', onClick: onOpenTerminal } as HeaderAction] : []),
    { key: 'browser', group: 'tool', icon: 'globe', label: 'Browser', title: 'Open the in-app browser', onClick: onOpenBrowser },
    ...(onHandoff ? [{ key: 'handoff', group: 'tool', icon: 'refresh', label: 'Handoff', title: 'Hand off this context to another chat', onClick: onHandoff } as HeaderAction] : []),
    ...(onStartCrew ? [{ key: 'crew', group: 'tool', icon: 'crew', label: 'Crew', title: 'Start a crew session', onClick: onStartCrew } as HeaderAction] : []),
    ...(!mobileLayout ? [{
      key: 'git', group: 'tool', icon: 'gitBranch', label: 'Git',
      title: gitOpen ? 'Close git sidebar' : 'Open git sidebar',
      onClick: onToggleGit, active: gitOpen,
    } as HeaderAction] : []),
    ...(onToggleChanges ? [{
      key: 'changes', group: 'tool', icon: 'changes', label: 'Changes',
      title: changesOpen ? 'Close changes drawer' : 'Review uncommitted changes',
      onClick: onToggleChanges, active: changesOpen, badge: changesCount || undefined,
    } as HeaderAction] : []),
  ]

  const anyActive = actions.some(a => a.active)
  const totalBadge = actions.reduce((sum, a) => sum + (typeof a.badge === 'number' ? a.badge : 0), 0)
  const pluginActions = actions.filter(a => a.group === 'plugin')

  const handleCopyNoti = () => {
   copyPath()
    show({
      message: 'Copied',
      type: 'success',
      duration: 2000,
    })
  }


  return (
    <div className="thr-h" ref={headerRef}>
      <div className="meta-col">
        <div className="title-row">
          <div className="title">
            {repo}
            <span className="branch">• {displayBranch}</span>
            {worktreeBranch && <span className="wt-badge">worktree</span>}
          </div>
          <div className="pills-row">
            {dirtyCount > 0 && (
              <StatusPill className="dirty-pill">
                Changes: {dirtyCount}
              </StatusPill>
            )}
            {github && openPRs > 0 && (
              <button type="button" className="spill brand spill-btn" onClick={openPullRequests} title="open pull requests on github">
                PR {openPRs}
              </button>
            )}
            {github && github.issues > 0 && (
              <StatusPill>issues {github.issues}</StatusPill>
            )}
            {run && (
              run.conclusion === 'success' ? (
                <StatusPill variant="brand" dot>CI passing</StatusPill>
              ) : run.conclusion === 'failure' ? (
                <span className="spill ci-fail">CI failing</span>
              ) : run.status === 'in_progress' ? (
                <StatusPill>CI running</StatusPill>
              ) : null
            )}
          </div>
        </div>
        <div
          title="Copy path"
          onClick={handleCopyNoti}
          className="path"
        >
          {pathLabel} • {path}
        </div>
      </div>

      <div className="actions">
        <div className="view-seg">
          <button className={view === 'chat' ? 'on' : ''} onClick={() => setView('chat')} title="Chat">
            <Icon name="chat" size={14} />
          </button>
          <button className={view === 'md' ? 'on' : ''} onClick={() => setView('md')} title="Markdown">
            <Icon name="edit" size={14} />
          </button>
        </div>

        {onToggleModePrompts && (
          <button
            type="button"
            className={`delegation-toggle mode-prompt-toggle ${modePromptsEnabled ? 'on' : ''}`}
            title={modePromptsLocked
              ? `Mode prompt ${modePromptsEnabled ? 'was enabled' : 'was disabled'} when this session started`
              : modePromptsEnabled
                ? 'CrewCode mode prompt on — click to use only provider context for this session'
                : 'CrewCode mode prompt off — click to add mode guidance for this session'}
            aria-label="Inject CrewCode mode prompt for this session"
            aria-pressed={!!modePromptsEnabled}
            disabled={modePromptsLocked}
            onClick={onToggleModePrompts}
          >
            <Icon name="bot" size={14} />
            <span>Mode prompt</span>
            <span className="delegation-toggle-track" aria-hidden>
              <span className="delegation-toggle-thumb" />
            </span>
          </button>
        )}

        {onToggleDelegation && (
          <button
            type="button"
            className={`delegation-toggle ${delegationEnabled ? 'on' : ''}`}
            title={delegationEnabled
              ? 'Delegation on — this agent can spin up other chat threads'
              : 'Delegation off — click to let this agent spin up other chat threads'}
            aria-label="Allow this agent to delegate work"
            aria-pressed={!!delegationEnabled}
            onClick={onToggleDelegation}
          >
            <Icon name="crew" size={14} />
            <span>Delegate</span>
            <span className="delegation-toggle-track" aria-hidden>
              <span className="delegation-toggle-thumb" />
            </span>
          </button>
        )}

        {voiceControl ? <VoiceOrb control={voiceControl} placement="header" /> : null}

        {collapsed ? (
          <div className="act-menu-wrap" ref={menuRef}>
            <button
              type="button"
              className={`act-pill mobile-chat-actions-trigger ${menuOpen || anyActive ? 'on' : ''}`}
              title="Worktree actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(o => !o)}
            >
              <Icon name="more" />
              <span className="act-label">Actions</span>
              {totalBadge > 0 ? <span className="act-badge">{totalBadge}</span> : null}
              <Icon name="chevDown" size={12} />
            </button>
            {menuOpen && (
              <div className="tab-menu act-menu" role="menu" aria-label="Worktree actions">
                {actions.map((a, i) => {
                  // Divider where the plugin group meets the built-in tools.
                  const needsDivider = a.group === 'tool' && i > 0 && actions[i - 1].group === 'plugin'
                  return (
                    <React.Fragment key={a.key}>
                      {needsDivider && <div className="tab-menu-section" role="separator">tools</div>}
                      <button
                        type="button"
                        className={`tab-menu-item ${a.active ? 'on' : ''}`}
                        role="menuitem"
                        title={a.title}
                        disabled={a.disabled}
                        onClick={() => { setMenuOpen(false); a.onClick?.() }}
                      >
                        <Icon name={a.icon} size={14} />
                        <span className="act-menu-label">{a.label}</span>
                        {a.badge ? <span className="act-badge">{a.badge}</span> : null}
                      </button>
                    </React.Fragment>
                  )
                })}
              </div>
            )}
          </div>
        ) : (
          <>
            {pluginActions.length > 0 && pluginActions.map(a => (
              <button key={a.key} className="act-pill icon-only" title={a.label} aria-label={a.label} onClick={a.onClick}>
                <Icon name={a.icon} />
                {a.badge ? <span className="act-badge">{a.badge}</span> : null}
              </button>
            ))}

            <span className="actions-sep" aria-hidden />

            {actions.filter(a => a.group === 'tool').map(a => (
              <button
                key={a.key}
                className={`act-pill icon-only ${a.active ? 'on' : ''}`}
                title={a.title}
                aria-label={a.title}
                onClick={a.onClick}
              >
                <Icon name={a.icon} />
                {a.badge ? <span className="act-badge">{a.badge}</span> : null}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

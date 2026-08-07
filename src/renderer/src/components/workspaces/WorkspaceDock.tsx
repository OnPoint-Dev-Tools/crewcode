import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { PROVIDER_IMAGES, PROVIDER_META, providerImageClass } from '../composer/provider-meta'
import type { Workspace, Worktree } from '../../types'
import type { RegisteredPluginStatusItem } from '../../../../shared/plugin-types'

const STATUS_COLOR: Record<string, string> = {
  ready: 'var(--success)', live: 'var(--success)',
  plan: 'var(--warning)', idle: 'var(--muted-foreground)', error: 'var(--destructive)'
}

function ActiveWorkspaceIcon({ workspace }: { workspace: Workspace }) {
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  const icon = workspace.projectIconDataUrl

  if (icon && failedIcon !== icon) {
    return (
      <img
        className="ws-dock-project-icon"
        src={icon}
        alt=""
        onError={() => setFailedIcon(icon)}
      />
    )
  }

  return (
    <span
      className={`ws-dot ${workspace.status === 'live' ? 'pulse' : ''}`}
      style={{ background: STATUS_COLOR[workspace.status] }}
    />
  )
}

// ssh-pool connection states → dock label + color. Mirrors RemoteStatus in
// src/main/remote/ssh-pool.ts.
type RemoteConnStatus = 'connecting' | 'connected' | 'error' | 'closed'
const SSH_LABEL: Record<RemoteConnStatus, string> = {
  connecting: 'connecting', connected: 'active', error: 'error', closed: 'offline',
}
const SSH_COLOR: Record<RemoteConnStatus, string> = {
  connecting: 'var(--warning)', connected: 'var(--success)',
  error: 'var(--destructive)', closed: 'var(--muted-foreground)',
}

function connIdForWorkspace(ws?: Workspace): string | null {
  if (!ws || ws.kind !== 'remote' || !ws.path.startsWith('ssh://')) return null
  const rest = ws.path.slice('ssh://'.length)
  const slash = rest.indexOf('/')
  const authority = slash === -1 ? rest : rest.slice(0, slash)

  let user = ''
  let hostPort = authority
  const at = authority.indexOf('@')
  if (at !== -1) { user = authority.slice(0, at); hostPort = authority.slice(at + 1) }

  let host = hostPort
  let port = 22
  const colon = hostPort.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostPort.slice(colon + 1))) {
    host = hostPort.slice(0, colon)
    port = parseInt(hostPort.slice(colon + 1), 10)
  }
  if (!host) return null
  return `${user}@${host}:${port}`
}

// ── Reusable dock popover ───────────────────────────────────────────────────

interface DockPopoverProps {
  title:    string
  children: React.ReactNode
  open:     boolean
  onClose:  () => void
}

function DockPopover({ title, children, open, onClose }: DockPopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="dock-pop" ref={ref} role="dialog">
      <div className="dock-pop-title">{title}</div>
      {children}
    </div>
  )
}

// ── 5-hour usage limit pill ─────────────────────────────────────────────────

interface HourlyUsageProps {
  /** Percentage of the 5-hour window consumed (0–100). */
  usedPercent?: number
  /** Human-readable reset time, e.g. "2:30 PM" or "Thu". */
  resetDescription?: string | null
}

function HourlyUsagePill({ usedPercent = 0, resetDescription }: HourlyUsageProps) {
  const [open, setOpen] = useState(false)
  const pct = Math.min(100, Math.max(0, usedPercent))
  const remainingPct = Math.max(0, 100 - pct)
  const color = pct > 90 ? 'var(--destructive)' : pct > 70 ? 'var(--warning)' : 'var(--crew-green-bright, #2f9d72)'

  return (
    <div className="ws-dock-item-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span className="ws-dock-item ws-dock-usage">
        <span className="usage-dial" style={{ background: `conic-gradient(${color} ${pct}%, var(--border) 0)` } as React.CSSProperties} />
        <span className="usage-label">{pct.toFixed(0)}% 5h</span>
      </span>
      <DockPopover title="5-hour usage" open={open} onClose={() => setOpen(false)}>
        <div className="dock-pop-headline">
          <span className="dock-pop-used">{pct.toFixed(1)}%</span> used
          <span className="dock-pop-total"> · 100% limit</span>
        </div>
        <div className="dock-pop-bar">
          <div className="dock-pop-bar-fill" style={{ width: `${pct}%`, background: color } as React.CSSProperties} />
        </div>
        <dl className="dock-pop-rows">
          <div className="dock-pop-row">
            <dt>Remaining</dt>
            <dd style={{ color }}>{remainingPct.toFixed(1)}%</dd>
          </div>
          <div className="dock-pop-row">
            <dt>Window</dt>
            <dd>5 hours</dd>
          </div>
          {resetDescription && (
            <div className="dock-pop-row">
              <dt>Resets</dt>
              <dd style={{ color: 'var(--muted-foreground)' }}>{resetDescription}</dd>
            </div>
          )}
          <div className="dock-pop-row">
            <dt>Usage</dt>
            <dd style={{ color, fontWeight: 700 }}>{pct.toFixed(1)}%</dd>
          </div>
        </dl>
      </DockPopover>
    </div>
  )
}

// ── Weekly usage limit pill ──────────────────────────────────────────────────

interface WeeklyUsageProps {
  /** Percentage of the weekly window consumed (0–100). */
  usedPercent?: number
  /** Human-readable reset date, e.g. "Thu" or "May 15". */
  resetDescription?: string | null
}

function WeeklyUsagePill({ usedPercent = 0, resetDescription }: WeeklyUsageProps) {
  const [open, setOpen] = useState(false)
  const pct = Math.min(100, Math.max(0, usedPercent))
  const remainingPct = Math.max(0, 100 - pct)
  const color = pct > 90 ? 'var(--destructive)' : pct > 70 ? 'var(--warning)' : 'var(--crew-green-bright, #2f9d72)'

  return (
    <div className="ws-dock-item-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span className="ws-dock-item ws-dock-usage">
        <Icon name="calendar" size={11} />
        <span className="usage-label">{pct.toFixed(0)}% wk</span>
      </span>
      <DockPopover title="Weekly usage" open={open} onClose={() => setOpen(false)}>
        <div className="dock-pop-headline">
          <span className="dock-pop-used">{pct.toFixed(1)}%</span> used
          <span className="dock-pop-total"> · 100% limit</span>
        </div>
        <div className="dock-pop-bar">
          <div className="dock-pop-bar-fill" style={{ width: `${pct}%`, background: color } as React.CSSProperties} />
        </div>
        <dl className="dock-pop-rows">
          <div className="dock-pop-row">
            <dt>Remaining</dt>
            <dd style={{ color }}>{remainingPct.toFixed(1)}%</dd>
          </div>
          <div className="dock-pop-row">
            <dt>Window</dt>
            <dd>7 days</dd>
          </div>
          {resetDescription && (
            <div className="dock-pop-row">
              <dt>Resets</dt>
              <dd style={{ color: 'var(--muted-foreground)' }}>{resetDescription}</dd>
            </div>
          )}
          <div className="dock-pop-row">
            <dt>Usage</dt>
            <dd style={{ color, fontWeight: 700 }}>{pct.toFixed(1)}%</dd>
          </div>
        </dl>
      </DockPopover>
    </div>
  )
}

// ── Active agent info pill ───────────────────────────────────────────────────
// Derives name + icon from the central provider-meta table so it stays in sync
// with whatever the user set as default in Settings → Agents.

interface AgentInfoProps {
  agentId?:      string
  status?:         'idle' | 'busy' | 'live'
  /** Provider-specific usage percentage (0–100). */
  providerUsed?:   number
  providerLimit?:  number
  /** Human-readable reset time, e.g. "2:30 PM" or "Thu". */
  resetDescription?: string | null
}

function AgentInfoPill({ agentId = 'claude', status = 'idle', providerUsed = 0, providerLimit = 0, resetDescription }: AgentInfoProps) {
  const [open, setOpen] = useState(false)
  const meta = PROVIDER_META[agentId] ?? { name: agentId, icon: 'bot' }
  const agentName = meta.name
  const statusColor = status === 'live' ? 'var(--success)' : status === 'busy' ? 'var(--warning)' : 'var(--muted-foreground)'
  const statusLabel = status === 'live' ? 'active' : status === 'busy' ? 'busy' : 'idle'

  // Provider-specific usage is already passed as a percentage (0–100).
  const providerPct = providerLimit > 0 ? Math.min(100, (providerUsed / providerLimit) * 100) : 0
  const providerColor = providerPct > 90 ? 'var(--destructive)' : providerPct > 70 ? 'var(--warning)' : 'var(--crew-green-bright, #2f9d72)'

  return (
    <div className="ws-dock-item-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span className="ws-dock-item ws-dock-agent">
        {PROVIDER_IMAGES[agentId] ? (
          <img
            src={PROVIDER_IMAGES[agentId]}
            alt={agentId}
            className={`ws-dock-agent-img ${providerImageClass(agentId)}`}
            width={12}
            height={12}
          />
        ) : (
          <Icon name="bot" size={11} />
        )}
        <span className="ws-dock-agent-name">{agentName}</span>
        <span className="ws-dot" style={{ background: statusColor }} />
      </span>
      <DockPopover title="Active agent" open={open} onClose={() => setOpen(false)}>
        <div className="dock-pop-headline">
          <span className="dock-pop-used">{agentName}</span>
        </div>
        <dl className="dock-pop-rows">
          <div className="dock-pop-row">
            <dt>Provider</dt>
            <dd>{agentId}</dd>
          </div>
          <div className="dock-pop-row">
            <dt>Status</dt>
            <dd style={{ color: statusColor, fontWeight: 700 }}>{statusLabel}</dd>
          </div>
        </dl>
        {providerLimit > 0 && (
          <>
            <div className="dock-pop-bar" style={{ marginTop: 10 }}>
              <div className="dock-pop-bar-fill" style={{ width: `${providerPct}%`, background: providerColor } as React.CSSProperties} />
            </div>
            <dl className="dock-pop-rows">
              <div className="dock-pop-row">
                <dt>Usage</dt>
                <dd style={{ color: providerColor }}>{providerPct.toFixed(0)}%</dd>
              </div>
              <div className="dock-pop-row">
                <dt>Remaining</dt>
                <dd>{Math.max(0, 100 - providerPct).toFixed(0)}%</dd>
              </div>
              {resetDescription && (
                <div className="dock-pop-row">
                  <dt>Resets</dt>
                  <dd style={{ color: 'var(--muted-foreground)' }}>{resetDescription}</dd>
                </div>
              )}
            </dl>
          </>
        )}
      </DockPopover>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

interface WorkspaceDockProps {
  open:            boolean
  activeWs?:       Workspace
  onToggle:        () => void
  activeWorktree?: Worktree
  pluginStatusItems?: RegisteredPluginStatusItem[]
  onPluginStatusItem?: (item: RegisteredPluginStatusItem) => void
  /** 5-hour rate-limit usage percentage (0–100). */
  hourlyUsedPercent?: number
  /** Human-readable reset time for the 5-hour window. */
  hourlyResetDescription?: string | null
  /** Weekly rate-limit usage percentage (0–100). */
  weeklyUsedPercent?: number
  /** Human-readable reset date for the weekly window. */
  weeklyResetDescription?: string | null
  /** Active agent info for the dock pill — wired from Settings. */
  activeAgentId?:   string
  activeAgentStatus?: 'idle' | 'busy' | 'live'
  /** Provider-specific usage percentage (0–100). */
  providerUsed?:   number
  /** Provider cap percentage (always 100). */
  providerLimit?:  number
  /** Provider-specific reset description. */
  providerResetDescription?: string | null
  externalDirectoryCount?: number
  onManageExternalDirectories?: () => void
}

export function WorkspaceDock({
  open, activeWs, onToggle, activeWorktree, pluginStatusItems = [], onPluginStatusItem,
  hourlyUsedPercent = 0,
  hourlyResetDescription,
  weeklyUsedPercent = 0,
  weeklyResetDescription,
  activeAgentId = 'claude', activeAgentStatus = 'idle',
  providerUsed = 0, providerLimit = 0,
  providerResetDescription,
  externalDirectoryCount = 0,
  onManageExternalDirectories,
}: WorkspaceDockProps) {
  const sshConnId = connIdForWorkspace(activeWs)
  const [statuses, setStatuses] = useState<Record<string, RemoteConnStatus>>({})

  useEffect(() => {
    return window.electronAPI?.onRemoteStatus(({ connId, status }) => {
      setStatuses(prev => ({ ...prev, [connId]: status as RemoteConnStatus }))
    })
  }, [])

  const sshStatus: RemoteConnStatus | null = sshConnId ? (statuses[sshConnId] ?? 'connected') : null

  return (
    <div className={`ws-dock ${open ? 'open' : ''}`} onClick={onToggle}>
      <span className="ws-dock-chev" style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)' }}>
        <Icon name="chevDown" size={12} />
      </span>
      <Icon name="projects" size={16} />
      <span className="ws-dock-name">Workspaces</span>
      <span className="ws-dock-sep">/</span>
      <span className="ws-dock-active">
        {activeWs ? (
          <>
            <ActiveWorkspaceIcon workspace={activeWs} />
            {activeWs.name}
            {activeWorktree ? (
              <>
                <span className="ws-dock-branch">›</span>
                <span className="ws-dock-wt-branch">{activeWorktree.branch}</span>
              </>
            ) : (
              activeWs.branch && (
                <span className="ws-dock-branch">· {activeWs.branch}</span>
              )
            )}
          </>
        ) : (
          <span className="ws-dock-empty">none — click to add</span>
        )}
      </span>
      <span className="ws-dock-right">
        {pluginStatusItems.map(item => (
          <button
            key={item.registrationId}
            type="button"
            className="ws-dock-item ws-dock-plugin-item"
            title={`${item.title} · ${item.pluginId}`}
            onClick={(event) => { event.stopPropagation(); onPluginStatusItem?.(item) }}
          >
            {item.icon && <Icon name="plug" size={12} />}
            {item.text ?? item.title}
          </button>
        ))}
        {onManageExternalDirectories && (
          <button
            type="button"
            className="ws-dock-item ws-dock-plugin-item"
            title="Manage session-only external directories"
            onClick={(event) => { event.stopPropagation(); onManageExternalDirectories() }}
          >
            <Icon name="projects" size={12} /> external dirs{externalDirectoryCount > 0 ? ` · ${externalDirectoryCount}` : ''}
          </button>
        )}
        {sshStatus && (
          <span className="ws-dock-item ws-dock-ssh" title={`ssh: ${sshConnId}`}>
            <span
              className={`ws-dot ${sshStatus === 'connecting' ? 'pulse' : ''}`}
              style={{ background: SSH_COLOR[sshStatus] }}
            />
            ssh: {SSH_LABEL[sshStatus]}
          </span>
        )}
        <HourlyUsagePill usedPercent={hourlyUsedPercent} resetDescription={hourlyResetDescription} />
        <WeeklyUsagePill usedPercent={weeklyUsedPercent} resetDescription={weeklyResetDescription} />
        <AgentInfoPill
          agentId={activeAgentId}
          status={activeAgentStatus}
          providerUsed={providerUsed}
          providerLimit={providerLimit}
          resetDescription={providerResetDescription}
        />
      </span>
    </div>
  )
}

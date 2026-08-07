import { useState } from 'react'
import { Icon, type IconName } from '../ui/Icon'
import { PROVIDER_IMAGES, providerImageClass } from '../composer/provider-meta'
import { AgentRequestCard } from '../thread/AgentRequestCard'
import type { AgentUserResponse } from '../../types'
import type {
  MCAgent, MCProject, FeedEvent, FeedKind,
  AgentKind, AgentStatus, AgentMode, Filter, Grouping,
} from './missionTypes'

// ── small shared bits ──────────────────────────────────────────────────────

interface AvatarProps { agent: AgentKind; status: AgentStatus; size?: number }
export function AgentAvatar({ agent, status, size = 32 }: AvatarProps) {
  const img = PROVIDER_IMAGES[agent]
  return (
    <span className={`mc-avatar ${agent}`} style={{ width: size, height: size, fontSize: size <= 24 ? 9 : 11 }}>
      {img
        ? <img src={img} alt={agent} className={`mc-avatar-img ${providerImageClass(agent)}`} />
        : (agent === 'codex' ? 'gx' : 'cl')
      }
      <span className={`agent-dot ${status}`} />
    </span>
  )
}

export function StatusPill({ status }: { status: AgentStatus }) {
  return (
    <span className={`mc-pill status-${status}`}>
      <span className={`dot ${status === 'running' ? 'pulse' : ''}`} />
      {status}
    </span>
  )
}

export function ModePill({ mode }: { mode: AgentMode }) {
  return <span className={`mc-pill mode-${mode}`}>{mode}</span>
}

export function MonoPill({ children }: { children: React.ReactNode }) {
  return <span className="mc-pill">{children}</span>
}

export const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
export const fmtCost   = (n: number): string => `$${n.toFixed(2)}`

// ── top stat strip ─────────────────────────────────────────────────────────

export function StatStrip({ agents }: { agents: MCAgent[] }) {
  const count = (s: AgentStatus): number => agents.filter(a => a.status === s).length
  const total = agents.length
  const blocked = count('blocked')
  const running = count('running')
  const idle    = count('idle')
  const done    = count('done')
  const worktrees = new Set(agents.map(a => `${a.projectId}/${a.worktree}`)).size
  const tokens = agents.reduce((s, a) => s + a.tokens, 0)

  return (
    <div className="mc-stats">
      <div className="mc-stat">
        <span className="mc-stat-label">agents</span>
        <span className="mc-stat-val">{total}</span>
      </div>
      <div className={`mc-stat ${blocked ? 'attn' : ''}`}>
        <span className="mc-stat-label"><span className="dot warning" />blocked</span>
        <span className="mc-stat-val">{blocked}</span>
      </div>
      <div className="mc-stat">
        <span className="mc-stat-label"><span className="dot success" />running</span>
        <span className="mc-stat-val">{running}</span>
      </div>
      <div className="mc-stat">
        <span className="mc-stat-label"><span className="dot" />idle</span>
        <span className="mc-stat-val">{idle}</span>
      </div>
      <div className="mc-stat">
        <span className="mc-stat-label"><span className="dot success" />done</span>
        <span className="mc-stat-val">{done}</span>
      </div>
      <div className="mc-stat">
        <span className="mc-stat-label">worktrees</span>
        <span className="mc-stat-val">{worktrees}·<span className="unit">{fmtTokens(tokens)} tokens</span></span>
      </div>
    </div>
  )
}

// ── blocking-question banner (loud) ────────────────────────────────────────

interface BannerProps {
  agents:   MCAgent[]
  projects: MCProject[]
  onJump?:  (mcAgentId: string) => void
}
export function BlockingBanner({ agents, projects, onJump }: BannerProps) {
  const blocked = agents.filter(a => a.status === 'blocked')
  if (blocked.length === 0) return null
  return (
    <div className="mc-banner">
      {blocked.map(a => {
        const proj = projects.find(p => p.id === a.projectId)
        const dest = a.blocking?.destructive
        return (
          <div className="mc-banner-row" key={a.id}>
            <div className={`mc-banner-icon ${dest ? 'dest' : ''}`}>
              <Icon name={dest ? 'cpu' : 'bell'} size={18} />
            </div>
            <div className="mc-banner-body">
              <div className={`mc-banner-kicker ${dest ? 'dest' : ''}`}>
                {dest ? 'tool approval needed' : 'agent is asking'}
                <span className="who">· {a.name} · {proj?.name} · {a.branch}</span>
              </div>
              <div className="mc-banner-text">{a.blocking?.text}</div>
              <div className="mc-choice-row" style={{ marginTop: 8 }}>
                {a.blocking?.choices.map((c, i) => (
                  <button key={c} className={`mc-choice ${i === 0 ? (dest ? 'dest' : 'primary') : ''}`}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="mc-banner-reply">
              <input placeholder="reply inline…" />
              <button
                className="mc-banner-jump"
                title="jump to thread"
                onClick={() => onJump?.(a.id)}
              >
                <Icon name="chevRight" size={13} />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── toolbar ────────────────────────────────────────────────────────────────

const TOOLBAR_FILTERS: { id: Filter; label: string }[] = [
  { id: 'all',     label: 'All' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'running', label: 'Running' },
  { id: 'idle',    label: 'Idle' },
  { id: 'done',    label: 'Done' },
]

const GROUPINGS: { id: Grouping; label: string }[] = [
  { id: 'project',  label: 'project'  },
  { id: 'status',   label: 'status'   },
  { id: 'type',     label: 'agent type' },
  { id: 'worktree', label: 'worktree' },
]

interface ToolbarProps {
  filter:      Filter
  setFilter:   (f: Filter) => void
  grouping:    Grouping
  setGrouping: (g: Grouping) => void
  agents:      MCAgent[]
  onSpawn?:    () => void
}

export function Toolbar({ filter, setFilter, grouping, setGrouping, agents, onSpawn }: ToolbarProps) {
  const counts: Record<string, number> = TOOLBAR_FILTERS.reduce((acc, f) => {
    acc[f.id] = f.id === 'all' ? agents.length : agents.filter(a => a.status === f.id).length
    return acc
  }, {} as Record<string, number>)
  const [openGroup, setOpenGroup] = useState(false)
  return (
    <div className="mc-toolbar">
      <div className="mc-seg">
        {TOOLBAR_FILTERS.map(f => (
          <button key={f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
            {f.label}<span className="ct">{counts[f.id]}</span>
          </button>
        ))}
      </div>
      <div className="grow" />
      <span className="mc-toolbar-label">group by</span>
      <div style={{ position: 'relative' }}>
        <button className="mc-select" onClick={() => setOpenGroup(o => !o)}>
          {GROUPINGS.find(g => g.id === grouping)?.label}
          <Icon name="chevDown" size={11} />
        </button>
        {openGroup && (
          <div className="tab-menu" style={{ left: 'auto', right: 0, top: 'calc(100% + 4px)', minWidth: 160 }}>
            {GROUPINGS.map(g => (
              <button key={g.id} className="tab-menu-item"
                onClick={() => { setGrouping(g.id); setOpenGroup(false) }}>
                {g.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button className="mc-icobtn" title="filter"><Icon name="sliders" size={13} /></button>
      <button className="mc-icobtn" title="refresh"><Icon name="refresh" size={13} /></button>
      <button className="mc-spawn" onClick={() => onSpawn?.()}><Icon name="plus" size={13} />spawn agent</button>
    </div>
  )
}

// ── agent card ─────────────────────────────────────────────────────────────

interface CardProps {
  agent:      MCAgent
  project?:   MCProject
  onOpen?:    (agentId: string) => void
  onPause?:   (agentId: string) => void
  onResume?:  (agentId: string) => void
  onRespondRequest?: (response: AgentUserResponse) => void | Promise<unknown>
}
export function AgentCard({ agent, project, onOpen, onPause, onResume, onRespondRequest }: CardProps) {
  const blocked = agent.status === 'blocked'
  const running = agent.status === 'running'
  const done    = agent.status === 'done'
  const dest    = agent.blocking?.destructive
  const prog    = agent.progress
  const pct     = prog ? (prog.step / prog.of) * 100 : 0

  return (
    <div className={`mc-card ${agent.status}${dest ? ' dest' : ''}`}>
      <div className="mc-card-h">
        <AgentAvatar agent={agent.agent} status={agent.status} />
        <div className="mc-card-titles">
          <div className="mc-card-name">{agent.name}</div>
          <div className="mc-card-sub">
            <Icon name="branch" size={10} />
            <span>{agent.branch}</span>
            <span className="sep">·</span>
            <span>{project?.name}</span>
          </div>
        </div>
        <div className="mc-card-actions">
          <button
            title={running ? 'pause' : 'resume'}
            onClick={() => (running ? onPause?.(agent.id) : onResume?.(agent.id))}
          >
            <Icon name={running ? 'micOff' : 'chevRight'} size={13} />
          </button>
          <button title="open" onClick={() => onOpen?.(agent.id)}>
            <Icon name="more" size={14} />
          </button>
        </div>
      </div>

      <div className="mc-statline">
        <StatusPill status={agent.status} />
        <ModePill mode={agent.mode} />
        <MonoPill>{agent.model}</MonoPill>
        <MonoPill>{agent.lastActivity}</MonoPill>
      </div>

      <div className="mc-card-body">
        {agent.request ? (
          <AgentRequestCard request={agent.request} onRespond={onRespondRequest} compact />
        ) : blocked && agent.blocking && (
          <div className={`mc-block-card ${dest ? 'dest' : ''}`}>
            <span className="glyph">{dest ? '!' : '?'}</span>
            <div className="text">{agent.blocking.text}</div>
          </div>
        )}
        {!blocked && (
          <>
            <div>
              <span className="prompt">$ </span>
              <span className="cmd">{agent.lastLine}</span>
              {running && (
                <span
                  className="caret"
                  style={{
                    display: 'inline-block', width: 7, height: 11,
                    background: 'var(--success)', marginLeft: 3, verticalAlign: 'middle',
                  }}
                />
              )}
            </div>
            {prog && (
              <>
                <div className="progress-row">
                  <span className="label">{prog.current}</span>
                  <span className="step">{prog.step}/{prog.of}</span>
                </div>
                <div className="mc-progress-track">
                  <div
                    className={`mc-progress-bar ${done ? 'done' : (agent.mode === 'Full' ? 'warning' : '')}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="mc-card-f">
        <div className="mc-mini-stats">
          <span><span className="v">{fmtTokens(agent.tokens)}</span> tokens</span>
          <span><span className="v">{fmtCost(agent.cost)}</span></span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <Icon name="box" size={10} style={{ verticalAlign: 'middle', opacity: 0.7, marginRight: 4 }} />
            {agent.worktree}
          </span>
        </div>
        <div className="mc-card-f-actions">
          {blocked && (
            <button className={`mc-btn-sm ${dest ? 'warn' : 'primary'}`} onClick={() => onOpen?.(agent.id)}>
              {dest ? 'review' : 'answer'}
            </button>
          )}
          {!blocked && (
            <button className="mc-btn-sm" onClick={() => onOpen?.(agent.id)}>
              <Icon name="threads" size={11} /> open
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── group header ───────────────────────────────────────────────────────────

interface GroupHeaderProps {
  name:    string
  count:   number
  blocked: number
  icon?:   IconName
  meta?:   string
}
export function GroupHeader({ name, count, blocked, icon = 'projects', meta }: GroupHeaderProps) {
  return (
    <div className="mc-group-h">
      <span className="mc-group-name">
        <Icon name={icon} size={13} />
        {name}
      </span>
      {meta && <span className="mc-group-meta">{meta}</span>}
      <span className="right">
        {blocked > 0 && <span className="mc-tag attn"><span className="dot" />{blocked} blocked</span>}
        <span className="mc-tag">{count} {count === 1 ? 'agent' : 'agents'}</span>
      </span>
    </div>
  )
}

// ── activity feed ──────────────────────────────────────────────────────────

const FEED_ICON: Record<FeedKind, { name: IconName; cls: string }> = {
  block:    { name: 'bell',     cls: 'block'    },
  worktree: { name: 'branch',   cls: 'worktree' },
  unread:   { name: 'threads',  cls: 'unread'   },
  done:     { name: 'sparkle',  cls: 'done'     },
  cmd:      { name: 'terminal', cls: 'cmd'      },
  cost:     { name: 'battery',  cls: 'cost'     },
}

function FeedRow({ event, project }: { event: FeedEvent; project?: MCProject }) {
  const icon = FEED_ICON[event.kind] ?? FEED_ICON.cmd
  return (
    <div className="mc-feed-row">
      <span className={`mc-feed-icon ${icon.cls}`}><Icon name={icon.name} size={11} /></span>
      <div className="mc-feed-body">
        <div className="mc-feed-text">{event.text}</div>
        <div className="mc-feed-meta">{project?.name}</div>
      </div>
      <span className="mc-feed-time">{event.time}</span>
    </div>
  )
}

export function ActivityFeed({ feed, projects }: { feed: FeedEvent[]; projects: MCProject[] }) {
  return (
    <>
      <div className="mc-feed-h">
        <span className="ttl">activity</span>
        <span className="ct">{feed.length}</span>
        <span className="live"><span className="dot" />live</span>
      </div>
      <div className="mc-feed">
        {feed.map(e => (
          <FeedRow key={e.id} event={e} project={projects.find(p => p.id === e.projectId)} />
        ))}
      </div>
    </>
  )
}

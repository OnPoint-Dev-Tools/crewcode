import { useEffect, useMemo, useRef, useState } from 'react'
import type { MCAgent, MCProject, FeedEvent, Filter, Grouping, Group } from './missionTypes'
import type { AgentUserResponse } from '../../types'
import {
  StatStrip, BlockingBanner, Toolbar, AgentCard, GroupHeader, ActivityFeed,
} from './MCComponents'
import { DEFAULT_HUB_TITLE, useHubTitle } from './useHubTitle'
import type { RegisteredPluginMissionWidget } from '../../../../shared/plugin-types'

function groupAgents(agents: MCAgent[], projects: MCProject[], grouping: Grouping): Group[] {
  if (grouping === 'project') {
    return projects
      .map<Group>(p => ({
        id: p.id, name: p.name, meta: p.path, icon: 'projects',
        agents: agents.filter(a => a.projectId === p.id),
      }))
      .filter(g => g.agents.length > 0)
  }
  if (grouping === 'status') {
    const order: { id: MCAgent['status']; name: string; icon: string }[] = [
      { id: 'blocked', name: 'Blocked', icon: 'bell' },
      { id: 'running', name: 'Running', icon: 'cpu' },
      { id: 'idle',    name: 'Idle',    icon: 'monitor' },
      { id: 'done',    name: 'Done',    icon: 'sparkle' },
    ]
    return order
      .map<Group>(g => ({ ...g, agents: agents.filter(a => a.status === g.id) }))
      .filter(g => g.agents.length > 0)
  }
  if (grouping === 'type') {
    const types: MCAgent['agent'][] = ['claude', 'codex']
    return types
      .map<Group>(t => ({
        id: t, name: t === 'claude' ? 'Claude Agent' : 'Codex', icon: 'brain',
        agents: agents.filter(a => a.agent === t),
      }))
      .filter(g => g.agents.length > 0)
  }
  // worktree
  const seen: Record<string, Group> = {}
  const groups: Group[] = []
  agents.forEach(a => {
    const key = `${a.projectId}::${a.worktree}`
    if (!seen[key]) {
      const proj = projects.find(p => p.id === a.projectId)
      const g: Group = {
        id: key, name: a.worktree, icon: 'branch',
        meta: `${proj?.name ?? ''} · ${a.branch}`, agents: [],
      }
      seen[key] = g
      groups.push(g)
    }
    seen[key].agents.push(a)
  })
  return groups
}

interface MissionControlProps {
  agents:    MCAgent[]
  projects:  MCProject[]
  feed:      FeedEvent[]
  onOpenAgent?:   (mcAgentId: string) => void
  onPauseAgent?:  (mcAgentId: string) => void
  onResumeAgent?: (mcAgentId: string) => void
  onSpawnAgent?:  () => void
  onRespondRequest?: (response: AgentUserResponse) => void | Promise<unknown>
  pluginMissionWidgets?: RegisteredPluginMissionWidget[]
  onPluginMissionWidget?: (target: { pluginId: string; sidebarPanel?: string; tab?: string; command?: string }) => void
}

export function MissionControl({
  agents, projects, feed,
  onOpenAgent, onPauseAgent, onResumeAgent, onSpawnAgent, onRespondRequest,
  pluginMissionWidgets = [], onPluginMissionWidget,
}: MissionControlProps) {
  const [filter,   setFilter]   = useState<Filter>('all')
  const [grouping, setGrouping] = useState<Grouping>('project')

  // Hero title — Mission Control's own label, independent of CrewSession.name.
  const { title: hubTitle, setTitle: setHubTitle } = useHubTitle()
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(hubTitle)
  const titleInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingTitle) {
      setDraftTitle(hubTitle)
      // Defer focus so the input mounts before we focus it.
      setTimeout(() => {
        const el = titleInputRef.current
        if (el) { el.focus(); el.select() }
      }, 0)
    }
  }, [editingTitle, hubTitle])

  const commitTitle = (): void => {
    const next = draftTitle.trim() || DEFAULT_HUB_TITLE
    setHubTitle(next)
    setEditingTitle(false)
  }
  const cancelTitle = (): void => {
    setDraftTitle(hubTitle)
    setEditingTitle(false)
  }

  const filtered = useMemo(
    () => (filter === 'all' ? agents : agents.filter(a => a.status === filter)),
    [filter, agents],
  )
  const groups = useMemo(
    () => groupAgents(filtered, projects, grouping),
    [filtered, projects, grouping],
  )

  const worktreeCount = new Set(agents.map(a => `${a.projectId}/${a.worktree}`)).size

  return (
    <div className="mc">
      <div className="mc-main">
        <div className="mc-hero">
          <div className="mc-hero-meta">
            <div className="mc-eyebrow"><span className="dot" />Control Center</div>
            <h1 className="mc-title">
              {editingTitle ? (
                <input
                  ref={titleInputRef}
                  className="mc-title-input"
                  value={draftTitle}
                  maxLength={60}
                  onChange={e => setDraftTitle(e.target.value)}
                  onBlur={commitTitle}
                  onKeyDown={e => {
                    if (e.key === 'Enter')  { e.preventDefault(); commitTitle() }
                    if (e.key === 'Escape') { e.preventDefault(); cancelTitle() }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="mc-title-btn"
                  title="rename"
                  onClick={() => setEditingTitle(true)}
                >
                  {hubTitle || DEFAULT_HUB_TITLE}
                </button>
              )}
              <span className="ct">{agents.length} agents · {projects.length} projects · {worktreeCount} worktrees</span>
            </h1>
          </div>
          <StatStrip agents={agents} />
        </div>

        <BlockingBanner agents={agents} projects={projects} onJump={onOpenAgent} />

        <Toolbar
          filter={filter}     setFilter={setFilter}
          grouping={grouping} setGrouping={setGrouping}
          agents={agents}
          onSpawn={onSpawnAgent}
        />

        <div className="mc-groups">
          {groups.map(g => (
            <div className="mc-group" key={g.id}>
              <GroupHeader
                name={g.name}
                count={g.agents.length}
                blocked={g.agents.filter(a => a.status === 'blocked').length}
                icon={g.icon as any}
                meta={g.meta}
              />
              <div className="mc-grid">
                {g.agents.map(a => (
                  <AgentCard
                    key={a.id} agent={a}
                    project={projects.find(p => p.id === a.projectId)}
                    onOpen={onOpenAgent}
                    onPause={onPauseAgent}
                    onResume={onResumeAgent}
                    onRespondRequest={onRespondRequest}
                  />
                ))}
              </div>
            </div>
          ))}
          {groups.length === 0 && (
            <div style={{
              padding: '64px 24px', textAlign: 'center',
              fontFamily: 'var(--font-family-mono)', fontSize: 12,
              color: 'var(--muted-foreground)',
            }}>
              {agents.length === 0
                ? 'no active agents · start a chat or a crew to populate mission control'
                : 'no agents match this filter'}
            </div>
          )}
        </div>
      </div>

      <div className="mc-side">
        {pluginMissionWidgets.length > 0 && (
          <div style={{ border: '1px solid var(--border)', background: 'var(--card)', padding: 12, marginBottom: 12 }}>
            <div style={{ fontFamily: 'var(--font-family-mono)', fontSize: 11, color: 'var(--muted-foreground)', marginBottom: 8 }}>plugin widgets</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {pluginMissionWidgets.map(widget => (
                <button key={widget.registrationId} className="ss-btn" onClick={() => onPluginMissionWidget?.(widget)} title={`${widget.title} · ${widget.pluginId}`}>
                  {widget.text ?? widget.title}
                </button>
              ))}
            </div>
          </div>
        )}
        <ActivityFeed feed={feed} projects={projects} />
      </div>
    </div>
  )
}

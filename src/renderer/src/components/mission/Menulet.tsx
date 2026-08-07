import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import type { MCAgent, MCProject } from './missionTypes'
import type { AgentUserResponse } from '../../types'
import { AgentAvatar } from './MCComponents'
import { AgentRequestCard } from '../thread/AgentRequestCard'

interface TriggerProps {
  blockedCount: number
  runningCount: number
  onClick:      () => void
}

export function MenuletTrigger({ blockedCount, runningCount, onClick }: TriggerProps) {
  return (
    <button className="menulet-trigger" onClick={onClick} title="CrewCode Mission Control">
      <span className="glyph"><Icon name="monitor" size={12} /></span>
      <span>{runningCount > 0 ? `${runningCount} running` : 'idle'}</span>
      {runningCount > 0 && <span className="live" />}
      {blockedCount > 0 && <span className="count">{blockedCount}</span>}
    </button>
  )
}

interface MenuletBlockingRowProps {
  agent:     MCAgent
  onRespond?: (response: AgentUserResponse) => void | Promise<unknown>
}

function MenuletBlockingRow({ agent, onRespond }: MenuletBlockingRowProps) {
  // Prefer the live, actionable request. Its allow/deny/answer controls resolve
  // the same requestId the chat overlay does, so answering here unblocks the run.
  if (agent.request) {
    return (
      <div className="menulet-block">
        <div className="menulet-block-h">
          agent needs you
          <span className="who">{agent.name} · {agent.branch}</span>
        </div>
        <AgentRequestCard request={agent.request} onRespond={onRespond} compact />
      </div>
    )
  }

  // Transcript-derived blocker with no live request — display only.
  const dest = agent.blocking?.destructive
  return (
    <div className={`menulet-block ${dest ? 'dest' : ''}`}>
      <div className="menulet-block-h">
        {dest ? 'tool approval' : 'agent question'}
        <span className="who">{agent.name} · {agent.branch}</span>
      </div>
      <div className="menulet-block-text">{agent.blocking?.text}</div>
    </div>
  )
}

interface MenuletRowProps {
  agent:     MCAgent
  project?:  MCProject
  onOpen?:   (id: string) => void
  onPause?:  (id: string) => void
  onResume?: (id: string) => void
}

function MenuletRow({ agent, project, onOpen, onPause, onResume }: MenuletRowProps) {
  const running = agent.status === 'running'
  return (
    <div className={`menulet-row ${agent.status}`} onClick={() => onOpen?.(agent.id)}>
      <AgentAvatar agent={agent.agent} status={agent.status} size={26} />
      <div style={{ minWidth: 0 }}>
        <div className="name">{agent.name}</div>
        <div className="sub">{project?.name} · {agent.branch}</div>
      </div>
      <div className="right-wrap">
        <span className="right-meta">
          <span className={`dot ${agent.status}`} />
          {running ? 'live' : agent.lastActivity}
        </span>
        <div className="actions">
          <button
            title={running ? 'pause' : 'resume'}
            onClick={(e) => { e.stopPropagation(); (running ? onPause : onResume)?.(agent.id) }}
          >
            <Icon name={running ? 'micOff' : 'chevRight'} size={11} />
          </button>
          <button
            title="jump to thread"
            onClick={(e) => { e.stopPropagation(); onOpen?.(agent.id) }}
          >
            <Icon name="threads" size={11} />
          </button>
        </div>
      </div>
    </div>
  )
}

interface MenuletSectionProps {
  label:     string
  count:     number
  collapsed: boolean
  onToggle:  () => void
  children:  ReactNode
}

/** Collapsible section header — chevron mirrors the system monitor's group rows. */
function MenuletSection({ label, count, collapsed, onToggle, children }: MenuletSectionProps) {
  return (
    <div className="menulet-group">
      <button className="menulet-sec" aria-expanded={!collapsed} onClick={onToggle}>
        <Icon className="chev" name={collapsed ? 'chevRight' : 'chevDown'} size={12} />
        <span className="lbl">{label}</span>
        <span className="ct">{count}</span>
      </button>
      {!collapsed && children}
    </div>
  )
}

interface MenuletProps {
  open:           boolean
  onClose:        () => void
  agents:         MCAgent[]
  projects:       MCProject[]
  onOpenHub:      () => void
  onOpenAgent?:   (id: string) => void
  onPauseAgent?:  (id: string) => void
  onResumeAgent?: (id: string) => void
  onSpawnAgent?:  () => void
  onRespondRequest?: (response: AgentUserResponse) => void | Promise<unknown>
}

export function Menulet({
  open, onClose, agents, projects, onOpenHub,
  onOpenAgent, onPauseAgent, onResumeAgent, onSpawnAgent, onRespondRequest,
}: MenuletProps) {
  const ref = useRef<HTMLDivElement>(null)
  // Collapsed sections keyed by status. Persists across open/close because the
  // component stays mounted (it just renders null while closed).
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const toggle = (key: string): void => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))

  useEffect(() => {
    if (!open) return
    const fn = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const esc = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    const t = setTimeout(() => document.addEventListener('mousedown', fn), 0)
    document.addEventListener('keydown', esc)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', fn)
      document.removeEventListener('keydown', esc)
    }
  }, [open, onClose])

  if (!open) return null

  // Most-recent first (top → bottom) within each section.
  const byRecency = (a: MCAgent, b: MCAgent) => b.lastActivityMs - a.lastActivityMs
  const blocked = agents.filter(a => a.status === 'blocked')
  const running = agents.filter(a => a.status === 'running')
  const done    = agents.filter(a => a.status === 'done').sort(byRecency)
  const idle    = agents.filter(a => a.status === 'idle').sort(byRecency)

  // 'done' sits above running/idle so finished work is the first thing seen;
  // empty sections render nothing, so this is a no-op when nothing is done.
  // 'blocking' stays pinned above everything — it needs a reply to progress.
  const sections = [
    { key: 'done',    label: 'done',    list: done },
    { key: 'running', label: 'running', list: running },
    { key: 'idle',    label: 'idle',    list: idle },
  ]

  return (
    <div className="menulet" ref={ref}>
      <div className="menulet-h">
        <span className="t">Control Center</span>
        {blocked.length > 0 && <span className="ct">{blocked.length} need you</span>}
        <span className="right">
          <button title="close" onClick={onClose}><Icon name="close" size={12} /></button>
        </span>
      </div>

      <div className="menulet-body">
        {blocked.length > 0 && (
          <MenuletSection
            label="blocking" count={blocked.length}
            collapsed={!!collapsed.blocking} onToggle={() => toggle('blocking')}
          >
            <div className="menulet-blocks">
              {blocked.map(a => (
                <MenuletBlockingRow key={a.id} agent={a} onRespond={onRespondRequest} />
              ))}
            </div>
          </MenuletSection>
        )}

        {sections.map(sec => sec.list.length > 0 && (
          <MenuletSection
            key={sec.key} label={sec.label} count={sec.list.length}
            collapsed={!!collapsed[sec.key]} onToggle={() => toggle(sec.key)}
          >
            <div className="menulet-list">
              {sec.list.map(a => (
                <MenuletRow
                  key={a.id} agent={a}
                  project={projects.find(p => p.id === a.projectId)}
                  onOpen={(id) => { onOpenAgent?.(id); onClose() }}
                  onPause={onPauseAgent}
                  onResume={(id) => { onResumeAgent?.(id); onClose() }}
                />
              ))}
            </div>
          </MenuletSection>
        ))}
      </div>

      <div className="menulet-f">
        <button onClick={onOpenHub} className="primary">
          <Icon name="grid" size={12} /> open hub
        </button>
        <button onClick={() => { onSpawnAgent?.(); onClose() }}>
          <Icon name="plus" size={12} /> spawn agent
        </button>
      </div>
    </div>
  )
}

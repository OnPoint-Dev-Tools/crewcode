/* ============================================================
   CrewConfigPanel.tsx
   ------------------------------------------------------------
   Crew configuration surface. Two-pane command center:
     · LEFT  rail (identity & shape): name · mode · live SVG
                                       branch topology · templates ·
                                       decision guide
     · RIGHT deck (the roster):       numbered rack-slot lanes ·
                                       click-to-add agent palette ·
                                       MCP server toggle grid
     · Footer (launch tape):          terminal-prompt copy + actions.
   ============================================================ */
import React, { useEffect, useRef, useState, useMemo } from 'react'
import {
  SignalLow, SignalMedium, SignalHigh,
  Plus, Settings2, CircleSlash, UserCog, TriangleAlert, Waypoints,
  type LucideIcon,
} from 'lucide-react'

import { Icon } from '../ui/Icon'
import { DecisionGuide } from './DecisionGuide'
import { LaneModelButton } from './LaneModelButton'
import { CrewRoleModal } from './CrewRoleModal'
import type { CrewTemplate } from '../../orchestrator/crew-templates'
import type { CrewRole } from '../../orchestrator/crew-roles'
import type { CrewRoleInput } from '../../orchestrator/crew-roles'
import type { TaskShape } from '../../orchestrator/decision-guide'
import {
  MAX_LANES,
  NO_ROLE,
  canProvision,
  crewWarnings,
  type CrewSession,
  type CrewMode,
  type CrewAgentLane,
  type CrewRoleAssignment,
  type CrewLaneEffort,
} from '../../orchestrator/crew-session'
import type { AgentInfo } from '../../types'
import { providerImageClass } from '../composer/provider-meta'

import claudeIcon   from '../../assets/claude-color.svg'
import openaiIcon   from '../../assets/openai.svg'
import piIcon       from '../../assets/pi.svg'
import opencodeIcon from '../../assets/opencode.svg'
import hermesIcon   from '../../assets/hermes.png'
import crewCoderIcon from '../../assets/icon-logo-light.png'

const AGENT_ICONS: Record<string, string> = {
  claude: claudeIcon, codex: openaiIcon, pi: piIcon, opencode: opencodeIcon, hermes: hermesIcon, crewcoder: crewCoderIcon,
}

// The compact effort fader intentionally shows the three common native levels.
// Provider-specific off/xhigh/max choices remain available in the lane picker.
type EffortStop = 'low' | 'medium' | 'high'
const EFFORT_ORDER: EffortStop[] = ['low', 'medium', 'high']
const EFFORT_ICON: Record<EffortStop, LucideIcon> = {
  low: SignalLow, medium: SignalMedium, high: SignalHigh,
}

export interface McpServerInfo {
  id:       string
  name:     string
  category?: string
}

interface CrewConfigPanelProps {
  session:        CrewSession
  agents:         AgentInfo[]
  editing:        boolean
  onSetName:      (name: string) => void
  onSetMode:      (mode: CrewMode) => void
  onAddLane:      (agentId: string, role?: CrewRoleAssignment) => void
  onRemoveLane:   (laneId: string) => void
  onSetLaneAgent: (laneId: string, agentId: string) => void
  onSetLaneRole:  (laneId: string, role: CrewRoleAssignment) => void
  roles:          CrewRole[]
  onSaveRole:     (input: CrewRoleInput) => CrewRole
  onUpdateRole:   (id: string, input: CrewRoleInput) => void
  onDeleteRole:   (id: string) => void
  onSetLaneModel: (laneId: string, model: string) => void
  onSetLaneEffort:(laneId: string, effort: CrewLaneEffort) => void
  onLaunch:       () => void
  onRebuild:      () => void
  onCancel:       () => void
  templates:        CrewTemplate[]
  onApplyTemplate:  (tpl: CrewTemplate) => void
  onDeleteTemplate: (tplId: string) => void
  mcpServers?:        McpServerInfo[]
  enabledMcpIds?:     string[]
  onToggleMcp?:       (serverId: string) => void
  onSetSupervisorEnabled: (enabled: boolean) => void
  onSetSupervisorAgent:   (agentId: string) => void
  onSetSupervisorModel:   (model: string) => void
}

const MODE_COPY: Record<CrewMode, { label: string; tag: string; sub: string }> = {
  isolated: { label: 'isolated', tag: 'fork',   sub: 'own worktree + branch · Local' },
  shared:   { label: 'shared',   tag: 'shared', sub: 'all agents share one branch and files · Local' },
}

type CrewSelectOption = { value: string; label: string; hint?: string; disabled?: boolean; icon?: React.ReactNode }

interface CrewSelectProps {
  value: string
  options: CrewSelectOption[]
  disabled?: boolean
  className?: string
  ariaLabel: string
  onChange: (value: string) => void
}

function CrewSelect({ value, options, disabled, className = '', ariaLabel, onChange }: CrewSelectProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const selected = options.find(option => option.value === value) ?? { value, label: value }

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="ccp-select-wrap" ref={ref}>
      <button
        type="button"
        className={`ccp-select ccp-select-trigger ${className} ${open ? 'open' : ''}`}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(isOpen => !isOpen)}
      >
        <span className="ccp-select-value">{selected.label}</span>
        <Icon name="chevDown" size={12} />
      </button>
      {open && !disabled && (
        <div className="ccp-select-menu" role="menu" aria-label={ariaLabel}>
          {options.map(option => {
            const active = option.value === value
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                disabled={option.disabled}
                className={`ccp-select-option ${active ? 'on' : ''}`}
                onClick={() => {
                  if (option.disabled) return
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                {option.icon && <span className="ccp-select-option-ico">{option.icon}</span>}
                <span className="ccp-select-option-copy">
                  <span>{option.label}</span>
                  {option.hint && <small>{option.hint}</small>}
                </span>
                {active && <Icon name="check" size={12} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function CrewConfigPanel({
  session, agents, editing,
  onSetName, onSetMode, onAddLane, onRemoveLane, onSetLaneAgent, onSetLaneRole, onSetLaneModel, onSetLaneEffort,
  roles, onSaveRole, onUpdateRole, onDeleteRole,
  onLaunch, onRebuild, onCancel,
  templates, onApplyTemplate, onDeleteTemplate,
  mcpServers = [], enabledMcpIds = [], onToggleMcp,
  onSetSupervisorEnabled, onSetSupervisorAgent, onSetSupervisorModel,
}: CrewConfigPanelProps) {
  const agentNameOf = (id: string) => agents.find(a => a.id === id)?.name ?? id
  const [pickedShape, setPickedShape] = useState<string | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)

  // Role modal: `roleModal` holds the lane that triggered it (to adopt the new
  // role on save) plus which existing role to edit, if any. null = closed.
  const [roleModal, setRoleModal] = useState<{ laneId: string | null; editingId: string | null } | null>(null)

  /** Resolve a saved-role id into the assignment a lane stores, or NO_ROLE. */
  const assignmentFor = (roleId: string): CrewRoleAssignment => {
    const r = roles.find(x => x.id === roleId)
    return r ? { roleId: r.id, roleName: r.name, role: r.role, instructions: r.instructions } : NO_ROLE
  }

  // Sentinel option values for the lane role picker.
  const ROLE_NONE = '__none__'
  const ROLE_NEW  = '__new__'
  const ROLE_MANAGE = '__manage__'

  const onPickLaneRole = (lane: CrewAgentLane, value: string): void => {
    if (value === ROLE_NONE)   { onSetLaneRole(lane.laneId, NO_ROLE); return }
    if (value === ROLE_NEW)    { setRoleModal({ laneId: lane.laneId, editingId: null }); return }
    if (value === ROLE_MANAGE) { setRoleModal({ laneId: null, editingId: null }); return }
    onSetLaneRole(lane.laneId, assignmentFor(value))
  }

  const available = agents.filter(a => a.available)
  const warnings  = crewWarnings(session)
  const ready     = canProvision(session)
  const atMax     = session.lanes.length >= MAX_LANES
  const count     = session.lanes.length

  const monogram = useMemo(() => {
    const seed = (session.name || '').trim()
    if (!seed) return '··'
    const words = seed.split(/[\s·\-_/]+/).filter(Boolean)
    const a = words[0]?.[0] ?? ''
    const b = (words[1]?.[0] ?? words[0]?.[1] ?? '')
    return (a + b).slice(0, 2).toUpperCase() || '··'
  }, [session.name])

  const laneCountByAgent = useMemo(() => {
    const m: Record<string, number> = {}
    for (const l of session.lanes) m[l.agentId] = (m[l.agentId] ?? 0) + 1
    return m
  }, [session.lanes])

  const enabledMcp = useMemo(() => new Set(enabledMcpIds), [enabledMcpIds])

  const pickShape = (shape: TaskShape) => {
    setPickedShape(shape.id)
    onSetMode(shape.recommend)
  }
  const pickMode = (mode: CrewMode) => {
    setPickedShape(null)
    onSetMode(mode)
  }
  const addAgent = (agentId: string) => {
    if (atMax) return
    onAddLane(agentId, NO_ROLE)
  }

  const launchCopy = session.mode === 'isolated'
    ? `${count} worktree${count === 1 ? '' : 's'} from ${session.baseBranch}`
    : `${count} agent${count === 1 ? '' : 's'} on ${session.baseBranch}`

  const headTagDot = editing ? 'edit' : (ready ? 'ready' : 'pending')

  return (
    <div className={`ccp${editing ? ' is-editing' : ''}`}>

      {/* header */}
      <header className="ccp-head">
        <span className="ccp-head-tag" data-state={headTagDot}>
          <span className="dot" />
          {editing ? 'Editing crew' : 'Crew Config'}
        </span>
        <span className="ccp-head-sub">
          {count} {count === 1 ? 'lane' : 'lanes'} · {session.mode}
        </span>
        <div className="ccp-head-spacer" />
        <span className="ccp-head-branch" title={`forks from ${session.baseBranch}`}>
          <Icon name="branch" size={11} />
          {session.baseBranch}
        </span>
        <button type="button" className="ccp-icon-btn" onClick={onCancel} title="close">
          <Icon name="x" size={13} />
        </button>
      </header>

      {/* body */}
      <div className="ccp-body">

        {/* identity rail */}
        <aside className="ccp-rail">

          <section className="ccp-block">
            <div className="ccp-block-head">crew</div>
            <div className="ccp-identity">
              <span className="ccp-identity-monogram">{monogram}</span>
              <div className="ccp-identity-fields">
                <input
                  className="ccp-identity-input"
                  type="text"
                  value={session.name}
                  placeholder="untitled crew"
                  maxLength={80}
                  onChange={e => onSetName(e.target.value)}
                  aria-label="crew name"
                />
                <div className="ccp-identity-meta">
                  <span>{session.mode}</span>
                  <span className="sep">·</span>
                  <span>{count} {count === 1 ? 'lane' : 'lanes'}</span>
                  <span className="sep">·</span>
                  <span>{session.baseBranch}</span>
                </div>
              </div>
            </div>
          </section>

          <section className="ccp-block">
            <div className="ccp-block-head">workspace mode</div>
            <div className="ccp-mode" role="radiogroup" aria-label="workspace mode">
              {(['isolated', 'shared'] as CrewMode[]).map(mode => {
                const active = session.mode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`ccp-mode-opt ${active ? 'is-active' : ''}`}
                    disabled={editing}
                    onClick={() => pickMode(mode)}
                  >
                    <span className="ccp-mode-opt-top">
                      <span className="glyph">
                        <Icon name={mode === 'isolated' ? 'branch' : 'box'} size={10} />
                      </span>
                      {MODE_COPY[mode].tag}
                    </span>
                    <span className="ccp-mode-opt-label">{MODE_COPY[mode].label}</span>
                    <span className="ccp-mode-opt-sub">{MODE_COPY[mode].sub}</span>
                  </button>
                )
              })}
            </div>
          </section>

          <section className="ccp-block">
            <div className="ccp-block-head">
              topology
              <span className="hint">live</span>
            </div>
            <div className="ccp-topo">
              <TopoSvg
                mode={session.mode}
                baseBranch={session.baseBranch}
                lanes={session.lanes.map(l => ({
                  laneId:  l.laneId,
                  branch:  l.branch,
                  agentId: l.agentId,
                  stale:   !available.some(a => a.id === l.agentId),
                }))}
              />
              <div className="ccp-topo-legend">
                <span className="left">{session.mode === 'isolated' ? 'fork-per-agent' : 'shared-branch'}</span>
                <span>{count} {count === 1 ? 'lane' : 'lanes'}</span>
              </div>
            </div>
          </section>

          {!editing && (
            <section className="ccp-block">
              <div className="ccp-block-head">
                templates
                <span className="count">{templates.length}</span>
              </div>
              {templates.length === 0 ? (
                <p className="ccp-templates-empty">
                  save the current setup as a template to reuse it later.
                </p>
              ) : (
                <div className="ccp-templates">
                  {templates.map(tpl => (
                    <button
                      key={tpl.id}
                      type="button"
                      className="ccp-template-chip"
                      onClick={() => onApplyTemplate(tpl)}
                      title={`apply template: ${tpl.name}`}
                    >
                      <span className="ccp-template-chip-name">{tpl.name}</span>
                      <span className={`ccp-template-chip-mode is-${tpl.mode}`}>{tpl.mode}</span>
                      <span className="ccp-template-chip-sum">
                        {tpl.lanes.map(l => agentNameOf(l.agentId)).join(' · ') || '—'}
                      </span>
                      <span
                        className="ccp-template-chip-rm"
                        role="button"
                        aria-label="delete template"
                        onClick={(e) => { e.stopPropagation(); onDeleteTemplate(tpl.id) }}
                      >
                        <Icon name="x" size={10} />
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {!editing && (
            <section className="ccp-block">
              <div className="ccp-guide">
                <button
                  type="button"
                  className="ccp-guide-toggle"
                  onClick={() => setGuideOpen(o => !o)}
                  aria-expanded={guideOpen}
                >
                  <Icon name="sparkle" size={11} />
                  <span className="ccp-guide-toggle-label">task guide</span>
                  <Icon name={guideOpen ? 'chevDown' : 'chevRight'} size={11} />
                </button>
                {guideOpen && (
                  <div className="ccp-guide-body">
                    <DecisionGuide selectedShapeId={pickedShape} onPick={pickShape} />
                  </div>
                )}
              </div>
            </section>
          )}

        </aside>

        {/* crew deck */}
        <main className="ccp-deck">

          <section className={`ccp-block ccp-sup${session.supervisor.enabled ? ' is-on' : ''}`}>
            <div className="ccp-sup-head">
              <span className="ccp-sup-ico"><Waypoints size={17} /></span>
              <div className="ccp-sup-titles">
                <span className="ccp-sup-title">supervisor</span>
                <span className="ccp-sup-status">
                  {session.supervisor.enabled ? 'orchestrating the crew' : 'off · workers run on their own'}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={session.supervisor.enabled}
                aria-label="toggle supervisor"
                className="ccp-switch"
                onClick={() => onSetSupervisorEnabled(!session.supervisor.enabled)}
              >
                <span className="ccp-switch-label">{session.supervisor.enabled ? 'on' : 'off'}</span>
                <span className="ccp-switch-track"><span className="ccp-switch-knob" /></span>
              </button>
            </div>
            <p className="ccp-sup-note">
              a Supervisor agent — you brief it, it delegates to the
              workers below and reports back. only crew workers (agents) can reply into the chat.
            </p>
            {session.supervisor.enabled && (
              <div className="ccp-sup-row">
                <div className="ccp-lane-meta-cell">
                  <span className="ccp-lane-meta-label">Agent</span>
                  <CrewSelect
                    value={session.supervisor.agentId}
                    disabled={editing}
                    ariaLabel="supervisor agent"
                    onChange={onSetSupervisorAgent}
                    options={[
                      ...available.filter(a => a.transport === 'bridge').map(a => ({ value: a.id, label: a.name, hint: 'bridge agent' })),
                      ...(!available.some(a => a.id === session.supervisor.agentId && a.transport === 'bridge')
                        ? [{ value: session.supervisor.agentId, label: `${session.supervisor.agentId} (unavailable)`, hint: 'not available' }]
                        : []),
                    ]}
                  />
                </div>
                <div className="ccp-lane-meta-cell">
                  <span className="ccp-lane-meta-label">model</span>
                  <LaneModelButton
                    provider={session.supervisor.agentId}
                    model={session.supervisor.model}
                    onPick={m => onSetSupervisorModel(m)}
                    placement="down"
                  />
                </div>
              </div>
            )}
          </section>

          <section className="ccp-block">
            <div className="ccp-block-head">
              Crew Workers
              <span className="count">{count}</span>
            </div>

            {count === 0 ? (
              <div className="ccp-lanes-empty">
                <div className="ccp-lanes-empty-title">no lanes yet</div>
                <div className="ccp-lanes-empty-sub">
                  pick an agent from the palette below to add the first lane.
                </div>
              </div>
            ) : (
              <div className="ccp-lanes">
                {session.lanes.map((lane, i) => {
                  const stale = !available.some(a => a.id === lane.agentId)
                  const icon  = AGENT_ICONS[lane.agentId]
                  const ef    = lane.effort
                  const stopIdx = EFFORT_ORDER.indexOf(ef as EffortStop)
                  const ratio = stopIdx >= 0 ? (stopIdx + 1) / EFFORT_ORDER.length : 0
                  return (
                    <div
                      key={lane.laneId}
                      className={`ccp-lane${stale ? ' is-stale' : ''}`}
                      style={{ ['--lane-i' as any]: i }}
                    >
                      <div className="ccp-lane-slot" aria-hidden>
                        <span className="ccp-lane-slot-num">{String(i + 1).padStart(2, '0')}</span>
                        <span className="ccp-lane-slot-tag">lane</span>
                      </div>
                      <div className="ccp-lane-body">

                        <div className="ccp-lane-top">
                          <div className="ccp-lane-agent">
                            <span className="ccp-lane-agent-ico">
                              {icon
                                ? <img src={icon} alt={lane.agentId} className={providerImageClass(lane.agentId)} />
                                : <Icon name="cpu" size={12} />}
                            </span>
                            <CrewSelect
                              className="ccp-lane-agent-name"
                              value={lane.agentId}
                              disabled={editing}
                              ariaLabel={`lane ${i + 1} agent`}
                              onChange={agentId => onSetLaneAgent(lane.laneId, agentId)}
                              options={[
                                ...available.map(a => ({
                                  value: a.id,
                                  label: a.name,
                                  icon: AGENT_ICONS[a.id]
                                    ? <img src={AGENT_ICONS[a.id]} alt="" className={providerImageClass(a.id)} />
                                    : <Icon name="cpu" size={13} />,
                                })),
                                ...(stale ? [{ value: lane.agentId, label: `${lane.agentId} (unavailable)`, hint: 'not available', icon: <TriangleAlert size={13} /> }] : []),
                              ]}
                            />
                            <CrewSelect
                              className="ccp-lane-role"
                              value={lane.roleId ?? ROLE_NONE}
                              disabled={editing}
                              ariaLabel={`lane ${i + 1} role`}
                              onChange={value => onPickLaneRole(lane, value)}
                              options={[
                                { value: ROLE_NONE, label: 'no role', icon: <CircleSlash size={13} /> },
                                // A lane may carry a role whose definition was since deleted —
                                // keep showing it so the choice isn't silently lost.
                                ...(lane.roleId && !roles.some(r => r.id === lane.roleId)
                                  ? [{ value: lane.roleId, label: `${lane.roleName} (deleted)`, hint: 'no longer saved', icon: <TriangleAlert size={13} /> }]
                                  : []),
                                ...roles.map(r => ({ value: r.id, label: r.name, hint: r.role || undefined, icon: <UserCog size={13} /> })),
                                { value: ROLE_NEW, label: '+ new role…', icon: <Plus size={13} /> },
                                ...(roles.length ? [{ value: ROLE_MANAGE, label: 'manage roles…', icon: <Settings2 size={13} /> }] : []),
                              ]}
                            />
                          </div>
                          {stale && (
                            <span className="ccp-lane-stale">
                              <Icon name="alert" size={9} />
                              unavailable
                            </span>
                          )}
                          {!editing && (
                            <button
                              type="button"
                              className="ccp-lane-rm"
                              title="remove agent"
                              onClick={() => onRemoveLane(lane.laneId)}
                            >
                              <Icon name="x" size={11} />
                            </button>
                          )}
                        </div>

                        <div className="ccp-lane-meta">
                          <div className="ccp-lane-meta-cell">
                            <span className="ccp-lane-meta-label">model</span>
                            <LaneModelButton
                              provider={lane.agentId}
                              model={lane.model}
                              onPick={m => onSetLaneModel(lane.laneId, m)}
                              placement="down"
                            />
                          </div>
                          <div className="ccp-lane-meta-cell" style={{ justifyContent: 'center' }}>
                            <span className="ccp-lane-meta-label">effort</span>
                            <div className="ccp-effort" role="radiogroup" aria-label="effort">
                              {EFFORT_ORDER.map(e => {
                                const EffortIcon = EFFORT_ICON[e]
                                return (
                                  <button
                                    key={e}
                                    type="button"
                                    role="radio"
                                    aria-checked={ef === e}
                                    aria-label={e}
                                    title={e}
                                    className={`ccp-effort-seg${ef === e ? ' is-active' : ''}`}
                                    onClick={() => onSetLaneEffort(lane.laneId, e)}
                                  >
                                    <EffortIcon size={13} />
                                  </button>
                                )
                              })}
                            </div>
                            <div className="ccp-effort-bar" aria-hidden>
                              <i style={{ width: `${ratio * 100}%` }} />
                            </div>
                          </div>
                          <span className="ccp-lane-branch" title={lane.branch}>{lane.branch}</span>
                        </div>

                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {!editing && (
            <section className="ccp-block">
              <div className="ccp-block-head">
                agent palette
                <span className="hint">click to add</span>
              </div>
              {available.length === 0 ? (
                <p className="ccp-palette-disabled-note">no agents installed — set one up in settings</p>
              ) : (
                <div className="ccp-palette">
                  {available.map(a => {
                    const icon = AGENT_ICONS[a.id]
                    const n = laneCountByAgent[a.id] ?? 0
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className="ccp-palette-chip"
                        disabled={atMax}
                        onClick={() => addAgent(a.id)}
                        title={atMax ? 'lane limit reached' : `add a ${a.name} lane`}
                      >
                        <span className="ccp-palette-chip-ico">
                          {icon
                            ? <img src={icon} alt="" className={providerImageClass(a.id)} />
                            : <Icon name="cpu" size={10} />}
                        </span>
                        <span>{a.name}</span>
                        {n > 0 && <span className="ccp-palette-chip-count">×{n}</span>}
                        <span className="plus" aria-hidden>
                          <Icon name="plus" size={10} />
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </section>
          )}

          {mcpServers.length > 0 && (
            <section className="ccp-block">
              <div className="ccp-block-head">
                mcp servers
                <span className="count">{enabledMcp.size}/{mcpServers.length}</span>
              </div>
              <div className="ccp-mcp">
                {mcpServers.map(srv => {
                  const on = enabledMcp.has(srv.id)
                  return (
                    <button
                      key={srv.id}
                      type="button"
                      className={`ccp-mcp-srv${on ? ' is-on' : ''}`}
                      onClick={() => onToggleMcp?.(srv.id)}
                      aria-pressed={on}
                    >
                      <span className="ccp-mcp-check" aria-hidden>
                        {on ? <Icon name="check" size={9} /> : null}
                      </span>
                      <span className="ccp-mcp-name">{srv.name}</span>
                      {srv.category && <span className="ccp-mcp-tag">{srv.category}</span>}
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          {warnings.length > 0 && (
            <div className="ccp-warnings">
              {warnings.map((w, i) => (
                <div key={i} className="ccp-warning">
                  <Icon name="alert" size={11} />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

        </main>
      </div>

      {/* footer (launch tape) */}
      <footer className="ccp-foot">
        <span className="ccp-foot-prompt">
          {editing ? (
            <>
              <span className="caret">›</span>
              <span className="cmd">edit crew</span>
              <span>· model changes apply live, rebuild to add or swap agents</span>
            </>
          ) : (
            <>
              <span className="caret">›</span>
              <span className="cmd">{ready ? 'launch crew' : 'crew not ready'}</span>
              <span>· {launchCopy}</span>
              {ready && <span className="blink" aria-hidden />}
            </>
          )}
        </span>
        <div className="ccp-foot-actions">
          {editing ? (
            <>
              <button type="button" className="ccp-btn ccp-btn-warn" onClick={onRebuild}>
                <Icon name="refresh" size={11} />
                rebuild crew
              </button>
              <button type="button" className="ccp-btn ccp-btn-go" onClick={onCancel}>
                <Icon name="check" size={11} />
                done
              </button>
            </>
          ) : (
            <>
              <button type="button" className="ccp-btn" onClick={onCancel}>cancel</button>
              <button
                type="button"
                className="ccp-btn ccp-btn-go"
                disabled={!ready}
                onClick={onLaunch}
              >
                <Icon name="bolt" size={11} />
                launch
                <span className="ccp-btn-kbd">↵</span>
              </button>
            </>
          )}
        </div>
      </footer>

      <CrewRoleModal
        open={roleModal !== null}
        roles={roles}
        editingId={roleModal?.editingId ?? null}
        onClose={() => setRoleModal(null)}
        onSave={onSaveRole}
        onUpdate={onUpdateRole}
        onDelete={onDeleteRole}
        onAdopt={roleModal?.laneId
          ? role => onSetLaneRole(roleModal.laneId as string, {
              roleId: role.id, roleName: role.name, role: role.role, instructions: role.instructions,
            })
          : undefined}
      />
    </div>
  )
}


/* ============================================================
   <TopoSvg> — live branch topology preview.
   ============================================================ */
interface TopoSvgProps {
  mode:       CrewMode
  baseBranch: string
  lanes:      { laneId: string; branch: string; agentId: string; stale: boolean }[]
}

function TopoSvg({ mode, baseBranch, lanes }: TopoSvgProps) {
  const W = 280
  const H = 92
  const padL = 14
  const padR = 14
  const railY = H - 18
  const inner = W - padL - padR

  const N = Math.max(lanes.length, 1)
  const slotW = inner / Math.max(N, 3)
  const startX = padL + slotW / 2
  const forkX = lanes.map((_, i) => startX + i * slotW)
  const laneY = 16

  const labelOf = (b: string) => {
    const tail = b.split('/').pop() ?? b
    return tail.length > 14 ? tail.slice(0, 12) + '…' : tail
  }

  return (
    <svg className="ccp-topo-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="crew topology">
      <line className="base" x1={padL} y1={railY} x2={W - padR} y2={railY} />
      <circle className="node-base" cx={padL} cy={railY} r="3.5" />
      <circle className="node-base" cx={W - padR} cy={railY} r="3.5" />
      <text className="branch-label" x={padL} y={railY + 12}>{baseBranch}</text>

      {lanes.map((l, i) => {
        const x = forkX[i]
        const d = mode === 'isolated'
          ? `M ${x} ${railY} C ${x} ${railY - 18}, ${x} ${laneY + 18}, ${x} ${laneY}`
          : `M ${x} ${railY} L ${x} ${laneY + 4}`
        return (
          <g key={l.laneId}>
            <path className="fork-bg" d={d} />
            <path className="fork"    d={d} />
            <circle
              className={`node-lane${l.stale ? ' is-stale' : ''}`}
              cx={x} cy={laneY} r="5"
            />
            <text className="lane-idx" x={x} y={laneY + 2.5} textAnchor="middle">{i + 1}</text>
            {mode === 'isolated' && (
              <text className="branch-label" x={x} y={laneY - 8} textAnchor="middle">
                {labelOf(l.branch)}
              </text>
            )}
          </g>
        )
      })}

      {mode === 'shared' && lanes.length > 0 && (
        <rect
          x={forkX[0] - 8}
          y={laneY - 6}
          width={(forkX[lanes.length - 1] - forkX[0]) + 16}
          height={12}
          rx={6}
          fill="none"
          stroke="var(--crew-green-bright)"
          strokeDasharray="2 2"
          opacity="0.55"
        />
      )}
    </svg>
  )
}

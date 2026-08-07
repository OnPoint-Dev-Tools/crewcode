import React, { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import type { AgentActivityState } from '../ui/AgentActivityIndicator'
import type { Workspace, WorkspaceStatus } from '../../types'

const STATUS_COLOR: Record<WorkspaceStatus, string> = {
  ready: 'var(--success)',
  live:  'var(--success)',
  plan:  'var(--warning)',
  idle:  'var(--muted-foreground)',
  error: 'var(--destructive)'
}

function StatusDot({ status }: { status: WorkspaceStatus }) {
  return (
    <span
      className={`ws-dot ${status === 'live' ? 'pulse' : ''}`}
      style={{ background: STATUS_COLOR[status] }}
    />
  )
}

interface WorkspaceRowProps {
  ws:            Workspace
  active:        boolean
  onClick:       () => void
  hasWorktrees?: boolean
  expanded?:     boolean
  onToggle?:     () => void
  onRename?:     (name: string) => void
  agentActivity?: AgentActivityState
  displayPath?:  string
}

export function WorkspaceRow({ ws, active, onClick, hasWorktrees, expanded, onToggle, onRename, agentActivity, displayPath }: WorkspaceRowProps) {
  const [editing, setEditing] = useState(false)
  const [draft,   setDraft]   = useState(ws.name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { if (editing) inputRef.current?.select() }, [editing])

  function commit() {
    const next = draft.trim()
    if (next && next !== ws.name) onRename?.(next)
    setEditing(false)
  }

  function startEdit(e: React.MouseEvent) {
    if (!onRename) return
    e.stopPropagation()
    setDraft(ws.name)
    setEditing(true)
  }

  return (
    <button className={`ws-row ws-workspace-row ${active ? 'on' : ''}`} onClick={onClick} onDoubleClick={startEdit}>
      <span className="ws-kind">
        {ws.projectIconDataUrl
          ? <img className="ws-kind-img" src={ws.projectIconDataUrl} alt="" />
          : ws.kind === 'folder' ? <Icon name="projects" size={13} />
          : ws.kind === 'remote' ? <Icon name="globe" size={13} />
          : <Icon name="branch" size={13} />}
      </span>
      <span className="ws-main">
        <span className="ws-name">
          {editing
            ? (
              <input
                ref={inputRef}
                className="ws-name-input"
                value={draft}
                autoFocus
                onClick={e => e.stopPropagation()}
                onChange={e => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={e => {
                  e.stopPropagation()
                  if (e.key === 'Enter')  { e.preventDefault(); commit() }
                  if (e.key === 'Escape') { e.preventDefault(); setEditing(false) }
                }}
              />
            )
            : ws.name}

        </span>
        <span className="ws-path" title={ws.path}>{displayPath ?? ws.path}</span>
      </span>
      <span className="ws-meta">
        {ws.branch && (
          <span className="ws-branch">
            <Icon name="branch" size={11} />
            <span className="ws-branch-text">{ws.branch}</span>
          </span>
        )}
        <span className={`ws-status ${ws.kind === 'folder' ? 'ws-status-local' : ''}`}>
          <StatusDot status={agentActivity === 'working' ? 'live' : ws.status} />
          {ws.kind === 'folder' ? 'LOCAL' : agentActivity === 'working' ? 'live' : ws.status}
        </span>
        <span className="ws-updated">{ws.updated}</span>
        {hasWorktrees && (
          <span
            className="ws-chev"
            title={expanded ? 'collapse' : 'expand'}
            style={{ transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }}
            onMouseDown={e => { e.preventDefault(); e.stopPropagation() }}
            onClick={e => { e.preventDefault(); e.stopPropagation(); onToggle?.() }}
          >
            <Icon name="chevRight" size={12} />
          </span>
        )}
      </span>
    </button>
  )
}

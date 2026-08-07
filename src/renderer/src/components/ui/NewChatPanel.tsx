import React, { useState, useEffect, useRef } from 'react'
import { Icon } from './Icon'
import type { Workspace, AgentInfo } from '../../types'

interface NewChatPanelProps {
  open:          boolean
  onClose:       () => void
  workspaces:    Workspace[]
  agents:        AgentInfo[]
  activeAgentId: string
  onStart:       (contextId: string, agentId: string, label: string) => void
}

export function NewChatPanel({
  open, onClose, workspaces, agents, activeAgentId, onStart
}: NewChatPanelProps) {
  const [selectedContextId, setSelectedContextId] = useState('')
  const [selectedAgentId,   setSelectedAgentId]   = useState(activeAgentId)
  const [expandedWs,        setExpandedWs]         = useState<Set<string>>(new Set())
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setSelectedAgentId(activeAgentId) }, [activeAgentId])

  useEffect(() => {
    if (open) {
      setSelectedContextId('')
      setExpandedWs(new Set())
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'Enter' && selectedContextId) {
        e.preventDefault()
        const parts = selectedContextId.split(':')
        const wsId  = parts[0]
        const wtId  = parts.length > 1 ? parts[1] : undefined
        const ws    = workspaces.find(w => w.id === wsId)
        if (!ws) return
        const wt    = wtId ? ws.worktrees.find(t => t.id === wtId) : undefined
        onStart(selectedContextId, selectedAgentId, `${ws.name}${wt ? ' · ' + wt.branch : ''}`)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, selectedContextId, selectedAgentId, workspaces, onClose, onStart])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])

  const availableAgents = agents.filter(a => a.available)

  const handleStart = () => {
    if (!selectedContextId) return
    const parts = selectedContextId.split(':')
    const wsId  = parts[0]
    const wtId  = parts.length > 1 ? parts[1] : undefined
    const ws    = workspaces.find(w => w.id === wsId)
    if (!ws) return
    const wt    = wtId ? ws.worktrees.find(t => t.id === wtId) : undefined
    onStart(selectedContextId, selectedAgentId, `${ws.name}${wt ? ' · ' + wt.branch : ''}`)
  }

  const toggleExpand = (wsId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setExpandedWs(prev => {
      const next = new Set(prev)
      if (next.has(wsId)) next.delete(wsId)
      else next.add(wsId)
      return next
    })
  }

  return (
    <div className={`ncp${open ? ' open' : ''}`} ref={panelRef}>
      <div className="ncp-head">
        <span className="ncp-title">new chat</span>
        <button className="ncp-close" onClick={onClose} aria-label="close">
          <Icon name="close" size={13} />
        </button>
      </div>

      <div className="ncp-list">
        {workspaces.map(ws => {
          const isWsSelected = selectedContextId === ws.id
          const isExpanded   = expandedWs.has(ws.id)
          const hasWorktrees = ws.worktrees.length > 0
          return (
            <React.Fragment key={ws.id}>
              <button
                className={`ncp-row${isWsSelected ? ' on' : ''}`}
                onClick={() => setSelectedContextId(ws.id)}
              >
                <span className="ncp-row-kind">
                  {ws.kind === 'folder'
                    ? <Icon name="projects" size={12} />
                    : ws.kind === 'remote'
                    ? <Icon name="globe"    size={12} />
                    : <Icon name="branch"   size={12} />}
                </span>
                <span className="ncp-row-info">
                  <span className="ncp-row-name">{ws.name}</span>
                  <span className="ncp-row-path">{ws.path}</span>
                </span>
                {hasWorktrees && (
                  <span
                    className="ncp-row-chev"
                    style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 150ms' }}
                    onClick={e => toggleExpand(ws.id, e)}
                  >
                    <Icon name="chevRight" size={11} />
                  </span>
                )}
              </button>

              {hasWorktrees && isExpanded && ws.worktrees.map(wt => {
                const wtCtxId = `${ws.id}:${wt.id}`
                const isWtSel = selectedContextId === wtCtxId
                return (
                  <button
                    key={wt.id}
                    className={`ncp-row ncp-row-wt${isWtSel ? ' on' : ''}`}
                    onClick={() => setSelectedContextId(wtCtxId)}
                  >
                    <span className="ncp-row-kind"><Icon name="branch" size={11} /></span>
                    <span className="ncp-row-info">
                      <span className="ncp-row-name">{wt.branch}</span>
                      <span className="ncp-row-path">{wt.path}</span>
                    </span>
                  </button>
                )
              })}
            </React.Fragment>
          )
        })}
      </div>

      <div className="ncp-footer">
        <div className="ncp-agent-row">
          {availableAgents.length > 0
            ? availableAgents.map(a => (
                <button
                  key={a.id}
                  className={`ncp-agent-pill${selectedAgentId === a.id ? ' on' : ''}`}
                  onClick={() => setSelectedAgentId(a.id)}
                >
                  {a.name}
                </button>
              ))
            : <span className="ncp-no-agent">no agent available — install claude, opencode, or codex</span>
          }
        </div>
        <button
          className="ncp-start"
          disabled={!selectedContextId || availableAgents.length === 0}
          onClick={handleStart}
        >
          <Icon name="threads" size={12} />
          start chat
        </button>
      </div>
    </div>
  )
}

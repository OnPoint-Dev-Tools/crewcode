import React from 'react'
import { Icon } from '../ui/Icon'
import { PROVIDER_IMAGES, providerImageClass } from '../composer/provider-meta'
import { AgentActivityIndicator, type AgentActivityState } from '../ui/AgentActivityIndicator'
import { formatElapsed } from './session-elapsed'
import { chatSessionSurface } from '../../hooks/chat-session-tab-owner'
import { encodeSessionDrag, SESSION_DRAG_MIME } from './session-drag'
import type { Session } from '../../types'

interface SessionsProps {
  sessions: Session[]
  active: string
  onActivate: (id: string) => void
  onAdd?: () => void
  onRemove?: (id: string) => void
  // Right-click on a row. The drawer owns the menu; this only reports where.
  onRowContextMenu?: (id: string, x: number, y: number) => void
  sessionActivity?: Record<string, AgentActivityState | undefined>
  // Wall-clock ms of each session's last completed turn, plus a ticking `now`,
  // so each row can show how long ago it finished.
  sessionCompletedAt?: Record<string, number>
  now?: number
  draggable?: boolean
}

export function Sessions({ sessions, active, onActivate, onAdd, onRemove, onRowContextMenu, sessionActivity, sessionCompletedAt, now, draggable = true }: SessionsProps) {
  // This component is only mounted in the workspace drawer/sidebar, the one
  // place where destructive session deletion is allowed.
  const canRemove = !!onRemove
  return (
    <div className="sessions">
      {sessions.map(s => {
        const activity = sessionActivity?.[s.id]
        const completedAt = sessionCompletedAt?.[s.id] ?? s.lastUsedAt
        const elapsed = completedAt != null && now != null ? formatElapsed(now - completedAt) : ''
        // Writer threads sit in the same drawer list as plain chats but reopen a
        // document workspace, so they carry a marker instead of looking identical.
        const isWriter = chatSessionSurface(s.tabId) === 'writer'
        // Threads an agent spawned. Write-capable ones also own a worktree, which
        // the title surfaces so an isolated branch isn't invisible in the list.
        const isDelegatedRow = s.origin === 'delegated'
        // The spawning agent marked its work finished. The chat stays open and
        // continuable — only the user archives it — so this is a hint, not a
        // lifecycle state.
        const isDoneRow = isDelegatedRow && s.delegationClosedAt != null
        const title = isWriter ? `${s.label} — Writers Workspace chat`
          : isDelegatedRow ? `${s.label} — delegated${s.delegatedBranch ? ` · ${s.delegatedBranch}` : ''}${isDoneRow ? ' · agent marked done (still open)' : ''}`
          : s.label
        return (
          <div
            key={s.id}
            title={title}
            className={`sess ${active === s.id ? 'on' : ''} ${s.pinned ? 'sess-pinned' : ''} ${isWriter ? 'sess-writer' : ''} ${isDelegatedRow ? 'sess-delegated' : ''} ${isDoneRow ? 'sess-delegated-done' : ''} ${draggable ? 'sess-draggable' : ''}`}
            draggable={draggable}
            onDragStart={draggable ? (e) => {
              e.dataTransfer.effectAllowed = 'copy'
              e.dataTransfer.setData(SESSION_DRAG_MIME, encodeSessionDrag({ sessionId: s.id, tabId: s.tabId }))
              e.dataTransfer.setData('text/plain', s.label)
            } : undefined}
            onClick={() => onActivate(s.id)}
            onContextMenu={onRowContextMenu ? (e) => {
              e.preventDefault()
              e.stopPropagation()
              onRowContextMenu(s.id, e.clientX, e.clientY)
            } : undefined}
          >
            {PROVIDER_IMAGES[s.agentId] ? (
              <img
                src={PROVIDER_IMAGES[s.agentId]}
                alt={s.agentId}
                className={`sess-provider-img ${providerImageClass(s.agentId)}`}
                width={14}
                height={14}
              />
            ) : (
              <span className="dot" />
            )}
            <span className="sess-label">{s.label}</span>
            {s.pinned && (
              <Icon name="pin" size={10} className="sess-pin" aria-label="pinned chat" />
            )}
            {isWriter && (
              <span className="sess-surface" aria-label="Writers Workspace chat">
                <Icon name="edit" size={9} />writer
              </span>
            )}
            {isDelegatedRow && s.delegatedBranch && (
              <span className="sess-surface" aria-label={`worktree branch ${s.delegatedBranch}`}>
                <Icon name="branch" size={9} />wt
              </span>
            )}
            {isDoneRow && (
              <span className="sess-surface sess-surface-done" aria-label="agent marked this thread done; it is still open">
                <Icon name="check" size={9} />done
              </span>
            )}
            {activity && <AgentActivityIndicator state={activity} size={12} className="sess-activity" />}
            {elapsed && <span className="sess-elapsed">{elapsed}</span>}
            {canRemove && (
              <div
                className="sess-x"
                title={`delete ${s.label}`}
                aria-label={`delete ${s.label}`}
                onClick={(e) => {
                  e.stopPropagation()
                  // Confirmation is owned by the drawer's in-app ConfirmModal;
                  // native window.confirm froze composer focus under Wayland.
                  onRemove!(s.id)
                }}
              >
                <Icon name="x" size={10} />
              </div>
            )}
          </div>
        )
      })}
      {onAdd && (
        <div
          className="sess-add"
          title="new chat"
          aria-label="new chat"
          onClick={(e) => {
            e.stopPropagation()
            onAdd()
          }}
        >
          <Icon name="plus" size={10} />
        </div>
      )}
    </div>
  )
}

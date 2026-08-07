import React from 'react'
import { Icon } from '../ui/Icon'
import type { Worktree } from '../../types'

interface WorktreeRowProps {
  wt:             Worktree
  active:         boolean
  onClick:        () => void
  onContextMenu?: (e: React.MouseEvent) => void
}

export function WorktreeRow({ wt, active, onClick, onContextMenu }: WorktreeRowProps) {
  return (
    <button className={`wt-row ${active ? 'on' : ''}`} onClick={onClick} onContextMenu={onContextMenu}>
      <span className="wt-branch">{wt.branch}</span>
      <span className="wt-path">{wt.path}</span>
      <span className="wt-meta">
        <span className="wt-head">{wt.head.slice(0, 7)}</span>
        {wt.dirty > 0 && (
          <span className="ws-dirty">&#x25CF;{wt.dirty}</span>
        )}
        {wt.locked && (
          <span className="wt-lock" title="locked">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </span>
        )}
      </span>
    </button>
  )
}

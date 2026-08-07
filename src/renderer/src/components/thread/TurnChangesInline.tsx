import React, { useState } from 'react'
import { PierreDiff } from '../diff/PierreDiff'
import type { TurnFileChange } from '../../types'

interface TurnChangesInlineProps {
  changes: TurnFileChange[]
}

/**
 * Compact "files changed this turn" affordance rendered directly under an
 * agent bubble. Each file is collapsed by default; clicking expands the
 * Pierre diff in place. Shown only when the turn actually mutated files.
 */
export function TurnChangesInline({ changes }: TurnChangesInlineProps) {
  const [openPaths, setOpenPaths] = useState<Record<string, boolean>>({})
  const [collapsed, setCollapsed] = useState(false)

  if (changes.length === 0) return null

  return (
    <div className="turn-changes">
      <button
        type="button"
        className="turn-changes-head"
        onClick={() => setCollapsed(c => !c)}
        title={collapsed ? 'expand' : 'collapse'}
      >
        <span className="turn-changes-arrow">{collapsed ? '▸' : '▾'}</span>
        <span className="turn-changes-count">{changes.length} file{changes.length === 1 ? '' : 's'} changed</span>
      </button>
      {!collapsed && (
        <ul className="turn-changes-list">
          {changes.map(change => {
            const open = !!openPaths[change.path]
            return (
              <li key={change.path} className="turn-changes-file">
                <button
                  type="button"
                  className="turn-changes-file-row"
                  onClick={() => setOpenPaths(p => ({ ...p, [change.path]: !p[change.path] }))}
                >
                  <span className="turn-changes-file-arrow">{open ? '▾' : '▸'}</span>
                  <span className="turn-changes-file-path mono">{change.path}</span>
                </button>
                {open && (
                  <div className="turn-changes-file-diff">
                    <PierreDiff patch={change.patch} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

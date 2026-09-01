import React, { useState, useEffect, useCallback } from 'react'
import { Icon } from '../ui/Icon'
import { XTermPane, type TerminalClipboardActions } from './XTermPane'
import { Splitter } from '../chat/Splitter'
import { ChatContextMenu } from '../chat/ChatContextMenu'
import type { ChatContextMenuItem } from '../chat/ChatContextMenu'
import type { PtyPane, AgentInfo } from '../../types'
import type { RegisteredPluginTerminalWatcher } from '../../../../shared/plugin-types'
import { providerImageClass } from '../composer/provider-meta'
import { isSessionDrag, readSessionDrag, type SessionDragPayload } from '../thread/session-drag'

import claudeIcon   from '../../assets/claude-color.svg'
import openaiIcon   from '../../assets/openai.svg'
import piIcon       from '../../assets/pi.svg'
import opencodeIcon from '../../assets/opencode.svg'
import hermesIcon   from '../../assets/hermes.png'
import crewCoderIcon from '../../assets/icon-logo-light.png'

const AGENT_ICONS: Record<string, string> = {
  claude:   claudeIcon,
  codex:    openaiIcon,
  pi:       piIcon,
  opencode: opencodeIcon,
  hermes:   hermesIcon,
  crewcoder: crewCoderIcon,
}

export interface TermColumnProps {
  panes:      PtyPane[]
  agents:     AgentInfo[]
  /** Window-tab kind so XTermPane's reattach `ptyCreate` keeps YuHeard flags. */
  tabKind?:   string
  /** False for mounted keepalive tabs; their xterms buffer without rendering. */
  active?:    boolean
  onClose:    (paneId: string) => void
  onAddShell: () => PtyPane
  onAddAgent: (agentId: string) => PtyPane | undefined
  onAddSsh?:  (target: string) => PtyPane | undefined
  sshTargets?: { id: string; label: string; target: string }[]
  layout?:    Layout
  onLayoutChange?: (layout: Layout) => void
  onOpenUrl?: (url: string) => void
  pluginTerminalWatchers?: RegisteredPluginTerminalWatcher[]
  onPluginTerminalWatcher?: (target: { pluginId: string; sidebarPanel?: string; tab?: string; command?: string }, paneId: string) => void
  onSessionDrop?: (payload: SessionDragPayload) => void
}

// Layout tracks which panes live in which column and row.
// Weights are positional — slight drift if middle column is removed is acceptable.
interface Layout {
  columns:    string[][]   // columns[colIdx] = [paneId, ...]
  colWeights: number[]     // flex weight per column
  rowWeights: number[][]   // rowWeights[colIdx][rowIdx]
}

const EMPTY_LAYOUT: Layout = { columns: [], colWeights: [], rowWeights: [] }

const PANE_MENU_BASE: ChatContextMenuItem[] = [
  { id: 'copy', label: 'Copy', icon: 'copy', kbd: 'Ctrl+C' },
  { id: 'paste', label: 'Paste', kbd: 'Ctrl+V' },
  { id: 'sep0', label: '', divider: true },
  { id: 'split-right', label: 'Split Right', icon: 'terminal', kbd: 'Ctrl+Shift+D' },
  { id: 'open-terminal-right', label: 'Open Terminal Right', icon: 'terminal' },
  { id: 'split-down',  label: 'Split Down',  icon: 'terminal', kbd: 'Alt+Shift+D'  },
  { id: 'sep',         label: '', divider: true },
  { id: 'close',       label: 'Close Pane',  icon: 'x' },
]

export function TermColumn({
  panes, agents, tabKind, active = true, onClose, onAddShell, onAddAgent, onAddSsh, sshTargets = [],
  layout: externalLayout, onLayoutChange, onOpenUrl,
  pluginTerminalWatchers = [], onPluginTerminalWatcher, onSessionDrop,
}: TermColumnProps) {
  const available = agents.filter(a => a.available)
  const [internalLayout, setInternalLayout] = useState<Layout>(EMPTY_LAYOUT)
  const isExternal = externalLayout !== undefined && onLayoutChange !== undefined
  const layout = isExternal ? externalLayout : internalLayout

  const [ctxMenu, setCtxMenu] = useState<{ paneId: string; x: number; y: number } | null>(null)
  const [sshMenuOpen, setSshMenuOpen] = useState(false)
  const [collapsedPanes, setCollapsedPanes] = useState<Set<string>>(() => new Set())
  const [draggedPaneId, setDraggedPaneId] = useState<string | null>(null)
  const [dropTargetPaneId, setDropTargetPaneId] = useState<string | null>(null)
  const [sessionDropActive, setSessionDropActive] = useState(false)
  const clipboardActionsRef = React.useRef<Record<string, TerminalClipboardActions>>({})

  const paneIdsKey = panes.map(p => p.paneId).join('\u0000')

  // Reconcile layout when pane membership changes (internal layout only).
  // New panes (not yet in any column) go to column 0 (or create it).
  // Removed panes are pruned; empty columns are dropped.
  useEffect(() => {
    if (isExternal) return
    setInternalLayout(prev => {
      const paneIds = panes.map(p => p.paneId)
      const inLayout = new Set(prev.columns.flat())
      const inPanes  = new Set(paneIds)

      // Remove closed panes and prune empty columns
      const cleaned = prev.columns
        .map(col => col.filter(id => inPanes.has(id)))
        .filter(col => col.length > 0)

      // Add new panes that aren't in any column yet
      const newIds = paneIds.filter(id => !inLayout.has(id))

      if (newIds.length === 0 && cleaned.length === prev.columns.length &&
          cleaned.every((col, i) => col.length === prev.columns[i]?.length)) {
        return prev
      }

      const cols = newIds.length === 0
        ? cleaned
        : cleaned.length > 0
          ? [...cleaned, ...newIds.map(id => [id])]
          : [newIds]

      const colWeights = cols.map((_, i) => prev.colWeights[i] ?? 1)
      const rowWeights = cols.map((col, i) => col.map((_, j) => prev.rowWeights?.[i]?.[j] ?? 1))

      return { columns: cols, colWeights, rowWeights }
    })
  }, [paneIdsKey, isExternal])

  const setLayout = useCallback((updater: (prev: Layout) => Layout) => {
    if (isExternal) {
      onLayoutChange?.(updater(layout))
    } else {
      setInternalLayout(updater)
    }
  }, [isExternal, onLayoutChange, layout])

  const onColDrag = useCallback((aIdx: number, bIdx: number, deltaPx: number) => {
    setLayout(prev => {
      const weights = [...prev.colWeights]
      const total   = (weights[aIdx] ?? 1) + (weights[bIdx] ?? 1)
      const step    = deltaPx / 280
      const a       = Math.max(0.15, Math.min(total - 0.15, (weights[aIdx] ?? 1) + step))
      weights[aIdx] = a
      weights[bIdx] = total - a
      return { ...prev, colWeights: weights }
    })
  }, [setLayout])

  const onRowDrag = useCallback((colIdx: number, aRowIdx: number, bRowIdx: number, deltaPx: number) => {
    setLayout(prev => {
      const rw    = prev.rowWeights.map(r => [...r])
      const total = (rw[colIdx]?.[aRowIdx] ?? 1) + (rw[colIdx]?.[bRowIdx] ?? 1)
      const step  = deltaPx / 200
      const a     = Math.max(0.15, Math.min(total - 0.15, (rw[colIdx]?.[aRowIdx] ?? 1) + step))
      if (!rw[colIdx]) rw[colIdx] = []
      rw[colIdx][aRowIdx] = a
      rw[colIdx][bRowIdx] = total - a
      return { ...prev, rowWeights: rw }
    })
  }, [setLayout])

  const handlePaneHeaderDragStart = useCallback((event: React.DragEvent<HTMLDivElement>, paneId: string) => {
    setDraggedPaneId(paneId)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-crewcode-pane-id', paneId)
    event.dataTransfer.setData('text/plain', paneId)
  }, [])

  const clearPaneDragState = useCallback(() => {
    setDraggedPaneId(null)
    setDropTargetPaneId(null)
  }, [])

  const swapPanes = useCallback((sourcePaneId: string, targetPaneId: string) => {
    if (!sourcePaneId || !targetPaneId || sourcePaneId === targetPaneId) return
    setLayout(prev => {
      let sourceCol = -1
      let sourceRow = -1
      let targetCol = -1
      let targetRow = -1

      prev.columns.forEach((col, colIdx) => {
        const sourceIdx = col.indexOf(sourcePaneId)
        if (sourceIdx !== -1) {
          sourceCol = colIdx
          sourceRow = sourceIdx
        }
        const targetIdx = col.indexOf(targetPaneId)
        if (targetIdx !== -1) {
          targetCol = colIdx
          targetRow = targetIdx
        }
      })

      if (sourceCol === -1 || targetCol === -1) return prev

      // Swap pane ids only; row/column weights remain positional so layout sizes
      // don't unexpectedly follow the dragged terminal.
      const columns = prev.columns.map(col => [...col])
      columns[sourceCol][sourceRow] = targetPaneId
      columns[targetCol][targetRow] = sourcePaneId
      return { ...prev, columns }
    })
  }, [setLayout])

  const handlePaneDrop = useCallback((event: React.DragEvent<HTMLDivElement>, targetPaneId: string) => {
    const sessionPayload = readSessionDrag(event.dataTransfer)
    if (sessionPayload && onSessionDrop) {
      event.preventDefault()
      event.stopPropagation()
      setSessionDropActive(false)
      setDropTargetPaneId(null)
      onSessionDrop(sessionPayload)
      return
    }
    event.preventDefault()
    const sourcePaneId = event.dataTransfer.getData('application/x-crewcode-pane-id') || draggedPaneId
    if (sourcePaneId) swapPanes(sourcePaneId, targetPaneId)
    clearPaneDragState()
  }, [clearPaneDragState, draggedPaneId, onSessionDrop, swapPanes])

  const handleSplitRight = useCallback((fromPaneId: string) => {
    setLayout(prev => {
      const colIdx = prev.columns.findIndex(c => c.includes(fromPaneId))
      if (colIdx === -1) return prev
      const rowIdx = prev.columns[colIdx].indexOf(fromPaneId)
      if (rowIdx === -1) return prev

      const sourceCol = prev.columns[colIdx]
      // Split Right moves this existing pane into its own right-hand column;
      // opening a brand-new shell is a separate context-menu action below.
      if (sourceCol.length === 1 && prev.columns.length === 1) return prev

      const nextColumns: string[][] = []
      const nextColWeights: number[] = []
      const nextRowWeights: number[][] = []

      for (let i = 0; i < prev.columns.length; i++) {
        if (i !== colIdx) {
          nextColumns.push(prev.columns[i])
          nextColWeights.push(prev.colWeights[i] ?? 1)
          nextRowWeights.push(prev.rowWeights[i] ?? prev.columns[i].map(() => 1))
          continue
        }

        const remaining = sourceCol.filter(id => id !== fromPaneId)
        const remainingWeights = (prev.rowWeights[i] ?? sourceCol.map(() => 1)).filter((_, idx) => idx !== rowIdx)
        if (remaining.length > 0) {
          nextColumns.push(remaining)
          nextColWeights.push(prev.colWeights[i] ?? 1)
          nextRowWeights.push(remainingWeights.length ? remainingWeights : remaining.map(() => 1))
        }

        nextColumns.push([fromPaneId])
        nextColWeights.push(prev.colWeights[i] ?? 1)
        nextRowWeights.push([1])
      }

      return { columns: nextColumns, colWeights: nextColWeights, rowWeights: nextRowWeights }
    })
  }, [setLayout])

  const handleOpenTerminalRight = useCallback((fromPaneId: string) => {
    const newPane = onAddShell()
    setLayout(prev => {
      const colIdx = prev.columns.findIndex(c => c.includes(fromPaneId))
      if (colIdx === -1) return prev
      const cols = [
        ...prev.columns.slice(0, colIdx + 1),
        [newPane.paneId],
        ...prev.columns.slice(colIdx + 1),
      ]
      const colWeights = [
        ...prev.colWeights.slice(0, colIdx + 1),
        prev.colWeights[colIdx] ?? 1,
        ...prev.colWeights.slice(colIdx + 1),
      ]
      const rowWeights = [
        ...prev.rowWeights.slice(0, colIdx + 1),
        [1],
        ...prev.rowWeights.slice(colIdx + 1),
      ]
      return { columns: cols, colWeights, rowWeights }
    })
  }, [onAddShell, setLayout])

  const handleSplitDown = useCallback((fromPaneId: string) => {
    const newPane = onAddShell()
    setLayout(prev => {
      const colIdx = prev.columns.findIndex(c => c.includes(fromPaneId))
      if (colIdx === -1) return prev
      const rowIdx = prev.columns[colIdx].indexOf(fromPaneId)
      const cols = prev.columns.map((col, i) => {
        if (i !== colIdx) return col
        return [...col.slice(0, rowIdx + 1), newPane.paneId, ...col.slice(rowIdx + 1)]
      })
      const rowWeights = prev.rowWeights.map((rw, i) => {
        if (i !== colIdx) return rw
        const w = rw[rowIdx] ?? 1
        return [...rw.slice(0, rowIdx + 1), w, ...rw.slice(rowIdx + 1)]
      })
      return { ...prev, columns: cols, rowWeights }
    })
  }, [onAddShell, setLayout])

  const onMenuPick = useCallback((id: string) => {
    if (!ctxMenu) return
    const { paneId } = ctxMenu
    const clipboardActions = clipboardActionsRef.current[paneId]
    setCtxMenu(null)
    if (id === 'copy')                { void clipboardActions?.copySelection(); return }
    if (id === 'paste')               { void clipboardActions?.pasteClipboard(); return }
    if (id === 'split-right')         { handleSplitRight(paneId);        return }
    if (id === 'open-terminal-right') { handleOpenTerminalRight(paneId); return }
    if (id === 'split-down')          { handleSplitDown(paneId);         return }
    if (id.startsWith('plugin-terminal:')) {
      const registrationId = id.slice('plugin-terminal:'.length)
      const watcher = pluginTerminalWatchers.find(candidate => candidate.registrationId === registrationId)
      if (watcher) onPluginTerminalWatcher?.(watcher, paneId)
      return
    }
    if (id === 'close')               { onClose(paneId);                 return }
  }, [ctxMenu, handleSplitRight, handleOpenTerminalRight, handleSplitDown, onClose, onPluginTerminalWatcher, pluginTerminalWatchers])

  useEffect(() => {
    const livePaneIds = new Set(panes.map(p => p.paneId))
    setCollapsedPanes(prev => {
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (livePaneIds.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [paneIdsKey])

  const setPaneCollapsed = useCallback((paneId: string, collapsed: boolean) => {
    setCollapsedPanes(prev => {
      const next = new Set(prev)
      if (collapsed) next.add(paneId)
      else next.delete(paneId)
      return next
    })
  }, [])

  const paneMap = Object.fromEntries(panes.map(p => [p.paneId, p]))
  const paneMenuItems = React.useMemo(() => {
    const hasSelection = !!ctxMenu && clipboardActionsRef.current[ctxMenu.paneId]?.hasSelection()
    return [
      ...PANE_MENU_BASE.map(item => item.id === 'copy' ? { ...item, disabled: !hasSelection } : item),
      ...(pluginTerminalWatchers.length ? [{ id: 'sep-plugin-terminal', label: '', divider: true } as ChatContextMenuItem] : []),
      ...pluginTerminalWatchers.map(watcher => ({ id: `plugin-terminal:${watcher.registrationId}`, label: watcher.title, icon: (watcher.icon as any) ?? 'terminal' } as ChatContextMenuItem)),
    ]
  }, [ctxMenu, pluginTerminalWatchers])

  const sessionDragOver = (event: React.DragEvent) => {
    if (!onSessionDrop || !isSessionDrag(event.dataTransfer.types)) return false
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setSessionDropActive(true)
    return true
  }

  return (
    <div
      className={`termcol-outer${sessionDropActive ? ' session-drop-target' : ''}`}
      onDragEnter={event => { sessionDragOver(event) }}
      onDragOver={event => { sessionDragOver(event) }}
      onDragLeave={event => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return
        setSessionDropActive(false)
      }}
      onDrop={event => {
        const payload = readSessionDrag(event.dataTransfer)
        if (!payload || !onSessionDrop) return
        event.preventDefault()
        event.stopPropagation()
        setSessionDropActive(false)
        onSessionDrop(payload)
      }}
    >
      <div className="termcol-grid">
        {layout.columns.map((col, colIdx) => (
          <React.Fragment key={colIdx}>
            <div className="termcol-col" style={{ flex: layout.colWeights[colIdx] ?? 1 }}>
              {col.map((paneId, rowIdx) => {
                const p = paneMap[paneId]
                if (!p) return null
                const paneCollapsed = collapsedPanes.has(paneId)
                return (
                  <React.Fragment key={paneId}>
                    <div
                      className={`termpane-slot ${paneCollapsed ? 'collapsed' : ''}${dropTargetPaneId === paneId && draggedPaneId !== paneId ? ' drop-target' : ''}${sessionDropActive ? ' session-drop-target' : ''}`}
                      style={{ flex: paneCollapsed ? '0 0 39px' : (layout.rowWeights[colIdx]?.[rowIdx] ?? 1) }}
                      onDragOver={event => {
                        if (sessionDragOver(event)) {
                          setDropTargetPaneId(paneId)
                          return
                        }
                        if (!draggedPaneId || draggedPaneId === paneId) return
                        event.preventDefault()
                        event.dataTransfer.dropEffect = 'move'
                        setDropTargetPaneId(paneId)
                      }}
                      onDragLeave={() => setDropTargetPaneId(current => current === paneId ? null : current)}
                      onDrop={event => handlePaneDrop(event, paneId)}
                      onContextMenu={e => {
                        e.preventDefault()
                        setCtxMenu({ paneId, x: e.clientX, y: e.clientY })
                      }}
                    >
                      <XTermPane
                        pane={p}
                        tabKind={tabKind}
                        active={active}
                        shell={p.shell ?? (p.agentId ? (agents.find(a => a.id === p.agentId)?.path ?? undefined) : undefined)}
                        argv={p.argv}
                        collapsed={paneCollapsed}
                        onCollapsedChange={(collapsed) => setPaneCollapsed(paneId, collapsed)}
                        onClose={() => onClose(paneId)}
                        onOpenUrl={onOpenUrl}
                        onHeaderDragStart={handlePaneHeaderDragStart}
                        onHeaderDragEnd={clearPaneDragState}
                        onClipboardActionsChange={(id, actions) => {
                          if (actions) clipboardActionsRef.current[id] = actions
                          else delete clipboardActionsRef.current[id]
                        }}
                      />
                    </div>
                    {rowIdx < col.length - 1 && (
                      <Splitter
                        orientation="horizontal"
                        onDrag={delta => onRowDrag(colIdx, rowIdx, rowIdx + 1, delta)}
                      />
                    )}
                  </React.Fragment>
                )
              })}
            </div>
            {colIdx < layout.columns.length - 1 && (
              <Splitter
                orientation="vertical"
                onDrag={delta => onColDrag(colIdx, colIdx + 1, delta)}
              />
            )}
          </React.Fragment>
        ))}
      </div>

      <div className="term-add-row">
        <button className="term-add" onClick={onAddShell} title="new shell">
          <Icon name="plus" size={11} /> shell
        </button>
        {available.map(a => (
          <button key={a.id} className="term-add" onClick={() => onAddAgent(a.id)} title={`new ${a.name}`}>
            <Icon name="plus" size={11} />
            {AGENT_ICONS[a.id]
              ? <img src={AGENT_ICONS[a.id]} alt={a.id} width={13} height={13} className={providerImageClass(a.id)} style={{ objectFit: 'contain', verticalAlign: 'middle' }} />
              : a.id
            }
          </button>
        ))}
        {onAddSsh && sshTargets.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button
              className="term-add"
              onClick={() => setSshMenuOpen(v => !v)}
              title="new ssh session"
            >
              <Icon name="plus" size={11} /> <Icon name="server" size={11} /> ssh
            </button>
            {sshMenuOpen && (
              <>
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 40 }}
                  onClick={() => setSshMenuOpen(false)}
                />
                <div
                  style={{
                    position: 'absolute',
                    bottom: 'calc(100% + 6px)',
                    right: 0,
                    minWidth: 220,
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 4,
                    zIndex: 50,
                    boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
                  }}
                >
                  {sshTargets.map(t => (
                    <button
                      key={t.id}
                      className="term-add"
                      style={{ display: 'flex', width: '100%', justifyContent: 'flex-start' }}
                      onClick={() => {
                        setSshMenuOpen(false)
                        onAddSsh(t.target)
                      }}
                    >
                      <Icon name="server" size={11} /> {t.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {ctxMenu && (
        <ChatContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={paneMenuItems}
          onPick={onMenuPick}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  )
}

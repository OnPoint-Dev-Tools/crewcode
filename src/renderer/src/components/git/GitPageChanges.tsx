import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Icon } from '../ui/Icon'
import { ChatContextMenu, type ChatContextMenuItem } from '../chat/ChatContextMenu'
import { PierreDiff } from '../diff/PierreDiff'
import type { GitChange } from './git-state'
import { getCrewCodeClient } from '../../runtime/crewcode-client'

interface GitPageChangesProps {
  repoPath: string
  comparisonRef?: string
  changes: GitChange[]
  hasUnpushed: boolean
  onStage?: (path: string) => void
  onUnstage?: (path: string) => void
  onStageAll?: (paths: string[]) => void
  onUnstageAll?: (paths: string[]) => void
  onDiscard?: (path: string) => void
}

interface SelectedChange {
  path: string
  staged: boolean
  title: string
}

function ChangeRow({ change, selected, onSelect, onStage, onUnstage, onContextMenu }: {
  change: GitChange
  selected: boolean
  onSelect: () => void
  onStage?: (path: string) => void
  onUnstage?: (path: string) => void
  onContextMenu: (event: MouseEvent, change: GitChange) => void
}) {
  return (
    <button type="button" className={`git-page-change ${change.staged ? 'staged' : ''} ${selected ? 'on' : ''}`} onClick={onSelect} onContextMenu={event => onContextMenu(event, change)}>
      <span className={`gs-file-status ${change.status}`}>{change.status}</span>
      <span className="git-page-change-path"><b>{change.name}</b><span>{change.dir}</span></span>
      <span className="gs-file-diff">
        {change.add ? <span className="add">+{change.add}</span> : null}
        {change.del ? <span className="del">−{change.del}</span> : null}
      </span>
      {change.stageable !== false && (
        <span
          role="button"
          tabIndex={0}
          className="gs-file-action"
          title={change.staged ? 'unstage' : 'stage'}
          onClick={event => {
            event.stopPropagation()
            change.staged ? onUnstage?.(change.path) : onStage?.(change.path)
          }}
          onKeyDown={event => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            event.stopPropagation()
            change.staged ? onUnstage?.(change.path) : onStage?.(change.path)
          }}
        >{change.staged ? '−' : '+'}</span>
      )}
    </button>
  )
}

export function GitPageChanges({ repoPath, comparisonRef, changes, hasUnpushed, onStage, onUnstage, onStageAll, onUnstageAll, onDiscard }: GitPageChangesProps) {
  const staged = useMemo(() => changes.filter(change => change.staged), [changes])
  const unstaged = useMemo(() => changes.filter(change => !change.staged), [changes])
  const [selected, setSelected] = useState<SelectedChange | null>(null)
  const [diff, setDiff] = useState<{ loading: boolean; patch: string; error?: string }>({ loading: false, patch: '' })
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; change: GitChange } | null>(null)

  useEffect(() => {
    const current = selected
      ? changes.find(change => change.path === selected.path && change.staged === selected.staged)
      : undefined
    if (!selected || !current) {
      const first = changes[0]
      setSelected(first ? {
        path: first.path,
        staged: first.staged,
        title: comparisonRef ? `vs ${comparisonRef}: ${first.path}` : `${first.staged ? 'staged' : 'unstaged'}: ${first.path}`,
      } : null)
      return
    }
    const title = comparisonRef ? `vs ${comparisonRef}: ${current.path}` : `${current.staged ? 'staged' : 'unstaged'}: ${current.path}`
    if (selected.title !== title) setSelected({ ...selected, title })
  }, [changes, comparisonRef, selected])

  useEffect(() => {
    let cancelled = false
    if (!selected) {
      setDiff({ loading: false, patch: '' })
      return
    }
    setDiff({ loading: true, patch: '' })
    const client = getCrewCodeClient()
    const request = comparisonRef
      ? client.gitDiffVsRef(repoPath, comparisonRef, selected.path)
      : client.gitDiff(repoPath, selected.path, selected.staged)
    request
      .then(result => {
        if (cancelled) return
        if (result?.error) setDiff({ loading: false, patch: '', error: result.error })
        else setDiff({ loading: false, patch: result?.diff ?? '' })
      })
      .catch(error => {
        if (!cancelled) setDiff({ loading: false, patch: '', error: String(error) })
      })
    return () => { cancelled = true }
  }, [repoPath, comparisonRef, selected])

  const select = (change: GitChange) => {
    setSelected({
      path: change.path,
      staged: change.staged,
      title: comparisonRef ? `vs ${comparisonRef}: ${change.path}` : `${change.staged ? 'staged' : 'unstaged'}: ${change.path}`,
    })
  }

  const openContextMenu = (event: MouseEvent, change: GitChange) => {
    event.preventDefault()
    select(change)
    setContextMenu({ x: event.clientX, y: event.clientY, change })
  }
  const runContextAction = (id: string) => {
    const change = contextMenu?.change
    if (!change) return
    if (id === 'stage') onStage?.(change.path)
    else if (id === 'stage-all') {
      const paths = unstaged.filter(file => file.stageable !== false).map(file => file.path)
      if (paths.length) onStageAll ? onStageAll(paths) : paths.forEach(path => onStage?.(path))
    } else if (id === 'unstage') onUnstage?.(change.path)
    else if (id === 'discard' && window.confirm(`Discard changes to ${change.path}? This cannot be undone.`)) onDiscard?.(change.path)
  }
  const contextItems: ChatContextMenuItem[] = [
    { id: 'stage', label: 'stage changes', icon: 'plus', disabled: contextMenu?.change.staged || contextMenu?.change.stageable === false },
    { id: 'stage-all', label: 'stage all changes', icon: 'plus', disabled: !unstaged.some(change => change.stageable !== false) },
    { id: 'unstage', label: 'unstage changes', icon: 'undo', disabled: !contextMenu?.change.staged },
    { id: 'discard', label: 'discard changes', icon: 'trash', disabled: !onDiscard },
  ]

  return (
    <section className="git-page-changes" aria-label="Changed files">
      <div className="git-page-changes-list">
        <div className="git-page-section-head compact">
          <div>
            <span className="git-page-eyebrow"><Icon name="gitCompare" size={12} /> {comparisonRef ? `Changes vs ${comparisonRef}` : 'Changes'}</span>
            <h2>{changes.length || 'No'} changed file{changes.length === 1 ? '' : 's'}</h2>
          </div>
          {hasUnpushed && <span className="git-page-chip">ahead</span>}
        </div>
        {staged.length > 0 && (
          <div className="git-page-change-group">
            <div className="gs-section-head">Staged · {staged.length}<button className="stage-toggle" onClick={() => onUnstageAll ? onUnstageAll(staged.map(c => c.path)) : staged.forEach(change => onUnstage?.(change.path))}>unstage all</button></div>
            {staged.map(change => <ChangeRow key={`s-${change.path}`} change={change} selected={selected?.path === change.path && selected.staged} onSelect={() => select(change)} onStage={onStage} onUnstage={onUnstage} onContextMenu={openContextMenu} />)}
          </div>
        )}
        {unstaged.length > 0 && (
          <div className="git-page-change-group">
            <div className="gs-section-head">
              {comparisonRef ? `Changes vs ${comparisonRef}` : 'Changes'} · {unstaged.length}
              {unstaged.some(change => change.stageable !== false) && (
                <button className="stage-toggle" onClick={() => {
                  const files = unstaged.filter(change => change.stageable !== false)
                  onStageAll ? onStageAll(files.map(change => change.path)) : files.forEach(change => onStage?.(change.path))
                }}>stage all</button>
              )}
            </div>
            {unstaged.map(change => <ChangeRow key={`u-${change.path}`} change={change} selected={selected?.path === change.path && !selected.staged} onSelect={() => select(change)} onStage={onStage} onUnstage={onUnstage} onContextMenu={openContextMenu} />)}
          </div>
        )}
        {changes.length === 0 && (
          <div className="git-page-clean">
            Working tree clean.{hasUnpushed ? ' Local branch is ahead of origin — push when ready.' : ''}
          </div>
        )}
      </div>
      {contextMenu && <ChatContextMenu x={contextMenu.x} y={contextMenu.y} items={contextItems} onPick={runContextAction} onClose={() => setContextMenu(null)} />}
      <div className="git-page-diff-pane">
        <div className="git-page-diff-head">
          <span>{selected?.title ?? 'No file selected'}</span>
        </div>
        <div className="git-page-diff-body">
          {diff.loading ? <div className="git-page-diff-state">loading diff…</div>
            : diff.error ? <div className="git-page-diff-state error">{diff.error}</div>
              : selected ? <PierreDiff patch={diff.patch} className="git-page-pierre" />
                : <div className="git-page-diff-state">Select a changed file to review its diff.</div>}
        </div>
      </div>
    </section>
  )
}

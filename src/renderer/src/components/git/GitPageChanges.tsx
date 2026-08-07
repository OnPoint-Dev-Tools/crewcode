import { useEffect, useMemo, useState } from 'react'
import { Icon } from '../ui/Icon'
import { PierreDiff } from '../diff/PierreDiff'
import type { GitChange } from './git-state'

interface GitPageChangesProps {
  repoPath: string
  changes: GitChange[]
  hasUnpushed: boolean
  onStage?: (path: string) => void
  onUnstage?: (path: string) => void
  onStageAll?: (paths: string[]) => void
  onUnstageAll?: (paths: string[]) => void
}

interface SelectedChange {
  path: string
  staged: boolean
  title: string
}

function ChangeRow({ change, selected, onSelect, onStage, onUnstage }: {
  change: GitChange
  selected: boolean
  onSelect: () => void
  onStage?: (path: string) => void
  onUnstage?: (path: string) => void
}) {
  return (
    <button type="button" className={`git-page-change ${change.staged ? 'staged' : ''} ${selected ? 'on' : ''}`} onClick={onSelect}>
      <span className={`gs-file-status ${change.status}`}>{change.status}</span>
      <span className="git-page-change-path"><b>{change.name}</b><span>{change.dir}</span></span>
      <span className="gs-file-diff">
        {change.add ? <span className="add">+{change.add}</span> : null}
        {change.del ? <span className="del">−{change.del}</span> : null}
      </span>
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
    </button>
  )
}

export function GitPageChanges({ repoPath, changes, hasUnpushed, onStage, onUnstage, onStageAll, onUnstageAll }: GitPageChangesProps) {
  const staged = useMemo(() => changes.filter(change => change.staged), [changes])
  const unstaged = useMemo(() => changes.filter(change => !change.staged), [changes])
  const [selected, setSelected] = useState<SelectedChange | null>(null)
  const [diff, setDiff] = useState<{ loading: boolean; patch: string; error?: string }>({ loading: false, patch: '' })

  useEffect(() => {
    if (!selected || changes.every(change => change.path !== selected.path || change.staged !== selected.staged)) {
      const first = changes[0]
      setSelected(first ? { path: first.path, staged: first.staged, title: `${first.staged ? 'staged' : 'unstaged'}: ${first.path}` } : null)
    }
  }, [changes, selected])

  useEffect(() => {
    let cancelled = false
    if (!selected) {
      setDiff({ loading: false, patch: '' })
      return
    }
    setDiff({ loading: true, patch: '' })
    window.electronAPI?.gitDiff(repoPath, selected.path, selected.staged)
      .then(result => {
        if (cancelled) return
        if (result?.error) setDiff({ loading: false, patch: '', error: result.error })
        else setDiff({ loading: false, patch: result?.diff ?? '' })
      })
      .catch(error => {
        if (!cancelled) setDiff({ loading: false, patch: '', error: String(error) })
      })
    return () => { cancelled = true }
  }, [repoPath, selected])

  const select = (change: GitChange) => {
    setSelected({ path: change.path, staged: change.staged, title: `${change.staged ? 'staged' : 'unstaged'}: ${change.path}` })
  }

  return (
    <section className="git-page-changes" aria-label="Changed files">
      <div className="git-page-changes-list">
        <div className="git-page-section-head compact">
          <div>
            <span className="git-page-eyebrow"><Icon name="gitCompare" size={12} /> Changes</span>
            <h2>{changes.length || 'No'} changed file{changes.length === 1 ? '' : 's'}</h2>
          </div>
          {hasUnpushed && <span className="git-page-chip">ahead</span>}
        </div>
        {staged.length > 0 && (
          <div className="git-page-change-group">
            <div className="gs-section-head">Staged · {staged.length}<button className="stage-toggle" onClick={() => onUnstageAll ? onUnstageAll(staged.map(c => c.path)) : staged.forEach(change => onUnstage?.(change.path))}>unstage all</button></div>
            {staged.map(change => <ChangeRow key={`s-${change.path}`} change={change} selected={selected?.path === change.path && selected.staged} onSelect={() => select(change)} onStage={onStage} onUnstage={onUnstage} />)}
          </div>
        )}
        {unstaged.length > 0 && (
          <div className="git-page-change-group">
            <div className="gs-section-head">Changes · {unstaged.length}<button className="stage-toggle" onClick={() => onStageAll ? onStageAll(unstaged.map(c => c.path)) : unstaged.forEach(change => onStage?.(change.path))}>stage all</button></div>
            {unstaged.map(change => <ChangeRow key={`u-${change.path}`} change={change} selected={selected?.path === change.path && !selected.staged} onSelect={() => select(change)} onStage={onStage} onUnstage={onUnstage} />)}
          </div>
        )}
        {changes.length === 0 && (
          <div className="git-page-clean">
            Working tree clean.{hasUnpushed ? ' Local branch is ahead of origin — push when ready.' : ''}
          </div>
        )}
      </div>
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

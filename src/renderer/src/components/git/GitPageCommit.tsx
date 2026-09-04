import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui/Icon'
import { clearGitTabMemory, readGitTabMemory, writeGitTabMemory, type GitCommitDraft } from './git-tab-memory'

type CommitMode = 'plain' | 'push' | 'sync'

interface GitPageCommitProps {
  memoryKey: string
  branch: string
  stagedCount: number
  onCommit?: (opts: { message: string; amend: boolean; push: boolean; sync?: boolean }) => Promise<boolean> | void
  onPush?: () => void
  onPull?: () => void
  onFetch?: () => void
  onSync?: () => void
}

export function GitPageCommit({ memoryKey, branch, stagedCount, onCommit, onPush, onPull, onFetch, onSync }: GitPageCommitProps) {
  const remembered = readGitTabMemory<GitCommitDraft>(memoryKey)
  const [message, setMessageState] = useState(remembered?.message ?? '')
  const [amend, setAmendState] = useState(remembered?.amend ?? false)
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null)
  const caretRef = useRef<HTMLButtonElement>(null)
  const canCommit = message.trim().length > 0 && (stagedCount > 0 || amend)

  const updateDraft = (nextMessage: string, nextAmend: boolean) => {
    setMessageState(nextMessage)
    setAmendState(nextAmend)
    writeGitTabMemory<GitCommitDraft>(memoryKey, { message: nextMessage, amend: nextAmend })
  }

  const commit = async (mode: CommitMode) => {
    if (!canCommit || !onCommit) return
    const completed = await onCommit({ message, amend, push: mode === 'push', sync: mode === 'sync' })
    if (completed === false) return
    updateDraft('', false)
    clearGitTabMemory(memoryKey)
  }

  const openMenu = () => {
    const rect = caretRef.current?.getBoundingClientRect()
    if (rect) setMenu({ top: rect.bottom + 4, left: Math.max(8, rect.right - 190) })
  }

  const items = [
    { label: 'push', icon: 'arrowUp' as const, run: () => onPush?.() },
    { label: 'commit & push', icon: 'gitCommit' as const, run: () => { void commit('push') }, disabled: !canCommit },
    { label: 'commit & sync', icon: 'refresh' as const, run: () => { void commit('sync') }, disabled: !canCommit },
    { label: 'pull', icon: 'arrowDown' as const, run: () => onPull?.() },
    { label: 'sync', icon: 'refresh' as const, run: () => onSync?.() },
    { label: 'fetch', icon: 'refresh' as const, run: () => onFetch?.() },
  ]

  return (
    <section className="git-page-commit" aria-label="Commit changes">
      <div className="git-page-section-head">
        <div>
          <span className="git-page-eyebrow"><Icon name="gitCommit" size={12} /> Commit</span>
          <h2>Prepare commit</h2>
        </div>
        <span className="git-page-chip">{stagedCount} staged</span>
      </div>
      <textarea
        value={message}
        onChange={event => updateDraft(event.target.value, amend)}
        placeholder={`commit message on ${branch || 'current branch'}\n\nbody (optional)`}
        rows={4}
      />
      <div className="git-page-commit-foot">
        <label className="git-page-amend">
          <input type="checkbox" checked={amend} onChange={event => updateDraft(message, event.target.checked)} />
          amend previous commit
        </label>
        <div className="git-page-commit-actions">
          <button className="gs-btn primary" disabled={!canCommit} onClick={() => { void commit('plain') }}>
            <Icon name="gitCommit" size={12} /> commit
          </button>
          <button ref={caretRef} className="gs-btn primary" onClick={() => (menu ? setMenu(null) : openMenu())} title="more commit actions">
            <Icon name="chevDown" size={12} />
          </button>
        </div>
      </div>
      {menu && createPortal(
        <>
          <div className="gs-menu-backdrop" onClick={() => setMenu(null)} />
          <div className="gs-menu" style={{ top: menu.top, left: menu.left }}>
            {items.map(item => (
              <button key={item.label} className="gs-menu-item" disabled={item.disabled} onClick={() => { item.run(); setMenu(null) }}>
                <Icon name={item.icon} size={11} />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </section>
  )
}

/* GitSidebar — CrewCode right-pane GitHub control surface.
 *
 * Stacked-card sidebar bound to the currently active worktree. All actions
 * are wired through props; useGitSidebar supplies real git + GitHub data.
 * See crewcode-git-sidebar/HANDOFF.md for the design brief. */
import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui/Icon'
import { PublishModal } from './PublishModal'
import { PullRequestModal } from './PullRequestModal'
import { PullRequestReview } from './PullRequestReview'
import type {
  GitState, GitChange, GitConflict, GitBranchRef, GitWorktreeRef, GitPrRef,
  GitHistoryEntry, GitBanner, GitSidebarWorkspace, GitSidebarHandlers,
  GitChatTarget,
} from './git-state'
import { NEW_CHAT_TARGET } from './git-state'
import { BranchPickerPanel, CreateBranchModal } from './BranchPicker'
import type { RegisteredPluginGitLens } from '../../../../shared/plugin-types'

/* ---------- Generic collapsible card ---------- */
interface GsCardProps {
  icon:     React.ComponentProps<typeof Icon>['name']
  title:    string
  count?:   number | null
  open:     boolean
  onToggle: () => void
  tone?:    string
  right?:   React.ReactNode
  children: React.ReactNode
}

function GsCard({ icon, title, count, open, onToggle, tone, children, right }: GsCardProps) {
  return (
    <div className={`gs-card ${open ? 'open' : ''} ${tone || ''}`}>
      <div className="gs-card-h" onClick={onToggle}>
        <div className="gs-card-icon"><Icon name={icon} /></div>
        <div className="gs-card-t">
          <span>{title}</span>
          {count != null && <span className="count">{count}</span>}
        </div>
        {right}
        <div className="gs-card-chev"><Icon name="chevRight" size={12} /></div>
      </div>
      <div className="gs-card-body">{children}</div>
    </div>
  )
}

/* ---------- Sync row (push / pull / fetch) ---------- */
interface SyncRowProps {
  ahead:     number
  behind:    number
  lastFetch: string
  fetching:  boolean
  onPush?:   () => void
  onPull?:   () => void
  onFetch?:  () => void
}

function SyncRow({ ahead, behind, lastFetch, fetching, onPush, onPull, onFetch }: SyncRowProps) {
  return (
    <div className="gs-sync">
      <button className={`gs-arrow ${ahead > 0 ? 'brand' : 'zero'}`} onClick={ahead > 0 ? onPush : undefined} title="Push">
        <Icon name="arrowUp" />{ahead}
      </button>
      <button className={`gs-arrow ${behind > 0 ? '' : 'zero'}`} onClick={behind > 0 ? onPull : undefined} title="Pull">
        <Icon name="arrowDown" />{behind}
      </button>
      <button className={`gs-fetch ${fetching ? 'spinning' : ''}`} onClick={onFetch}>
        <Icon name="refresh" />{fetching ? 'fetching…' : `${lastFetch} ago`}
      </button>
    </div>
  )
}

/* ---------- Top: repo / branch picker ---------- */
interface TopBarProps {
  workspace:         GitSidebarWorkspace
  branches:          GitBranchRef[]
  ahead:             number
  behind:            number
  lastFetch:         string
  fetching:          boolean
  remoteUrl?:        string
  onPush?:           () => void
  onPull?:           () => void
  onFetch?:          () => void
  onSync?:           () => void
  onCreatePR?:       () => void
  onOpenTerminal?:   (path: string) => void
  onCheckoutBranch?: (ref: string) => void
  onCreateBranch?:   (name: string) => void
  onClose?:          () => void
}

/** git/ssh remote → browsable https URL (git@host:org/repo.git → https://host/org/repo). */
function remoteWebUrl(remote: string): string | null {
  if (!remote) return null
  let u = remote.trim()
  const scp = u.match(/^git@([^:]+):(.+)$/)
  if (scp)            u = `https://${scp[1]}/${scp[2]}`
  else if (u.startsWith('ssh://')) u = u.replace(/^ssh:\/\/(?:git@)?/, 'https://')
  u = u.replace(/\.git$/, '')
  return /^https?:\/\//.test(u) ? u : `https://${u}`
}

function TopBar({ workspace, branches, ahead, behind, lastFetch, fetching, remoteUrl,
                  onPush, onPull, onFetch, onSync, onCreatePR, onOpenTerminal, onCheckoutBranch, onCreateBranch, onClose }: TopBarProps) {
  const [picker, setPicker] = useState(false)
  const [q, setQ] = useState('')
  const [createBranchOpen, setCreateBranchOpen] = useState(false)
  // null = closed; otherwise fixed viewport coords for the portaled actions menu.
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null)
  const moreRef = useRef<HTMLButtonElement>(null)

  const webUrl = remoteUrl ? remoteWebUrl(remoteUrl) : null
  const openMenu = () => {
    const r = moreRef.current?.getBoundingClientRect()
    if (r) setMenu({ top: r.bottom + 4, left: Math.max(8, r.right - 200) })
  }
  const openOnGitHub = () => { if (webUrl) window.electronAPI?.openExternal(webUrl) }

  const moreItems: Array<{ label: string; icon: React.ComponentProps<typeof Icon>['name']; run?: () => void; disabled?: boolean }> = [
    { label: 'fetch',               icon: 'refresh',        run: onFetch },
    { label: 'pull',                icon: 'arrowDown',      run: onPull },
    { label: 'push',                icon: 'arrowUp',        run: onPush },
    { label: 'sync',                icon: 'refresh',        run: onSync },
    { label: 'create pull request', icon: 'gitPullRequest', run: onCreatePR, disabled: !webUrl },
    { label: 'open on github',      icon: 'github',         run: openOnGitHub, disabled: !webUrl },
    { label: 'copy branch name',    icon: 'copy',           run: () => window.electronAPI?.clipboardWriteText(workspace.branch) },
  ]

  return (
    <div className="gs-top">
      <div className="gs-top-row">
        <div className="gs-title">Git · {workspace.name}</div>
        <div className="gs-top-actions">
          <button className="gs-ibtn" title="Open on GitHub" disabled={!webUrl} onClick={openOnGitHub}><Icon name="github" /></button>
          <button className="gs-ibtn" title="Open in terminal" disabled={!onOpenTerminal} onClick={() => onOpenTerminal?.(workspace.path)}><Icon name="terminal" /></button>
          <button ref={moreRef} className="gs-ibtn" title="More git actions"
                  onClick={() => (menu ? setMenu(null) : openMenu())}><Icon name="more" /></button>
          {onClose && <button className="gs-ibtn gs-mobile-close" title="Close Git sidebar" aria-label="Close Git sidebar" onClick={onClose}><Icon name="x" /></button>}
        </div>
      </div>

      <div className="gs-top-row">
        <button className="gs-branch" onClick={() => setPicker(p => !p)}>
          <Icon name="gitBranch" size={12} />
          <span className="name">{workspace.branch}</span>
          <Icon name="chevUpDown" size={11} className="chev" />
        </button>
      </div>

      <SyncRow ahead={ahead} behind={behind} lastFetch={lastFetch} fetching={fetching}
        onPush={onPush} onPull={onPull} onFetch={onFetch} />

      {picker && (
        <>
          <div className="gs-pop-backdrop" onClick={() => setPicker(false)} />
          <div className="gs-pop" onClick={e => e.stopPropagation()}>
            <BranchPickerPanel
              branches={branches}
              currentBranch={workspace.branch}
              query={q}
              onQueryChange={setQ}
              onCheckoutBranch={onCheckoutBranch}
              onCreateRequest={() => { setPicker(false); setCreateBranchOpen(true) }}
              onClose={() => setPicker(false)}
            />
          </div>
        </>
      )}

      <CreateBranchModal
        open={createBranchOpen}
        seed={q}
        sourceBranch={workspace.branch}
        onCreate={onCreateBranch}
        onClose={() => setCreateBranchOpen(false)}
      />

      {menu && createPortal(
        <>
          <div className="gs-menu-backdrop" onClick={() => setMenu(null)} />
          <div className="gs-menu" style={{ top: menu.top, left: menu.left }}>
            {moreItems.map(it => (
              <button
                key={it.label}
                className="gs-menu-item"
                disabled={it.disabled}
                onClick={() => { it.run?.(); setMenu(null) }}
              >
                <Icon name={it.icon} size={11} />
                <span>{it.label}</span>
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}

/* ---------- Commit: standalone composer card ---------- */
interface CommitBodyProps {
  branch:      string
  stagedCount: number
  onCommit?:   (opts: { message: string; amend: boolean; push: boolean; sync?: boolean }) => void
  onPush?:     () => void
  onPull?:     () => void
  onFetch?:    () => void
  onSync?:     () => void
}

type CommitMenuItem = {
  label:    string
  icon:     React.ComponentProps<typeof Icon>['name']
  run:      () => void
  disabled?: boolean
}

function CommitBody({ branch, stagedCount, onCommit, onPush, onPull, onFetch, onSync }: CommitBodyProps) {
  const [msg, setMsg] = useState('')
  const [amend, setAmend] = useState(false)
  // null = closed; otherwise the fixed viewport coords to anchor the menu at.
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null)
  const caretRef = useRef<HTMLButtonElement>(null)

  const hasMsg = msg.trim().length > 0
  const canCommit = (stagedCount > 0 || amend) && hasMsg

  const doCommit = (mode: 'plain' | 'push' | 'sync') => {
    onCommit?.({ message: msg, amend, push: mode === 'push', sync: mode === 'sync' })
    setMsg('')
    setAmend(false)
  }

  // The card clips its own overflow, so the menu is portaled to <body> and
  // anchored to the caret button's viewport rect.
  const openMenu = () => {
    const r = caretRef.current?.getBoundingClientRect()
    if (r) setMenu({ top: r.bottom + 4, left: r.right - 190 })
  }

  const items: CommitMenuItem[] = [
    { label: 'push',          icon: 'arrowUp',   run: () => onPush?.() },
    { label: 'commit & push', icon: 'gitCommit', run: () => doCommit('push'), disabled: !canCommit },
    { label: 'commit & sync', icon: 'refresh',   run: () => doCommit('sync'), disabled: !canCommit },
    { label: 'pull',          icon: 'arrowDown', run: () => onPull?.() },
    { label: 'sync',          icon: 'refresh',   run: () => onSync?.() },
    { label: 'fetch',         icon: 'refresh',   run: () => onFetch?.() },
  ]

  return (
    <div className="gs-commit">
      <textarea
        placeholder={`commit message on ${branch}\n\nbody (optional)`}
        value={msg}
        onChange={e => setMsg(e.target.value)}
        rows={5}
      />
      <div className="gs-commit-foot">
        <label className="gs-amend">
          <input type="checkbox" checked={amend} onChange={e => setAmend(e.target.checked)} />
          amend
        </label>
        <div className="gs-commit-btns">
          <button className="gs-btn primary split-main" disabled={!canCommit} onClick={() => doCommit('plain')}>
            <Icon name="gitCommit" />commit
          </button>
          <button
            ref={caretRef}
            className="gs-btn primary split-caret"
            title="more git actions"
            onClick={() => (menu ? setMenu(null) : openMenu())}
          >
            <Icon name="chevDown" size={11} />
          </button>
        </div>
      </div>

      {menu && createPortal(
        <>
          <div className="gs-menu-backdrop" onClick={() => setMenu(null)} />
          <div className="gs-menu" style={{ top: menu.top, left: menu.left }}>
            {items.map(it => (
              <button
                key={it.label}
                className="gs-menu-item"
                disabled={it.disabled}
                onClick={() => { it.run(); setMenu(null) }}
              >
                <Icon name={it.icon} size={11} />
                <span>{it.label}</span>
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}

/* ---------- Changes: staged / unstaged file lists ---------- */
interface ChangesBodyProps {
  changes:     GitChange[]
  hasUnpushed: boolean
  onStage?:    (path: string) => void
  onUnstage?:  (path: string) => void
  onStageAll?:   (paths: string[]) => void
  onUnstageAll?: (paths: string[]) => void
  onDiscard?:  (path: string) => void
  onOpenDiff?: (path: string, staged: boolean) => void
  comparisonRef?: string
}

function ChangesBody({ changes, onStage, onUnstage, onStageAll, onUnstageAll, hasUnpushed, onOpenDiff, comparisonRef }: ChangesBodyProps) {
  const staged = changes.filter(c => c.staged)
  const unstaged = changes.filter(c => !c.staged)
  const stageableUnstaged = unstaged.filter(c => c.stageable !== false)

  return (
    <>
      {staged.length > 0 && (
        <>
          <div className="gs-section-head">
            Staged · {staged.length}
            <button className="stage-toggle" onClick={() => onUnstageAll ? onUnstageAll(staged.map(f => f.path)) : staged.forEach(f => onUnstage?.(f.path))}>unstage all</button>
          </div>
          <div className="gs-changes-list">
            {staged.map(f => (
              <div
                key={'s-' + f.path}
                className="gs-file staged"
                title={`${f.dir}${f.name} — click to view diff`}
                onClick={() => onOpenDiff?.(f.path, true)}
              >
                <span className={`gs-file-status ${f.status}`}>{f.status}</span>
                <span className="gs-file-path"><span className="name">{f.name}</span>&nbsp;<span>{f.dir}</span></span>
                <span className="gs-file-diff">
                  {f.add ? <span className="add">+{f.add}</span> : null}
                  {f.del ? <span className="del">−{f.del}</span> : null}
                </span>
                <button
                  className="gs-file-action"
                  title="unstage"
                  onClick={e => { e.stopPropagation(); onUnstage?.(f.path) }}
                >−</button>
              </div>
            ))}
          </div>
        </>
      )}

      {unstaged.length > 0 && (
        <>
          <div className="gs-section-head">
            {comparisonRef ? `Changes vs ${comparisonRef}` : 'Changes'} · {unstaged.length}
            {stageableUnstaged.length > 0 && <button className="stage-toggle" onClick={() => onStageAll ? onStageAll(stageableUnstaged.map(f => f.path)) : stageableUnstaged.forEach(f => onStage?.(f.path))}>stage all</button>}
          </div>
          <div className="gs-changes-list">
            {unstaged.map(f => (
              <div
                key={'u-' + f.path}
                className="gs-file"
                title={`${f.dir}${f.name} — click to view diff`}
                onClick={() => onOpenDiff?.(f.path, false)}
              >
                <span className={`gs-file-status ${f.status}`}>{f.status}</span>
                <span className="gs-file-path"><span className="name">{f.name}</span>&nbsp;<span>{f.dir}</span></span>
                <span className="gs-file-diff">
                  {f.add ? <span className="add">+{f.add}</span> : null}
                  {f.del ? <span className="del">−{f.del}</span> : null}
                </span>
                {f.stageable !== false && (
                  <button
                    className="gs-file-action"
                    title="stage"
                    onClick={e => { e.stopPropagation(); onStage?.(f.path) }}
                  >+</button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {changes.length === 0 && (
        <div style={{ padding: '14px 12px', fontFamily: 'var(--font-family-mono)', fontSize: 11.5, color: 'var(--muted-foreground)' }}>
          Working tree clean.
          {hasUnpushed && ' Local branch is ahead of origin — push when ready.'}
        </div>
      )}
    </>
  )
}

/* ---------- Conflicts ---------- */
interface ConflictsBodyProps {
  conflicts:  GitConflict[]
  branch:     string
  chatTargets?: GitChatTarget[]
  onResolve?: (opts: { file: string; strategy: 'ours' | 'theirs' | 'editor' | 'agent'; targetTabId?: string }) => void
  onAbort?:   () => void
  onContinue?: () => void
}

function ConflictsBody({ conflicts, branch, chatTargets = [], onResolve, onAbort, onContinue }: ConflictsBodyProps) {
  // Which conflict row's "ask agent" menu is open (by path). Only relevant when
  // there are chat tabs to choose between; otherwise the button resolves directly.
  const [agentMenuFor, setAgentMenuFor] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!agentMenuFor) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setAgentMenuFor(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAgentMenuFor(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [agentMenuFor])

  const askAgent = (file: string, targetTabId?: string) => {
    setAgentMenuFor(null)
    onResolve?.({ file, strategy: 'agent', targetTabId })
  }

  return (
    <>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)',
                    fontFamily: 'var(--font-family-mono)', fontSize: 11, color: 'var(--muted-foreground)' }}>
        Merge in progress on <code style={{ color: 'var(--foreground)' }}>{branch}</code>.
        Resolve each file, then continue.
      </div>
      <div className="gs-conflicts">
        {conflicts.map(c => (
          <div key={c.path} className="gs-conflict-row">
            <div className="gs-conflict-head">
              <span className="pill">conflict</span>
              <span className="path">{c.path}</span>
              {c.hunks > 0 && <span className="lines">{c.hunks} hunk{c.hunks === 1 ? '' : 's'}</span>}
            </div>
            <div className="gs-conflict-actions">
              <button className="gs-btn tiny" onClick={() => onResolve?.({ file: c.path, strategy: 'editor' })}>
                <Icon name="gitCompare" />open merge editor
              </button>
              <button className="gs-btn tiny ghost" onClick={() => onResolve?.({ file: c.path, strategy: 'ours' })}>
                use ours
              </button>
              <button className="gs-btn tiny ghost" onClick={() => onResolve?.({ file: c.path, strategy: 'theirs' })}>
                use theirs
              </button>
              {chatTargets.length === 0 ? (
                // No chat tabs to choose from — route to the active tab directly.
                <button className="gs-btn tiny ghost" onClick={() => askAgent(c.path)}>
                  <Icon name="play" />ask agent
                </button>
              ) : (
                <div
                  className="gs-agent-pick"
                  style={{ position: 'relative' }}
                  ref={agentMenuFor === c.path ? menuRef : undefined}
                >
                  <button
                    className="gs-btn tiny ghost"
                    onClick={() => setAgentMenuFor(agentMenuFor === c.path ? null : c.path)}
                  >
                    <Icon name="play" />ask agent
                    <Icon name="chevDown" />
                  </button>
                  {agentMenuFor === c.path && (
                    <div className="gs-agent-menu" role="menu">
                      <div className="gs-agent-menu-head">send to</div>
                      {chatTargets.map(t => (
                        <button
                          key={t.id}
                          className="gs-agent-menu-item"
                          role="menuitem"
                          onClick={() => askAgent(c.path, t.id)}
                        >
                          <Icon name="chat" />
                          <span className="gs-agent-menu-label">{t.label}</span>
                        </button>
                      ))}
                      <button
                        className="gs-agent-menu-item is-new"
                        role="menuitem"
                        onClick={() => askAgent(c.path, NEW_CHAT_TARGET)}
                      >
                        <Icon name="plus" />
                        <span className="gs-agent-menu-label">new chat</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)',
                    background: 'var(--background)', display: 'flex', gap: 6 }}>
        <button className="gs-btn warn" onClick={onContinue}>
          <Icon name="check" />continue merge
        </button>
        <button className="gs-btn danger" onClick={onAbort} style={{ marginLeft: 'auto' }}>
          <Icon name="undo" />abort
        </button>
      </div>
    </>
  )
}

/* ---------- Worktrees ---------- */
interface WorktreesBodyProps {
  worktrees: GitWorktreeRef[]
  current:   string
  onSwitch?: (id: string) => void
  onMerge?:  (opts: { from: string; into: string }) => void
  onCreate?: (branch: string) => void
  onRemove?: (id: string) => void
}

function WorktreesBody({ worktrees, current, onSwitch, onMerge, onCreate, onRemove }: WorktreesBodyProps) {
  const [mergeTarget, setMergeTarget] = useState<GitWorktreeRef | null>(null)
  const [newWt, setNewWt] = useState<string | null>(null)
  const cur = worktrees.find(w => w.id === current)
  const mergeable = worktrees.filter(w => w.id !== current)

  return (
    <>
      <div className="gs-wt">
        {worktrees.map(w => (
          <div key={w.id} className={`gs-wt-row ${w.id === current ? 'current' : ''}`}
               onClick={() => w.id !== current && onSwitch?.(w.id)}>
            <span className={`gs-wt-dot ${w.dirty ? 'warn' : w.behind ? 'behind' : ''}`} />
            <div className="gs-wt-meta">
              <div className="gs-wt-branch">
                {w.branch}
                {w.id === current && <span className="you">here</span>}
              </div>
              <div className="gs-wt-sub">
                <span>{w.path}</span>
              </div>
              <div className="gs-wt-sub">
                {w.dirty > 0 && <span className="dirty">● {w.dirty} dirty</span>}
                {w.ahead > 0 && <span className="ahead">↑{w.ahead}</span>}
                {w.behind > 0 && <span className="behind">↓{w.behind}</span>}
                {w.agent && <span>· {w.agent}</span>}
              </div>
            </div>
            <div className="gs-wt-actions" onClick={e => e.stopPropagation()}>
              <button className="gs-ibtn" title="Open in editor"><Icon name="external" /></button>
              <button className="gs-ibtn" title="Remove worktree" onClick={() => onRemove?.(w.id)}><Icon name="trash" /></button>
            </div>
          </div>
        ))}
        {newWt === null ? (
          <div className="gs-wt-new" onClick={() => setNewWt('')}>
            <Icon name="plus" />new worktree…
          </div>
        ) : (
          <div className="gs-wt-new gs-wt-new-input">
            <Icon name="gitBranch" />
            <input
              autoFocus
              value={newWt}
              placeholder="branch for new worktree — enter to create"
              onChange={e => setNewWt(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && newWt.trim()) {
                  onCreate?.(newWt.trim())
                  setNewWt(null)
                } else if (e.key === 'Escape') {
                  setNewWt(null)
                }
              }}
            />
          </div>
        )}
      </div>

      <div className="gs-merge-bar">
        <span className="label">merge</span>
        <span className="target" onClick={() => {
          const idx = mergeTarget ? mergeable.findIndex(w => w.id === mergeTarget.id) : -1
          const next = mergeable[(idx + 1) % mergeable.length]
          setMergeTarget(next || null)
        }}>
          <Icon name="gitBranch" />
          {mergeTarget ? mergeTarget.branch : (mergeable[0]?.branch || 'select…')}
          <Icon name="chevDown" size={10} />
        </span>
        <span className="label">→ {cur?.branch}</span>
        <button className="gs-btn tiny primary"
          disabled={!mergeable.length}
          onClick={() => {
            const from = (mergeTarget || mergeable[0])?.id
            if (from) onMerge?.({ from, into: current })
          }}>
          <Icon name="gitMerge" />merge
        </button>
      </div>
    </>
  )
}

/* ---------- Pull Requests ---------- */
interface PullRequestsBodyProps {
  prs:         GitPrRef[]
  branch:      string
  hasUnpushed: boolean
  onCreate?:   () => void
  onOpen?:     (num: number) => void
  onReviewOpen?: (pr: GitPrRef) => void
}

function PullRequestsBody({ prs, branch, hasUnpushed, onCreate, onOpen, onReviewOpen }: PullRequestsBodyProps) {
  const branchPr = prs.find(p => p.head === branch)
    const [selectedNum, setSelectedNum] = useState<number | null>(branchPr?.num ?? prs[0]?.num ?? null)
  const selectedPr = prs.find(p => p.num === selectedNum) ?? branchPr ?? prs[0] ?? null

  useEffect(() => {
    if (branchPr) setSelectedNum(branchPr.num)
  }, [branch, branchPr?.num])

  useEffect(() => {
      if (!selectedPr && prs[0]) setSelectedNum(prs[0].num)
    }, [prs, selectedPr])

    const statusName = (status: GitPrRef['status']): React.ComponentProps<typeof Icon>['name'] =>
      status === 'open' ? 'circleDot' : status === 'merged' ? 'merged' : status === 'draft' ? 'gitPullRequest' : 'x'
    const passed = selectedPr?.checks?.filter(check => check === 'ok').length ?? 0
    const failed = selectedPr?.checks?.filter(check => check === 'f').length ?? 0
    const pending = selectedPr?.checks?.filter(check => check === 'p').length ?? 0

    if (!selectedPr) {
      return (
        <div className="pr-single-empty">
          <span><Icon name="gitPullRequest" size={18} /></span>
          <strong>No open pull requests</strong>
          <p>Create one PR for <code>{branch}</code> and keep the full review inside CrewCode.</p>
          <button className="gs-btn primary" onClick={onCreate}><Icon name="plus" size={11} />Create pull request</button>
        </div>
      )
    }

    return (
      <div className="pr-single">
        {prs.length > 1 && (
          <label className="pr-single-picker">
            <span>Pull request</span>
            <select value={selectedPr.num} onChange={event => setSelectedNum(Number(event.target.value))}>
              {prs.map(pr => <option key={pr.num} value={pr.num}>#{pr.num} · {pr.title}</option>)}
            </select>
          </label>
        )}

        <div className="pr-single-identity">
          <div className="pr-single-state"><Icon name={statusName(selectedPr.status)} size={11} />{selectedPr.status}<code>#{selectedPr.num}</code></div>
          <h3>{selectedPr.title}</h3>
          <p><strong>{selectedPr.author || 'unknown'}</strong> wants to merge</p>
          <div className="pr-single-route"><code>{selectedPr.head}</code><Icon name="chevRight" size={10} /><code>{selectedPr.base}</code></div>
        </div>

        <div className="pr-single-evidence">
          <div><span>Checks</span><strong className={failed ? 'bad' : ''}>{failed ? `${failed} failing` : selectedPr.checks?.length ? `${passed}/${selectedPr.checks.length} passed` : 'None'}</strong></div>
          <div><span>Pending</span><strong>{pending}</strong></div>
          <div><span>Merge state</span><strong className={selectedPr.mergeStateStatus?.toLowerCase()}>{(selectedPr.mergeStateStatus ?? 'unknown').toLowerCase().replaceAll('_', ' ')}</strong></div>
        </div>

        <div className={`pr-single-description ${selectedPr.body ? '' : 'empty'}`}>{selectedPr.body || 'No description provided.'}</div>

        <div className="pr-single-actions">
          <button className="gs-btn primary" onClick={() => onReviewOpen?.(selectedPr)}><Icon name="inspection" size={11} />Review in CrewCode</button>
          <button className="gs-btn ghost" onClick={() => onOpen?.(selectedPr.num)}><Icon name="external" size={10} />GitHub</button>
        </div>

        <div className="pr-single-new">
          <span>{hasUnpushed ? `${branch} has unpushed commits` : `Working on ${branch}`}</span>
          <button onClick={onCreate}><Icon name="plus" size={10} />New PR</button>
        </div>
      </div>
    )
}

/* ---------- History ---------- */
function HistoryBody({ history, onCheckout }: { history: GitHistoryEntry[]; onCheckout?: (sha: string) => void }) {
  return (
    <div className="gs-hist">
      {history.map((c, i) => (
        <div key={i} className="gs-hist-row" onClick={() => onCheckout?.(c.sha)}>
          <span className={`gs-hist-dot ${c.you ? 'you' : ''} ${c.merge ? 'merge' : ''}`} />
          <div>
            <div className="gs-hist-msg">{c.msg}</div>
            <div className="gs-hist-meta">
              <span className="sha">{c.sha.slice(0, 7)}</span>
              <span>·</span>
              <span>{c.author}</span>
              {c.tag && <><span>·</span><span><Icon name="tag" size={9} /> {c.tag}</span></>}
            </div>
          </div>
          <div className="gs-hist-right">{c.when}</div>
        </div>
      ))}
    </div>
  )
}

/* ---------- Main sidebar shell ---------- */
export interface GitSidebarProps extends GitSidebarHandlers {
  workspace: GitSidebarWorkspace
  state:     GitState
  width?:    number
  hideTop?:  boolean
  hideSections?: Partial<Record<'commit' | 'changes', boolean>>
  /** Chat tabs the "ask agent" conflict action can route to. Empty → plain button. */
  chatTargets?: GitChatTarget[]
  onOpenTerminal?: (path: string) => void
  pluginGitLenses?: RegisteredPluginGitLens[]
  onPluginGitLens?: (target: { pluginId: string; sidebarPanel?: string; tab?: string; command?: string }) => void
  /** Mobile overlay close action. Omitted for the persistent desktop/sidebar page variants. */
  onClose?: () => void
}

export function GitSidebar({
  workspace,
  state,
  width = 380,
  hideTop = false,
  hideSections = {},
  chatTargets = [],
  onPush, onPull, onFetch, onSync, onCheckoutBranch, onCreateBranch,
  onStageFile, onUnstageFile, onStageAll, onUnstageAll, onDiscardFile, onOpenFileDiff, onCommit,
  onCreateWorktree, onSwitchWorktree, onMergeWorktree, onRemoveWorktree,
  onResolveConflict, onAbortMerge, onContinueMerge,
  onCreatePR, onOpenPR, onMergePR,
  onUpdatePRBranch, onClosePR, onReviewPR,
  onInitRepo, onPublish,
  onOpenTerminal,
  pluginGitLenses = [],
  onPluginGitLens,
  onClose,
}: GitSidebarProps) {
  const hasConflicts = (state.conflicts || []).length > 0
  // A remote can exist after a partial publish while the branch was never pushed.
  const needsPublish = state.hasRemote === false || state.hasUpstream === false
  const notRepo      = state.isRepo === false
  const noCommits    = (state.history || []).length === 0
  const [publishOpen, setPublishOpen] = useState(false)
  const [prCreateOpen, setPrCreateOpen] = useState(false)
  const [reviewPr, setReviewPr] = useState<GitPrRef | null>(null)

  // Open which cards by default — conflicts always; changes when dirty; others closed.
  const [open, setOpen] = useState({
    commit:    (state.changes || []).length > 0,
    changes:   (state.changes || []).length > 0,
    conflicts: hasConflicts,
    worktrees: false,
    prs:       false,
    history:   false,
  })
  const toggle = (k: keyof typeof open) => setOpen(o => ({ ...o, [k]: !o[k] }))

  // Conflicts auto-open — most important thing on screen during a merge.
  useEffect(() => { if (hasConflicts) setOpen(o => ({ ...o, conflicts: true })) }, [hasConflicts])

  const [fetching, setFetching] = useState(false)
  const handleFetch = () => {
    setFetching(true)
    onFetch?.()
    setTimeout(() => setFetching(false), 1200)
  }

  const [banner, setBanner] = useState<GitBanner | null>(null)
  useEffect(() => {
    if (state.banner) {
      setBanner(state.banner)
      if (state.banner.auto) {
        const t = setTimeout(() => setBanner(null), state.banner.auto)
        return () => clearTimeout(t)
      }
    } else {
      setBanner(null)
    }
  }, [state.banner])

  return (
    <aside
      className="gs"
      style={{ ['--gs-width' as string]: `${width}px` } as React.CSSProperties}
      role={onClose ? 'dialog' : undefined}
      aria-modal={onClose ? true : undefined}
      aria-label={onClose ? 'Git sidebar' : undefined}
    >
      {!hideTop && (
        <TopBar
          workspace={workspace}
          branches={state.branches || []}
          ahead={state.ahead || 0}
          behind={state.behind || 0}
          lastFetch={state.lastFetch || 'never'}
          fetching={fetching}
          remoteUrl={state.remoteUrl}
          onPush={onPush}
          onPull={onPull}
          onFetch={handleFetch}
          onSync={onSync}
          onCreatePR={() => setPrCreateOpen(true)}
          onOpenTerminal={onOpenTerminal}
          onCheckoutBranch={onCheckoutBranch}
          onCreateBranch={onCreateBranch}
          onClose={onClose}
        />
      )}

      {banner && (
        <div className={`gs-banner ${banner.kind || ''}`}>
          {banner.spinning && <span className="spinner" />}
          <span>{banner.text}</span>
          <span className="close-x" onClick={() => setBanner(null)}><Icon name="x" size={11} /></span>
        </div>
      )}

      <div className="gs-body">
        {notRepo ? (
          <div className="gs-publish">
            <div className="gs-publish-icon"><Icon name="gitBranch" size={18} /></div>
            <div className="gs-publish-t">Not a git repository yet</div>
            <div className="gs-publish-sub">
              Initialize git for <code>{workspace.name}</code> to start tracking changes.
            </div>
            <button className="gs-btn primary gs-publish-btn" onClick={() => onInitRepo?.()}>
              <Icon name="gitBranch" size={12} />Initialize repository
            </button>
          </div>
        ) : needsPublish ? (
          <div className="gs-publish">
            <div className="gs-publish-icon"><Icon name="github" size={18} /></div>
            <div className="gs-publish-t">No remote configured</div>
            <div className="gs-publish-sub">
              {noCommits
                ? <>Publish <code>{workspace.name}</code> to GitHub — creates the first commit, repository, and pushes it.</>
                : <>Publish <code>{workspace.name}</code> to GitHub — creates the repo, wires up origin, and pushes.</>}
            </div>
            <button
              className="gs-btn primary gs-publish-btn"
              onClick={() => setPublishOpen(true)}
            >
              <Icon name="github" size={12} />Publish to GitHub
            </button>
          </div>
        ) : null}

        {pluginGitLenses.length > 0 && (
          <GsCard
            icon="alert"
            title="Plugin lenses"
            count={pluginGitLenses.length}
            open={true}
            onToggle={() => {}}
          >
            <div style={{ display: 'grid', gap: 6 }}>
              {pluginGitLenses.map(lens => (
                <button key={lens.registrationId} className="gs-btn" onClick={() => onPluginGitLens?.(lens)} title={`${lens.title} · ${lens.pluginId}`}>
                  <Icon name={(lens.icon as any) ?? 'alert'} size={12} />{lens.title}
                </button>
              ))}
            </div>
          </GsCard>
        )}

        {hasConflicts && (
          <GsCard
            icon="alert"
            title="Conflicts"
            count={state.conflicts.length}
            open={open.conflicts}
            onToggle={() => toggle('conflicts')}
            tone="attn"
          >
            <ConflictsBody
              conflicts={state.conflicts}
              branch={workspace.branch}
              chatTargets={chatTargets}
              onResolve={onResolveConflict}
              onAbort={onAbortMerge}
              onContinue={onContinueMerge}
            />
          </GsCard>
        )}

        {!hideSections.commit && (
          <GsCard
            icon="gitCommit"
            title="Commit"
            open={open.commit}
            onToggle={() => toggle('commit')}
          >
            <CommitBody
              branch={workspace.branch}
              stagedCount={(state.changes || []).filter(c => c.staged).length}
              onCommit={onCommit}
              onPush={onPush}
              onPull={onPull}
              onFetch={onFetch}
              onSync={onSync}
            />
          </GsCard>
        )}

        {!hideSections.changes && (
          <GsCard
            icon="gitCompare"
            title={state.comparisonRef ? `Changes vs ${state.comparisonRef}` : 'Changes'}
            count={(state.changes || []).length || null}
            open={open.changes}
            onToggle={() => toggle('changes')}
          >
            <ChangesBody
              changes={state.changes || []}
              hasUnpushed={state.ahead > 0}
              onStage={onStageFile}
              onUnstage={onUnstageFile}
              onStageAll={onStageAll}
              onUnstageAll={onUnstageAll}
              onDiscard={onDiscardFile}
              onOpenDiff={onOpenFileDiff}
              comparisonRef={state.comparisonRef}
            />
          </GsCard>
        )}

        <GsCard
          icon="gitBranch"
          title="Worktrees"
          count={(state.worktrees || []).length}
          open={open.worktrees}
          onToggle={() => toggle('worktrees')}
        >
          <WorktreesBody
            worktrees={state.worktrees || []}
            current={state.currentWorktree}
            onSwitch={onSwitchWorktree}
            onMerge={onMergeWorktree}
            onCreate={onCreateWorktree}
            onRemove={onRemoveWorktree}
          />
        </GsCard>

        <GsCard
          icon="gitPullRequest"
          title="Pull Requests"
          count={(state.prs || []).length}
          open={open.prs}
          onToggle={() => toggle('prs')}
        >
          <PullRequestsBody
            prs={state.prs || []}
            branch={workspace.branch}
            hasUnpushed={state.ahead > 0}
            onCreate={() => setPrCreateOpen(true)}
            onOpen={onOpenPR}
            onReviewOpen={setReviewPr}
          />
        </GsCard>

        <GsCard
          icon="history"
          title="History"
          count={(state.history || []).length}
          open={open.history}
          onToggle={() => toggle('history')}
        >
          <HistoryBody history={state.history || []} onCheckout={() => {}} />
        </GsCard>
      </div>

      <div className="gs-foot">
        <span className="dot live" />
        <span>{workspace.user || 'you'}@origin</span>
        <span style={{ color: '#5a625a' }}>·</span>
        <span>{state.remoteUrl || 'no remote'}</span>
      </div>

      <PublishModal
        open={publishOpen}
        defaultName={workspace.name}
        onPublish={async opts => (await onPublish?.(opts)) ?? false}
        onClose={() => setPublishOpen(false)}
      />
      <PullRequestModal
        open={prCreateOpen}
        repoPath={workspace.path}
        head={workspace.branch}
        branches={(state.branches || []).map(branch => branch.name.replace(/^origin\//, ''))}
        defaultBase={state.defaultBase || state.comparisonRef || 'main'}
        defaultTitle={state.history?.[0]?.msg || workspace.branch.replace(/[-_/]+/g, ' ')}
        onCreate={async options => (await onCreatePR?.(options))?.ok ?? false}
        onClose={() => setPrCreateOpen(false)}
      />
      <PullRequestReview
        open={!!reviewPr}
        repoPath={workspace.path}
        pr={reviewPr}
        onMerge={onMergePR}
        onUpdateBranch={onUpdatePRBranch}
        onClosePr={onClosePR}
        onReview={onReviewPR}
        onClose={() => setReviewPr(null)}
      />
    </aside>
  )
}

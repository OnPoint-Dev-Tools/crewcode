import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui/Icon'
import { GitSidebar, type GitSidebarProps } from './GitSidebar'
import { BranchPickerPanel, CreateBranchModal } from './BranchPicker'
import { GitPageChanges } from './GitPageChanges'
import { GitPageCommit } from './GitPageCommit'
import { PullRequestModal } from './PullRequestModal'
import { PullRequestBrowser } from './PullRequestBrowser'

function remoteWebUrl(remote: string): string | null {
  if (!remote) return null
  let url = remote.trim()
  const scp = url.match(/^git@([^:]+):(.+)$/)
  if (scp) url = `https://${scp[1]}/${scp[2]}`
  else if (url.startsWith('ssh://')) url = url.replace(/^ssh:\/\/(?:git@)?/, 'https://')
  url = url.replace(/\.git$/, '')
  return /^https?:\/\//.test(url) ? url : `https://${url}`
}

export function GitPage(props: GitSidebarProps) {
  const {
    workspace, state, onCommit, onPush, onPull, onFetch, onSync, onStageFile, onUnstageFile,
    onStageAll, onUnstageAll, onDiscardFile,
    onCheckoutBranch, onCreateBranch, onCreatePR, onMergePR, onUpdatePRBranch,
    onReadyPR, onDraftPR, onReopenPR, onEditPR, onMetadataPR, onRerunPRCheck, onMergeAutomationPR, onPreparePRConflicts, onClosePR, onReviewPR, onOpenTerminal,
  } = props
  const staged = (state.changes || []).filter(change => change.staged).length
  const unstaged = Math.max(0, (state.changes || []).length - staged)
  const conflicts = (state.conflicts || []).length
  const prs = (state.prs || []).length
  const history = (state.history || []).length
  const webUrl = state.remoteUrl ? remoteWebUrl(state.remoteUrl) : null

  const [branchOpen, setBranchOpen] = useState(false)
  const [branchQuery, setBranchQuery] = useState('')
  const [createBranchOpen, setCreateBranchOpen] = useState(false)
  const [createPrOpen, setCreatePrOpen] = useState(false)
  const [prBrowserOpen, setPrBrowserOpen] = useState(false)
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null)
  const moreRef = useRef<HTMLButtonElement>(null)

  const openMenu = () => {
    const rect = moreRef.current?.getBoundingClientRect()
    if (rect) setMenu({ top: rect.bottom + 4, left: Math.max(8, rect.right - 210) })
  }
  const openOnGitHub = () => { if (webUrl) window.electronAPI?.openExternal(webUrl) }

  const menuItems = [
    { label: 'fetch', icon: 'refresh' as const, run: onFetch },
    { label: 'pull', icon: 'arrowDown' as const, run: onPull },
    { label: 'push', icon: 'arrowUp' as const, run: onPush },
    { label: 'sync', icon: 'refresh' as const, run: onSync },
    { label: 'create pull request', icon: 'gitPullRequest' as const, run: () => setCreatePrOpen(true), disabled: !webUrl },
    { label: 'open on github', icon: 'github' as const, run: openOnGitHub, disabled: !webUrl },
    { label: 'open terminal here', icon: 'terminal' as const, run: () => onOpenTerminal?.(workspace.path), disabled: !onOpenTerminal },
    { label: 'copy branch name', icon: 'copy' as const, run: () => window.electronAPI?.clipboardWriteText(workspace.branch) },
  ]

  return (
    <section className="git-page" aria-label="Git workspace">
      <header className="git-page-hero">
        <div className="git-page-title-block">
          <div className="git-page-eyebrow"><Icon name="gitBranch" size={12} /> Git Workspace</div>
          <div className="git-page-title-row">
            <h1>{workspace.name}</h1>
            <button type="button" className="git-page-branch-inline" onClick={() => setBranchOpen(open => !open)}>
              <Icon name="gitBranch" size={11} />
              <span>{workspace.branch || '—'}</span>
              <Icon name="chevDown" size={10} />
            </button>
          </div>
          <p>{workspace.path}</p>
        </div>
        <div className="git-page-header-tools" aria-label="Git actions">
          <button type="button" className="git-page-pr-browser-button" onClick={() => setPrBrowserOpen(true)} disabled={!webUrl}><Icon name="gitPullRequest" size={12} />Pull requests</button>
          <div className="git-page-sync-strip" aria-label="Git sync status">
            <span><Icon name="arrowUp" size={10} />{state.ahead || 0}</span>
            <span><Icon name="arrowDown" size={10} />{state.behind || 0}</span>
            <span>{state.remoteUrl || 'no remote'}</span>
          </div>
          <button ref={moreRef} type="button" className="git-page-more" onClick={() => (menu ? setMenu(null) : openMenu())} title="More git actions">
            <Icon name="more" size={14} />
          </button>
        </div>

        {branchOpen && (
          <>
            <div className="gs-pop-backdrop" onClick={() => setBranchOpen(false)} />
            <div className="gs-pop git-page-branch-pop" onClick={event => event.stopPropagation()}>
              <BranchPickerPanel
                branches={state.branches || []}
                currentBranch={workspace.branch}
                query={branchQuery}
                onQueryChange={setBranchQuery}
                onCheckoutBranch={onCheckoutBranch}
                onCreateRequest={() => { setBranchOpen(false); setCreateBranchOpen(true) }}
                onClose={() => setBranchOpen(false)}
              />
            </div>
          </>
        )}

        <CreateBranchModal
          open={createBranchOpen}
          seed={branchQuery}
          sourceBranch={workspace.branch}
          onCreate={onCreateBranch}
          onClose={() => setCreateBranchOpen(false)}
        />
        <PullRequestModal
          open={createPrOpen}
          repoPath={workspace.path}
          head={workspace.branch}
          branches={(state.branches || []).map(branch => branch.name.replace(/^origin\//, ''))}
          defaultBase={state.defaultBase || state.comparisonRef || 'main'}
          defaultTitle={state.history?.[0]?.msg || workspace.branch.replace(/[-_/]+/g, ' ')}
          onCreate={async options => (await onCreatePR?.(options))?.ok ?? false}
          onClose={() => setCreatePrOpen(false)}
        />
        <PullRequestBrowser
          open={prBrowserOpen}
          repoPath={workspace.path}
          currentBranch={workspace.branch}
          onMerge={onMergePR}
          onUpdateBranch={onUpdatePRBranch}
          onReady={onReadyPR}
          onDraft={onDraftPR}
          onReopen={onReopenPR}
          onEdit={onEditPR}
          onMetadata={onMetadataPR}
          onRerunCheck={onRerunPRCheck}
          onMergeAutomation={onMergeAutomationPR}
          onPrepareConflicts={onPreparePRConflicts}
          onClosePr={onClosePR}
          onReview={onReviewPR}
          onClose={() => setPrBrowserOpen(false)}
        />

        {menu && createPortal(
          <>
            <div className="gs-menu-backdrop" onClick={() => setMenu(null)} />
            <div className="gs-menu" style={{ top: menu.top, left: menu.left }}>
              {menuItems.map(item => (
                <button key={item.label} className="gs-menu-item" disabled={item.disabled} onClick={() => { item.run?.(); setMenu(null) }}>
                  <Icon name={item.icon} size={11} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
      </header>

      <GitPageCommit
        branch={workspace.branch}
        stagedCount={staged}
        onCommit={onCommit}
        onPush={onPush}
        onPull={onPull}
        onFetch={onFetch}
        onSync={onSync}
      />

      <div className="git-page-body">
        <aside className="git-page-overview" aria-label="Git overview">
          <div className="git-page-card primary">
            <div className="git-page-card-k">Working tree</div>
            <div className="git-page-card-v">{state.changes?.length ?? 0}</div>
            <div className="git-page-card-sub">{staged} staged · {unstaged} unstaged</div>
          </div>
          <div className="git-page-card-row">
            <div className="git-page-card">
              <div className="git-page-card-k">Ahead</div>
              <div className="git-page-card-v small">{state.ahead || 0}</div>
            </div>
            <div className="git-page-card">
              <div className="git-page-card-k">Behind</div>
              <div className="git-page-card-v small">{state.behind || 0}</div>
            </div>
          </div>
          <div className={`git-page-card ${conflicts ? 'danger' : ''}`}>
            <div className="git-page-card-k">Conflicts</div>
            <div className="git-page-card-v small">{conflicts}</div>
            <div className="git-page-card-sub">{conflicts ? 'needs resolution' : 'clean'}</div>
          </div>
          <div className="git-page-card-row">
            <div className="git-page-card">
              <div className="git-page-card-k">PRs</div>
              <div className="git-page-card-v small">{prs}</div>
            </div>
            <div className="git-page-card">
              <div className="git-page-card-k">Commits</div>
              <div className="git-page-card-v small">{history}</div>
            </div>
          </div>
        </aside>

        <div className="git-page-main">
          <GitPageChanges
            repoPath={workspace.path}
            comparisonRef={state.comparisonRef}
            changes={state.changes || []}
            hasUnpushed={state.ahead > 0}
            onStage={onStageFile}
            onUnstage={onUnstageFile}
            onStageAll={onStageAll}
            onUnstageAll={onUnstageAll}
            onDiscard={onDiscardFile}
          />
        </div>

        <div className="git-page-panel">
          <GitSidebar {...props} width={420} hideTop hideSections={{ commit: true, changes: true }} />
        </div>
      </div>
    </section>
  )
}

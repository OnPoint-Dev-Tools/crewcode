import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GitHubMergeMethod, GitHubPullRequestDetail, GitHubPullRequestReviewOptions } from '../../../../shared/github-types'
import { getCrewCodeClient } from '../../runtime/crewcode-client'
import { PierreDiff } from '../diff/PierreDiff'
import { Icon } from '../ui/Icon'
import type { GitActionOutcome, GitPrRef } from './git-state'
import { splitPullRequestPatch } from './pull-request-diff'

interface PullRequestReviewProps {
  open: boolean
  repoPath: string
  pr: GitPrRef | null
  onMerge?: (num: number, method: GitHubMergeMethod) => Promise<GitActionOutcome>
  onUpdateBranch?: (num: number) => Promise<GitActionOutcome>
  onClosePr?: (num: number) => Promise<GitActionOutcome>
  onReview?: (num: number, options: GitHubPullRequestReviewOptions) => Promise<GitActionOutcome>
  onClose: () => void
}

type ReviewTab = 'overview' | 'files' | 'checks'

function dateLabel(value: string): string {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}

function checkState(status: string, conclusion: string | null): 'ok' | 'fail' | 'pending' | 'neutral' {
  if (status.toUpperCase() !== 'COMPLETED' && !conclusion) return 'pending'
  if (conclusion?.toUpperCase() === 'SUCCESS' || status.toUpperCase() === 'SUCCESS') return 'ok'
  if (conclusion && !['NEUTRAL', 'SKIPPED'].includes(conclusion.toUpperCase())) return 'fail'
  return 'neutral'
}

export function PullRequestReview({ open, repoPath, pr, onMerge, onUpdateBranch, onClosePr, onReview, onClose }: PullRequestReviewProps) {
  const [tab, setTab] = useState<ReviewTab>('overview')
  const [detail, setDetail] = useState<GitHubPullRequestDetail | null>(null)
  const [patch, setPatch] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [reviewEvent, setReviewEvent] = useState<GitHubPullRequestReviewOptions['event']>('comment')
  const [reviewBody, setReviewBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [mergeMethod, setMergeMethod] = useState<GitHubMergeMethod>('squash')
  const [confirmMerge, setConfirmMerge] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  const load = useCallback(async () => {
    if (!open || !pr) return
    setLoading(true)
    setError('')
    const client = getCrewCodeClient()
    try {
      const [nextDetail, nextDiff] = await Promise.all([
        client.githubPrDetail(repoPath, pr.num),
        client.githubPrDiff(repoPath, pr.num),
      ])
      if ('error' in nextDetail) throw new Error(nextDetail.error)
      if (!nextDiff.ok) throw new Error(nextDiff.error || `Could not load diff for #${pr.num}`)
      setDetail(nextDetail)
      setPatch(nextDiff.patch)
      setSelectedPath(current => current && nextDetail.files.some(file => file.path === current) ? current : nextDetail.files[0]?.path ?? '')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [open, pr, repoPath])

  useEffect(() => {
    if (!open) return
    setTab('overview')
    setDetail(null)
    setPatch('')
    setNotice(null)
    setReviewBody('')
    setConfirmMerge(false)
    setConfirmClose(false)
    void load()
  }, [open, pr?.num, load])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !submitting) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, submitting, onClose])

  const patches = useMemo(() => splitPullRequestPatch(patch), [patch])
  const selectedPatch = patches.find(file => file.path === selectedPath)?.patch ?? ''
  const passedChecks = detail?.checks.filter(check => checkState(check.status, check.conclusion) === 'ok').length ?? 0
  const failedChecks = detail?.checks.filter(check => checkState(check.status, check.conclusion) === 'fail').length ?? 0

  if (!open || !pr) return null

  const submitReview = async () => {
    if (!onReview || submitting || (reviewEvent !== 'approve' && !reviewBody.trim())) return
    setSubmitting(true)
    const result = await onReview(pr.num, { event: reviewEvent, body: reviewBody.trim() || undefined })
    setSubmitting(false)
    if (!result.ok) { setNotice({ kind: 'error', text: result.error || 'GitHub rejected the review.' }); return }
    setNotice({ kind: 'ok', text: 'Review submitted to GitHub.' })
    setReviewBody('')
    await load()
  }

  const merge = async () => {
    if (!onMerge) return
    setSubmitting(true)
    const result = await onMerge(pr.num, mergeMethod)
    setSubmitting(false)
    if (!result.ok) { setNotice({ kind: 'error', text: result.error || 'GitHub rejected the merge.' }); return }
    setNotice({ kind: 'ok', text: `Pull request merged with ${mergeMethod}.` })
    setConfirmMerge(false)
    await load()
  }

  return createPortal(
    <div className="pr-review-shell" role="dialog" aria-modal="true" aria-label={`Review pull request ${pr.num}`}>
      <header className="pr-review-header">
        <button className="pr-review-back" onClick={onClose}><Icon name="chevLeft" size={13} /> Pull requests</button>
        <div className="pr-review-title">
          <div><span className={`pr-state ${detail?.isDraft ? 'draft' : 'open'}`}>{detail?.isDraft ? 'Draft' : detail?.state?.toLowerCase() ?? pr.status}</span><code>#{pr.num}</code></div>
          <h1>{detail?.title ?? pr.title}</h1>
          <p><strong>{detail?.author || pr.author || 'unknown'}</strong> wants to merge <code>{detail?.head ?? pr.head}</code> into <code>{detail?.base ?? pr.base}</code></p>
        </div>
        <button className="pr-review-close" onClick={onClose} aria-label="Close pull request review"><Icon name="close" size={14} /></button>
      </header>

      <nav className="pr-review-tabs" aria-label="Pull request review sections">
        {(['overview', 'files', 'checks'] as const).map(item => (
          <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>
            {item === 'overview' ? <Icon name="eye" size={11} /> : item === 'files' ? <Icon name="fileText" size={11} /> : <Icon name="check" size={11} />}
            {item === 'overview' ? 'Overview' : item === 'files' ? `Files ${detail?.files.length ?? ''}` : `Checks ${detail?.checks.length ?? ''}`}
          </button>
        ))}
        <button className="pr-review-refresh" onClick={() => void load()} disabled={loading}><Icon name="refresh" size={11} />{loading ? 'Refreshing' : 'Refresh'}</button>
      </nav>

      {error ? <div className="pr-review-error"><Icon name="alert" size={14} />{error}<button onClick={() => void load()}>Retry</button></div> : (
        <div className={`pr-review-layout tab-${tab}`}>
          {tab === 'overview' && (
            <>
              <aside className="pr-review-commits">
                <div className="pr-review-panel-head"><span>Commits</span><strong>{detail?.commits.length ?? 0}</strong></div>
                {(detail?.commits ?? []).map((commit, index) => <div className="pr-commit" key={commit.oid || index}><span className="pr-commit-dot" /><div><strong>{commit.message}</strong><span><code>{commit.oid.slice(0, 7)}</code>{commit.author ? ` · ${commit.author}` : ''}</span></div></div>)}
                {!loading && !detail?.commits.length && <div className="pr-review-empty">No commits returned.</div>}
              </aside>
              <main className="pr-review-conversation">
                <article className="pr-description-block"><header><span className="pr-avatar">{(detail?.author || pr.author || '?').slice(0, 1).toUpperCase()}</span><div><strong>{detail?.author || pr.author}</strong><span>opened this pull request</span></div></header><div>{detail?.body || 'No description provided.'}</div></article>
                {(detail?.comments ?? []).map(comment => <article className="pr-comment-block" key={comment.id}><header><span className="pr-avatar">{comment.author.slice(0, 1).toUpperCase()}</span><div><strong>{comment.author || 'unknown'}</strong><span>{comment.kind === 'review' ? `${comment.state?.toLowerCase().replaceAll('_', ' ') || 'reviewed'} · ` : 'commented · '}{dateLabel(comment.createdAt)}</span></div></header><div>{comment.body || 'No written comment.'}</div></article>)}
                {!loading && !detail?.comments.length && <div className="pr-conversation-end">No review conversation yet.</div>}
              </main>
            </>
          )}

          {tab === 'files' && (
            <>
              <aside className="pr-review-files">
                <div className="pr-review-panel-head"><span>Changed files</span><strong>{detail?.files.length ?? 0}</strong></div>
                {(detail?.files ?? []).map(file => <button key={file.path} className={selectedPath === file.path ? 'active' : ''} onClick={() => setSelectedPath(file.path)}><span>{file.path}</span><code><b>+{file.additions}</b> −{file.deletions}</code></button>)}
              </aside>
              <main className="pr-review-diff"><header><code>{selectedPath || 'No file selected'}</code></header><div>{selectedPath ? <PierreDiff patch={selectedPatch} className="pr-review-pierre" /> : <div className="pr-review-empty">Select a file to review its diff.</div>}</div></main>
            </>
          )}

          {tab === 'checks' && (
            <main className="pr-review-checks-main">
              <header><div><span>CI / Checks</span><h2>{failedChecks ? `${failedChecks} failing` : detail?.checks.length ? 'All reported checks are clear' : 'No checks reported'}</h2></div><code>{passedChecks}/{detail?.checks.length ?? 0} passed</code></header>
              <div className="pr-check-list">{(detail?.checks ?? []).map((check, index) => { const state = checkState(check.status, check.conclusion); return <div className={`pr-check ${state}`} key={`${check.name}-${index}`}><span>{state === 'ok' ? <Icon name="check" size={12} /> : state === 'fail' ? <Icon name="x" size={12} /> : <Icon name="circleDot" size={12} />}</span><strong>{check.name}</strong><code>{check.conclusion?.toLowerCase() ?? check.status.toLowerCase()}</code>{check.detailsUrl && <button onClick={() => getCrewCodeClient().openExternal(check.detailsUrl!)}><Icon name="external" size={10} /></button>}</div> })}</div>
            </main>
          )}

          <aside className="pr-review-inspector">
            <section className="pr-review-action">
              <span className="pr-review-kicker">Submit review</span>
              <div className="pr-review-event">
                <button className={reviewEvent === 'comment' ? 'active' : ''} onClick={() => setReviewEvent('comment')}>Comment</button>
                <button className={reviewEvent === 'approve' ? 'active' : ''} onClick={() => setReviewEvent('approve')}>Approve</button>
                <button className={reviewEvent === 'request-changes' ? 'active' : ''} onClick={() => setReviewEvent('request-changes')}>Request changes</button>
              </div>
              <textarea value={reviewBody} onChange={event => setReviewBody(event.target.value)} placeholder={reviewEvent === 'approve' ? 'Optional approval note' : 'Review summary'} />
              <button className="gs-btn primary" onClick={submitReview} disabled={submitting || detail?.state !== 'OPEN' || (reviewEvent !== 'approve' && !reviewBody.trim())}>{submitting ? 'Submitting…' : 'Submit review'}</button>
              {notice && <div className={`pr-review-notice ${notice.kind}`}>{notice.text}</div>}
            </section>

            <section className="pr-review-evidence">
              <div><span>Checks</span><strong className={failedChecks ? 'bad' : ''}>{passedChecks}/{detail?.checks.length ?? 0}</strong></div>
              <div><span>Files changed</span><strong>{detail?.files.length ?? 0}</strong></div>
              <div><span>Lines</span><strong><b>+{detail?.additions ?? 0}</b> −{detail?.deletions ?? 0}</strong></div>
              <div><span>Review</span><strong>{detail?.reviewDecision?.toLowerCase().replaceAll('_', ' ') || 'pending'}</strong></div>
            </section>

            {detail?.mergeStateStatus === 'BEHIND' && <button className="gs-btn pr-review-update" onClick={async () => { const result = await onUpdateBranch?.(pr.num); if (result?.ok) await load(); else if (result) setNotice({ kind: 'error', text: result.error || 'GitHub rejected the branch update.' }) }}><Icon name="refresh" size={11} />Update branch</button>}

            <section className="pr-review-merge">
              <div className={`pr-merge-readiness ${failedChecks ? 'blocked' : detail?.mergeStateStatus?.toLowerCase()}`}><Icon name={failedChecks ? 'alert' : 'gitMerge'} size={12} /><span><strong>{failedChecks ? 'Merge may be blocked' : (detail?.mergeStateStatus ?? 'Unknown').toLowerCase()}</strong><small>{failedChecks ? `${failedChecks} reported check${failedChecks === 1 ? '' : 's'} failing.` : 'GitHub enforces the final repository rules.'}</small></span></div>
              <select value={mergeMethod} onChange={event => setMergeMethod(event.target.value as GitHubMergeMethod)} aria-label="Merge method"><option value="merge">Create merge commit</option><option value="squash">Squash and merge</option><option value="rebase">Rebase and merge</option></select>
              {confirmMerge ? <div className="pr-review-confirm"><span>Merge #{pr.num} into {detail?.base ?? pr.base}?</span><button className="gs-btn ghost" onClick={() => setConfirmMerge(false)}>Cancel</button><button className="gs-btn primary" onClick={merge} disabled={submitting}>Confirm merge</button></div> : <button className="gs-btn primary" onClick={() => setConfirmMerge(true)} disabled={detail?.isDraft || detail?.state !== 'OPEN'}><Icon name="gitMerge" size={11} />Merge pull request</button>}
            </section>

            {detail?.state === 'OPEN' && (confirmClose ? <div className="pr-review-close-confirm"><span>Close without merging?</span><button className="gs-btn ghost" onClick={() => setConfirmClose(false)}>Cancel</button><button className="gs-btn danger" onClick={async () => { const result = await onClosePr?.(pr.num); if (result?.ok) onClose(); else if (result) setNotice({ kind: 'error', text: result.error || 'GitHub rejected the close operation.' }) }}>Close PR</button></div> : <button className="pr-review-close-pr" onClick={() => setConfirmClose(true)}>Close pull request</button>)}
          </aside>
        </div>
      )}
    </div>,
    document.body,
  )
}

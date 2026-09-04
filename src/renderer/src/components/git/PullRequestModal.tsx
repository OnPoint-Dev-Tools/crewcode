import { useEffect, useRef, useState } from 'react'
import type { GitHubPullRequestCreateContext, GitHubPullRequestCreateOptions } from '../../../../shared/github-types'
import { getCrewCodeClient } from '../../runtime/crewcode-client'
import { Icon } from '../ui/Icon'

interface PullRequestModalProps {
  open: boolean
  repoPath: string
  head: string
  branches: string[]
  defaultBase: string
  defaultTitle: string
  onCreate: (options: GitHubPullRequestCreateOptions) => Promise<boolean>
  onClose: () => void
}

const STEPS = ['Branches', 'Details', 'Review'] as const
const PR_BODY_FIELDS = [
  { key: 'description', label: 'Description', placeholder: 'Briefly summarize this pull request.' },
  { key: 'problem', label: 'Problem', placeholder: 'What problem or limitation does this address?' },
  { key: 'whatChanged', label: 'What changed', placeholder: 'List the important implementation changes.' },
  { key: 'whyChanged', label: 'Why it changed', placeholder: 'Explain why this approach was chosen.' },
  { key: 'solution', label: 'Solution', placeholder: 'Describe how the result solves the problem.' },
] as const
type PullRequestBodyField = typeof PR_BODY_FIELDS[number]['key']
type PullRequestBodyValues = Record<PullRequestBodyField, string>
const EMPTY_BODY_VALUES: PullRequestBodyValues = { description: '', problem: '', whatChanged: '', whyChanged: '', solution: '' }

export function buildPullRequestBody(values: PullRequestBodyValues): string {
  return PR_BODY_FIELDS.flatMap(field => {
    const value = values[field.key].trim()
    return value ? [`## ${field.label}\n\n${value}`] : []
  }).join('\n\n')
}

export function PullRequestModal({ open, repoPath, head, branches, defaultBase, defaultTitle, onCreate, onClose }: PullRequestModalProps) {
  const [step, setStep] = useState(0)
  const [title, setTitle] = useState(defaultTitle)
  const [bodyValues, setBodyValues] = useState<PullRequestBodyValues>(EMPTY_BODY_VALUES)
  const [base, setBase] = useState(defaultBase)
  const [draft, setDraft] = useState(true)
  const [commitScope, setCommitScope] = useState<'all' | 'selected'>('all')
  const [selectedCommits, setSelectedCommits] = useState<string[]>([])
  const [selectedBranch, setSelectedBranch] = useState('')
  const [creating, setCreating] = useState(false)
  const [comparison, setComparison] = useState<{ loading: boolean; value?: GitHubPullRequestCreateContext; error?: string }>({ loading: false })
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setStep(0)
    setTitle(defaultTitle)
    setBodyValues(EMPTY_BODY_VALUES)
    setBase(defaultBase)
    setDraft(true)
    setCommitScope('all')
    setSelectedCommits([])
    setSelectedBranch(`${head.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/^[-/.]+|[-/.]+$/g, '') || 'changes'}-selected`)
    setCreating(false)
  }, [open, defaultBase, defaultTitle, head])

  useEffect(() => {
    if (!open || !repoPath || !base.trim()) return
    let cancelled = false
    setComparison({ loading: true })
    const timer = setTimeout(() => {
      getCrewCodeClient().githubPrCreateContext(repoPath, base.trim()).then(result => {
        if (cancelled) return
        if ('error' in result) setComparison({ loading: false, error: result.error })
        else setComparison({ loading: false, value: result })
      }).catch(error => {
        if (!cancelled) setComparison({ loading: false, error: String(error) })
      })
    }, 220)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [open, repoPath, base])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !creating) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, creating, onClose])

  useEffect(() => {
    if (open && step === 1) setTimeout(() => titleRef.current?.select(), 30)
  }, [open, step])

  if (!open) return null

  const submit = async () => {
    if (!title.trim() || !base.trim() || creating) return
    setCreating(true)
    try {
      const body = buildPullRequestBody(bodyValues)
      const ok = await onCreate({
        title: title.trim(), body: body || undefined, base: base.trim(), draft,
        selectedCommits: commitScope === 'selected' ? selectedCommits : undefined,
        selectedBranch: commitScope === 'selected' ? selectedBranch.trim() : undefined,
      })
      if (ok) onClose()
    } finally {
      setCreating(false)
    }
  }

  const validSelectedBranch = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(selectedBranch) && !selectedBranch.includes('..') && !selectedBranch.endsWith('/')
  const canContinueBranches = !!base.trim() && !comparison.loading && !!comparison.value
    && (commitScope === 'all' || (selectedCommits.length > 0 && validSelectedBranch && selectedBranch !== base.trim()))
  const canContinueDetails = !!title.trim()

  return (
    <div className="im-backdrop pr-flow-backdrop" onClick={() => { if (!creating) onClose() }}>
      <div className="im-modal pr-flow" role="dialog" aria-modal="true" aria-labelledby="pr-create-title" onClick={event => event.stopPropagation()}>
        <header className="pr-flow-head">
          <div>
            <span className="pr-flow-index">01</span>
            <h2 id="pr-create-title">Create pull request</h2>
          </div>
          <button type="button" className="im-close" onClick={onClose} disabled={creating} aria-label="Close pull request dialog"><Icon name="close" size={13} /></button>
        </header>

        <nav className="pr-flow-steps" aria-label="Pull request creation steps">
          {STEPS.map((label, index) => (
            <button key={label} type="button" className={index === step ? 'active' : index < step ? 'complete' : ''} disabled={index > step} onClick={() => { if (index < step) setStep(index) }}>
              <span>{index < step ? <Icon name="check" size={10} /> : index + 1}</span>{label}
            </button>
          ))}
        </nav>

        <div className="pr-flow-body">
          {step === 0 && (
            <section className="pr-flow-section" aria-labelledby="pr-branches-title">
              <div className="pr-flow-section-head">
                <span>Branch comparison</span>
                <h3 id="pr-branches-title">Choose where this PR lands</h3>
                <p>CrewCode compares the current branch directly with the selected base.</p>
              </div>

              <div className="pr-branch-route">
                <label><span>Source branch</span><div className="pr-branch-fixed"><Icon name="gitBranch" size={11} /><code>{commitScope === 'selected' ? selectedBranch || 'new branch' : head || 'HEAD'}</code></div></label>
                <Icon name="chevRight" size={13} />
                <label><span>Target branch</span><div className="pr-branch-input"><Icon name="gitBranch" size={11} /><input list="pr-base-branches" value={base} onChange={event => setBase(event.target.value)} aria-label="Target branch" /></div></label>
                <datalist id="pr-base-branches">{branches.filter(branch => branch !== head).map(branch => <option key={branch} value={branch} />)}</datalist>
              </div>

              <div className="pr-commit-scope" role="group" aria-label="Pull request commit scope">
                <button type="button" className={commitScope === 'all' ? 'active' : ''} onClick={() => setCommitScope('all')}>
                  <strong>All new commits</strong><span>Open the PR directly from <code>{head || 'HEAD'}</code>.</span>
                </button>
                <button type="button" className={commitScope === 'selected' ? 'active' : ''} onClick={() => setCommitScope('selected')}>
                  <strong>Pick commits</strong><span>Create a clean branch from the latest <code>{base || 'base'}</code>.</span>
                </button>
              </div>

              {commitScope === 'selected' && <div className="pr-commit-picker">
                <label className="pr-flow-field"><span>New source branch</span><input value={selectedBranch} onChange={event => setSelectedBranch(event.target.value)} aria-invalid={!validSelectedBranch} /></label>
                <header><div><strong>Commit history</strong><span>{selectedCommits.length} selected</span></div><button type="button" onClick={() => setSelectedCommits(selectedCommits.length === (comparison.value?.commits.length ?? 0) ? [] : (comparison.value?.commits ?? []).map(commit => commit.oid))}>{selectedCommits.length === (comparison.value?.commits.length ?? 0) ? 'Clear' : 'Select all'}</button></header>
                <div className="pr-commit-list">
                  {(comparison.value?.commits ?? []).map(commit => <label key={commit.oid}>
                    <input type="checkbox" checked={selectedCommits.includes(commit.oid)} onChange={event => setSelectedCommits(current => event.target.checked ? [...current, commit.oid] : current.filter(oid => oid !== commit.oid))} />
                    <code>{commit.oid.slice(0, 7)}</code><span><strong>{commit.title || 'Untitled commit'}</strong><small>{commit.author} · {new Date(commit.committedAt).toLocaleString()}</small></span>
                  </label>)}
                  {!comparison.loading && comparison.value?.commits.length === 0 && <p>No commits are available between this base and the current branch.</p>}
                </div>
                <p className="pr-commit-warning">CrewCode will fetch the latest base, create this branch in an isolated worktree, cherry-pick the selected commits in history order, push it, then open the PR. Your current branch stays unchanged.</p>
              </div>}

              <div className="pr-comparison" aria-live="polite">
                <div><strong>{comparison.value?.ahead ?? '—'}</strong><span>ahead</span></div>
                <div><strong>{comparison.value?.behind ?? '—'}</strong><span>behind</span></div>
                <div><strong>{comparison.value?.changedFiles ?? '—'}</strong><span>files</span></div>
                <div className={`status ${comparison.value?.mergeStatus ?? 'unknown'}`}>
                  <strong>{comparison.loading ? 'Checking' : comparison.value?.mergeStatus ?? 'Unknown'}</strong><span>merge state</span>
                </div>
              </div>
              {comparison.error && <div className="pr-flow-error">{comparison.error}</div>}
            </section>
          )}

          {step === 1 && (
            <section className="pr-flow-section" aria-labelledby="pr-details-title">
              <div className="pr-flow-section-head">
                <span>Pull request details</span>
                <h3 id="pr-details-title">Explain the change</h3>
                <p>Give reviewers enough context to understand the intent and verify the result.</p>
              </div>
              <label className="pr-flow-field"><span>Title</span><input ref={titleRef} value={title} onChange={event => setTitle(event.target.value)} /></label>
              <div className="pr-structured-fields">
                {PR_BODY_FIELDS.map(field => <label className={`pr-flow-field ${field.key === 'description' ? 'wide' : ''}`} key={field.key}><span>{field.label} <small>Optional · Markdown supported</small></span><textarea value={bodyValues[field.key]} onChange={event => setBodyValues(current => ({ ...current, [field.key]: event.target.value }))} placeholder={field.placeholder} /></label>)}
              </div>
              <label className="pr-draft-choice"><input type="checkbox" checked={draft} onChange={event => setDraft(event.target.checked)} /><span><strong>Create as draft</strong><small>Review can begin, but merging stays disabled until the PR is marked ready.</small></span></label>
            </section>
          )}

          {step === 2 && (
            <section className="pr-flow-section" aria-labelledby="pr-review-title">
              <div className="pr-flow-section-head">
                <span>Final review</span>
                <h3 id="pr-review-title">Create one pull request</h3>
                <p>Confirm the exact branches and details before sending them to GitHub.</p>
              </div>
              <div className="pr-review-route"><code>{commitScope === 'selected' ? selectedBranch : head || 'HEAD'}</code><Icon name="chevRight" size={12} /><code>{base}</code></div>
              <div className="pr-review-summary">
                <div><span>Title</span><strong>{title}</strong></div>
                <div><span>Status</span><strong>{draft ? 'Draft' : 'Ready for review'}</strong></div>
                <div><span>Changes</span><strong>{commitScope === 'selected' ? `${selectedCommits.length} selected commit${selectedCommits.length === 1 ? '' : 's'}` : `${comparison.value?.changedFiles ?? 0} files · ${comparison.value?.ahead ?? 0} commits ahead`}</strong></div>
              </div>
              <div className="pr-review-structured">{PR_BODY_FIELDS.map(field => { const value = bodyValues[field.key].trim(); return <section className={value ? '' : 'empty'} key={field.key}><h4>{field.label}</h4><p>{value || 'Not provided.'}</p></section> })}</div>
              <div className="pr-merge-note"><Icon name="gitMerge" size={13} /><span><strong>Merge method is chosen after review.</strong> Merge commit, squash, and rebase remain available from the PR review workspace.</span></div>
            </section>
          )}
        </div>

        <footer className="pr-flow-actions">
          <button type="button" className="gs-btn ghost" onClick={() => step === 0 ? onClose() : setStep(current => current - 1)} disabled={creating}>{step === 0 ? 'Cancel' : 'Back'}</button>
          {step < 2 ? (
            <button type="button" className="gs-btn primary" onClick={() => setStep(current => current + 1)} disabled={step === 0 ? !canContinueBranches : !canContinueDetails}>Next step <Icon name="chevRight" size={11} /></button>
          ) : (
            <button type="button" className="gs-btn primary" onClick={submit} disabled={creating}>{creating ? <span className="pm-spinner" /> : <Icon name="gitPullRequest" size={11} />}{creating ? 'Creating…' : draft ? 'Create draft' : 'Create pull request'}</button>
          )}
        </footer>
      </div>
    </div>
  )
}

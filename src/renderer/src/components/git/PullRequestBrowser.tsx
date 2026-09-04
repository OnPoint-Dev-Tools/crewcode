import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  GitHubMergeMethod,
  GitHubPullRequestCheckEvidence,
  GitHubPullRequestCheckLogResult,
  GitHubPullRequestCheckRerunOptions,
  GitHubPullRequestChecksContext,
  GitHubPullRequestCatalogue,
  GitHubPullRequestCatalogueItem,
  GitHubPullRequestConflictPreparationResult,
  GitHubPullRequestDetail,
  GitHubPullRequestInlineCommentDraft,
  GitHubPullRequestEditOptions,
  GitHubPullRequestManagementContext,
  GitHubPullRequestMergeAutomationOptions,
  GitHubPullRequestMetadataOptions,
  GitHubPullRequestReviewContext,
  GitHubPullRequestReviewOptions,
} from '../../../../shared/github-types'
import { getCrewCodeClient } from '../../runtime/crewcode-client'
import { PierreDiff } from '../diff/PierreDiff'
import { Markdown } from '../thread/Markdown'
import { Icon } from '../ui/Icon'
import { parsePullRequestBodySections } from './pull-request-body'
import { splitPullRequestPatch } from './pull-request-diff'
import type { GitActionOutcome } from './git-state'
import type { GitStatus } from '../../types'
import type { GitConflictDiffResult } from '../../../../shared/git-conflict-types'

type PullRequestFilter = 'all' | 'open' | 'closed' | 'assigned'
type PullRequestBrowserTab = 'overview' | 'timeline' | 'changes' | 'checks' | 'conflicts'
type PullRequestReviewFilter = 'any' | 'requested' | 'requested-to-you' | 'approved' | 'changes-requested' | 'review-required'

interface PullRequestBrowserMemory {
  selectedNumber: number | null
  selectedPath: string
  tab: PullRequestBrowserTab
  filter: PullRequestFilter
  query: string
  author: string
  label: string
  base: string
  head: string
  review: PullRequestReviewFilter
}

const browserMemoryByRepo = new Map<string, PullRequestBrowserMemory>()

interface PullRequestBrowserProps {
  open: boolean
  repoPath: string
  currentBranch: string
  onMerge?: (num: number, method: GitHubMergeMethod, headCommitId?: string) => Promise<GitActionOutcome>
  onUpdateBranch?: (num: number) => Promise<GitActionOutcome>
  onReady?: (num: number) => Promise<GitActionOutcome>
  onDraft?: (num: number) => Promise<GitActionOutcome>
  onReopen?: (num: number) => Promise<GitActionOutcome>
  onEdit?: (num: number, options: GitHubPullRequestEditOptions) => Promise<GitActionOutcome>
  onMetadata?: (num: number, options: GitHubPullRequestMetadataOptions) => Promise<GitActionOutcome>
  onRerunCheck?: (num: number, options: GitHubPullRequestCheckRerunOptions) => Promise<GitActionOutcome>
  onMergeAutomation?: (num: number, options: GitHubPullRequestMergeAutomationOptions) => Promise<GitActionOutcome>
  onPrepareConflicts?: (head: string, base: string) => Promise<GitHubPullRequestConflictPreparationResult>
  onClosePr?: (num: number) => Promise<GitActionOutcome>
  onReview?: (num: number, options: GitHubPullRequestReviewOptions) => Promise<GitActionOutcome>
  onClose: () => void
}

function dateLabel(value: string): string {
  const date = new Date(value)
  return !value || Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}

function exactDateLabel(value: string): string {
  const date = new Date(value)
  return !value || Number.isNaN(date.getTime()) ? 'Creation time unavailable' : new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(date)
}

function prState(item: GitHubPullRequestCatalogueItem): string {
  if (item.isDraft) return 'Draft'
  return item.state === 'MERGED' ? 'Merged' : item.state === 'CLOSED' ? 'Closed' : 'Open'
}

function githubProfile(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}`
}

function checkState(status: string, conclusion: string | null): 'ok' | 'fail' | 'pending' | 'neutral' {
  const value = (conclusion || status).toUpperCase()
  if (['PENDING', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED', 'EXPECTED'].includes(value)) return 'pending'
  if (value === 'SUCCESS') return 'ok'
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STALE', 'STARTUP_FAILURE'].includes(value)) return 'fail'
  return 'neutral'
}

export function PullRequestBrowser({
  open,
  repoPath,
  currentBranch,
  onMerge,
  onUpdateBranch,
  onReady,
  onDraft,
  onReopen,
  onEdit,
  onMetadata,
  onRerunCheck,
  onMergeAutomation,
  onPrepareConflicts,
  onClosePr,
  onReview,
  onClose,
}: PullRequestBrowserProps) {
  const [catalogue, setCatalogue] = useState<GitHubPullRequestCatalogue | null>(null)
  const initialMemory = browserMemoryByRepo.get(repoPath)
  const [selectedNumber, setSelectedNumber] = useState<number | null>(initialMemory?.selectedNumber ?? null)
  const [detailByNumber, setDetailByNumber] = useState<Record<number, GitHubPullRequestDetail>>({})
  const [patchByNumber, setPatchByNumber] = useState<Record<number, string>>({})
  const [reviewContextByNumber, setReviewContextByNumber] = useState<Record<number, GitHubPullRequestReviewContext>>({})
  const [reviewContextError, setReviewContextError] = useState('')
  const [reviewContextLoading, setReviewContextLoading] = useState(false)
  const [localViewedByNumber, setLocalViewedByNumber] = useState<Record<number, string[]>>({})
  const [pendingCommentsByNumber, setPendingCommentsByNumber] = useState<Record<number, GitHubPullRequestInlineCommentDraft[]>>({})
  const [inlineTarget, setInlineTarget] = useState<{ path: string; side: 'LEFT' | 'RIGHT'; line: number } | null>(null)
  const [inlineBody, setInlineBody] = useState('')
  const [selectedPath, setSelectedPath] = useState(initialMemory?.selectedPath ?? '')
  const [tab, setTab] = useState<PullRequestBrowserTab>(initialMemory?.tab ?? 'overview')
  const [filter, setFilter] = useState<PullRequestFilter>(initialMemory?.filter ?? 'all')
  const [query, setQuery] = useState(initialMemory?.query ?? '')
  const [authorFilter, setAuthorFilter] = useState(initialMemory?.author ?? '')
  const [labelFilter, setLabelFilter] = useState(initialMemory?.label ?? '')
  const [baseFilter, setBaseFilter] = useState(initialMemory?.base ?? '')
  const [headFilter, setHeadFilter] = useState(initialMemory?.head ?? '')
  const [reviewFilter, setReviewFilter] = useState<PullRequestReviewFilter>(initialMemory?.review ?? 'any')
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [patchLoading, setPatchLoading] = useState(false)
  const [error, setError] = useState('')
  const [patchError, setPatchError] = useState('')
  const [avatarByLogin, setAvatarByLogin] = useState<Record<string, string | null>>({})
  const [mutation, setMutation] = useState<{ kind: string; number: number } | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [reviewEvent, setReviewEvent] = useState<GitHubPullRequestReviewOptions['event']>('comment')
  const [reviewBody, setReviewBody] = useState('')
  const [mergeMethod, setMergeMethod] = useState<GitHubMergeMethod>('squash')
  const [confirmAction, setConfirmAction] = useState<'merge' | 'auto' | 'disable-auto' | 'queue' | 'close' | 'reopen' | 'draft' | 'resolve' | null>(null)
  const [conflictPreparation, setConflictPreparation] = useState<GitHubPullRequestConflictPreparationResult | null>(null)
  const [localConflictStatus, setLocalConflictStatus] = useState<GitStatus | null>(null)
  const [localConflictError, setLocalConflictError] = useState('')
  const [selectedConflictPath, setSelectedConflictPath] = useState('')
  const [conflictFileText, setConflictFileText] = useState('')
  const [conflictFileLoading, setConflictFileLoading] = useState(false)
  const [conflictDiff, setConflictDiff] = useState<GitConflictDiffResult | null>(null)
  const [conflictOperation, setConflictOperation] = useState('')
  const [editingDetails, setEditingDetails] = useState(false)
  const [editTitle, setEditTitle] = useState('')
  const [editBody, setEditBody] = useState('')
  const [managementOpen, setManagementOpen] = useState(false)
  const [managementContextByNumber, setManagementContextByNumber] = useState<Record<number, GitHubPullRequestManagementContext>>({})
  const [managementLoading, setManagementLoading] = useState(false)
  const [managementError, setManagementError] = useState('')
  const [checksContextByNumber, setChecksContextByNumber] = useState<Record<number, GitHubPullRequestChecksContext>>({})
  const [checksLoading, setChecksLoading] = useState(false)
  const [checksError, setChecksError] = useState('')
  const [expandedCheckId, setExpandedCheckId] = useState('')
  const [checkLogByKey, setCheckLogByKey] = useState<Record<string, GitHubPullRequestCheckLogResult>>({})
  const [checkLogLoadingKey, setCheckLogLoadingKey] = useState('')
  const [checkRerunConfirm, setCheckRerunConfirm] = useState<{ check: GitHubPullRequestCheckEvidence; mode: 'all' | 'failed' | 'job' } | null>(null)
  const [metadataValue, setMetadataValue] = useState<Record<'reviewer' | 'assignee' | 'label', string>>({ reviewer: '', assignee: '', label: '' })
  const previousRepoRef = useRef(repoPath)
  const previousSelectedRef = useRef(selectedNumber)
  const restoringRepoRef = useRef(false)

  const loadCatalogue = useCallback(async () => {
    if (!open) return
    setLoading(true)
    setError('')
    try {
      const result = await getCrewCodeClient().githubPrCatalogue(repoPath)
      if ('error' in result) throw new Error(result.error)
      setCatalogue(result)
      setSelectedNumber(current => {
        if (current && result.items.some(item => item.number === current)) return current
        return result.items.find(item => item.head === currentBranch)?.number ?? result.items[0]?.number ?? null
      })
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [currentBranch, open, repoPath])

  useEffect(() => {
    if (!open) return
    setMutation(null)
    setNotice(null)
    setConfirmAction(null)
    setConflictPreparation(null)
    setLocalConflictStatus(null)
    setLocalConflictError('')
    setSelectedConflictPath('')
    setConflictFileText('')
    setConflictDiff(null)
    void loadCatalogue()
  }, [open, repoPath, loadCatalogue])

  useEffect(() => {
    if (previousRepoRef.current === repoPath) return
    previousRepoRef.current = repoPath
    restoringRepoRef.current = true
    const memory = browserMemoryByRepo.get(repoPath)
    setSelectedNumber(memory?.selectedNumber ?? null)
    setSelectedPath(memory?.selectedPath ?? '')
    setTab(memory?.tab ?? 'overview')
    setFilter(memory?.filter ?? 'all')
    setQuery(memory?.query ?? '')
    setAuthorFilter(memory?.author ?? '')
    setLabelFilter(memory?.label ?? '')
    setBaseFilter(memory?.base ?? '')
    setHeadFilter(memory?.head ?? '')
    setReviewFilter(memory?.review ?? 'any')
    setCatalogue(null)
    setDetailByNumber({})
    setPatchByNumber({})
    setReviewContextByNumber({})
    setManagementContextByNumber({})
    setChecksContextByNumber({})
    setCheckLogByKey({})
  }, [repoPath])

  useEffect(() => {
    if (!open) return
    browserMemoryByRepo.set(repoPath, { selectedNumber, selectedPath, tab, filter, query, author: authorFilter, label: labelFilter, base: baseFilter, head: headFilter, review: reviewFilter })
  }, [authorFilter, baseFilter, filter, headFilter, labelFilter, open, query, repoPath, reviewFilter, selectedNumber, selectedPath, tab])

  useEffect(() => {
    if (previousSelectedRef.current === selectedNumber) return
    previousSelectedRef.current = selectedNumber
    if (restoringRepoRef.current) { restoringRepoRef.current = false; return }
    setSelectedPath('')
    setReviewContextError('')
    setInlineTarget(null)
    setInlineBody('')
    setPatchError('')
    setNotice(null)
    setReviewEvent('comment')
    setReviewBody('')
    setConfirmAction(null)
    setConflictPreparation(null)
    setLocalConflictStatus(null)
    setLocalConflictError('')
    setSelectedConflictPath('')
    setConflictFileText('')
    setConflictDiff(null)
    setEditingDetails(false)
    setManagementOpen(false)
    setManagementError('')
    setChecksError('')
    setExpandedCheckId('')
    setCheckRerunConfirm(null)
  }, [selectedNumber])

  useEffect(() => {
    if (!open || selectedNumber == null || detailByNumber[selectedNumber]) return
    let cancelled = false
    setDetailLoading(true)
    void getCrewCodeClient().githubPrDetail(repoPath, selectedNumber).then(result => {
      if (cancelled) return
      if ('error' in result) { setError(result.error); return }
      setDetailByNumber(current => ({ ...current, [selectedNumber]: result }))
      setSelectedPath(current => current && result.files.some(file => file.path === current) ? current : result.files[0]?.path ?? '')
    }).catch(loadError => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError))
    }).finally(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [detailByNumber, open, repoPath, selectedNumber])

  useEffect(() => {
    if (!open || tab !== 'changes' || selectedNumber == null || Object.hasOwn(patchByNumber, selectedNumber)) return
    let cancelled = false
    setPatchLoading(true)
    setPatchError('')
    void getCrewCodeClient().githubPrDiff(repoPath, selectedNumber).then(result => {
      if (cancelled) return
      if (!result.ok) { setPatchError(result.error || `Could not load code changes for #${selectedNumber}`); return }
      setPatchByNumber(current => ({ ...current, [selectedNumber]: result.patch }))
    }).catch(loadError => {
      if (!cancelled) setPatchError(loadError instanceof Error ? loadError.message : String(loadError))
    }).finally(() => { if (!cancelled) setPatchLoading(false) })
    return () => { cancelled = true }
  }, [open, patchByNumber, repoPath, selectedNumber, tab])

  const loadReviewContext = useCallback(async (number: number, force = false) => {
    if (!force && reviewContextByNumber[number]) return reviewContextByNumber[number]
    setReviewContextLoading(true)
    setReviewContextError('')
    try {
      const result = await getCrewCodeClient().githubPrReviewContext(repoPath, number)
      if ('error' in result) throw new Error(result.error)
      setReviewContextByNumber(current => ({ ...current, [number]: result }))
      return result
    } catch (loadError) {
      setReviewContextError(loadError instanceof Error ? loadError.message : String(loadError))
      return null
    } finally {
      setReviewContextLoading(false)
    }
  }, [repoPath, reviewContextByNumber])

  useEffect(() => {
    if (!open || tab !== 'changes' || selectedNumber == null) return
    void loadReviewContext(selectedNumber)
  }, [loadReviewContext, open, selectedNumber, tab])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !mutation) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mutation, onClose, open])

  const avatarSelected = catalogue?.items.find(item => item.number === selectedNumber) ?? null
  const avatarDetail = selectedNumber == null ? null : detailByNumber[selectedNumber] ?? null
  const avatarAuthor = avatarDetail?.author || avatarSelected?.author || ''

  useEffect(() => {
    if (!open || !avatarAuthor || Object.hasOwn(avatarByLogin, avatarAuthor)) return
    let cancelled = false
    void getCrewCodeClient().githubAvatar(repoPath, avatarAuthor).then(result => {
      if (cancelled) return
      setAvatarByLogin(current => ({ ...current, [avatarAuthor]: result.ok && result.dataUrl ? result.dataUrl : null }))
    }).catch(() => {
      if (!cancelled) setAvatarByLogin(current => ({ ...current, [avatarAuthor]: null }))
    })
    return () => { cancelled = true }
  }, [avatarAuthor, avatarByLogin, open, repoPath])

  useEffect(() => {
    if (!open || !managementOpen || selectedNumber == null || managementContextByNumber[selectedNumber]) return
    let cancelled = false
    setManagementLoading(true)
    setManagementError('')
    void getCrewCodeClient().githubPrManagementContext(repoPath, selectedNumber).then(result => {
      if (cancelled) return
      if ('error' in result) { setManagementError(result.error); return }
      setManagementContextByNumber(current => ({ ...current, [selectedNumber]: result }))
    }).catch(loadError => {
      if (!cancelled) setManagementError(loadError instanceof Error ? loadError.message : String(loadError))
    }).finally(() => { if (!cancelled) setManagementLoading(false) })
    return () => { cancelled = true }
  }, [managementContextByNumber, managementOpen, open, repoPath, selectedNumber])

  const loadChecksContext = useCallback(async (number: number, force = false) => {
    if (!force && checksContextByNumber[number]) return checksContextByNumber[number]
    setChecksLoading(true)
    setChecksError('')
    try {
      const result = await getCrewCodeClient().githubPrChecksContext(repoPath, number)
      if ('error' in result) throw new Error(result.error)
      setChecksContextByNumber(current => ({ ...current, [number]: result }))
      return result
    } catch (loadError) {
      setChecksError(loadError instanceof Error ? loadError.message : String(loadError))
      return null
    } finally {
      setChecksLoading(false)
    }
  }, [checksContextByNumber, repoPath])

  useEffect(() => {
    if (!open || tab !== 'checks' || selectedNumber == null) return
    void loadChecksContext(selectedNumber)
  }, [loadChecksContext, open, selectedNumber, tab])

  const visibleItems = useMemo(() => {
    const viewer = catalogue?.viewer?.toLowerCase() ?? ''
    const search = query.trim().toLowerCase()
    return (catalogue?.items ?? []).filter(item => {
      if (filter === 'open' && item.state !== 'OPEN') return false
      if (filter === 'closed' && item.state === 'OPEN') return false
      if (filter === 'assigned' && (!viewer || ![...item.assignees, ...item.reviewers].some(login => login.toLowerCase() === viewer))) return false
      if (authorFilter && item.author !== authorFilter) return false
      if (labelFilter && !item.labels.includes(labelFilter)) return false
      if (baseFilter && item.base !== baseFilter) return false
      if (headFilter && item.head !== headFilter) return false
      if (reviewFilter === 'requested' && item.reviewers.length === 0) return false
      if (reviewFilter === 'requested-to-you' && (!viewer || !item.reviewers.some(login => login.toLowerCase() === viewer))) return false
      if (reviewFilter === 'approved' && item.reviewDecision !== 'APPROVED') return false
      if (reviewFilter === 'changes-requested' && item.reviewDecision !== 'CHANGES_REQUESTED') return false
      if (reviewFilter === 'review-required' && item.reviewDecision !== 'REVIEW_REQUIRED') return false
      return !search || `${item.title} ${item.number} ${item.author} ${item.head} ${item.base}`.toLowerCase().includes(search)
    })
  }, [authorFilter, baseFilter, catalogue, filter, headFilter, labelFilter, query, reviewFilter])

  useEffect(() => {
    if (mutation) return
    if (visibleItems.length === 0) return
    if (!visibleItems.some(item => item.number === selectedNumber)) setSelectedNumber(visibleItems[0].number)
  }, [mutation, selectedNumber, visibleItems])

  const selected = catalogue?.items.find(item => item.number === selectedNumber) ?? null
  const detail = selectedNumber == null ? null : detailByNumber[selectedNumber] ?? null

  const loadLocalConflictStatus = useCallback(async () => {
    if (!detail) return null
    setLocalConflictError('')
    try {
      const status = await getCrewCodeClient().gitStatus(repoPath)
      if (status.error) throw new Error(status.error)
      if (status.branch !== detail.head) throw new Error(`Conflict resolution for #${detail.number} is bound to ${detail.head}, but this worktree is on ${status.branch}.`)
      setLocalConflictStatus(status)
      const paths = [...new Set([...status.staged, ...status.unstaged].filter(file => file.status === 'U').map(file => file.path))]
      setSelectedConflictPath(current => current && paths.includes(current) ? current : paths[0] ?? '')
      return status
    } catch (statusError) {
      setLocalConflictError(statusError instanceof Error ? statusError.message : String(statusError))
      return null
    }
  }, [detail, repoPath])

  useEffect(() => {
    if (!open || tab !== 'conflicts' || !detail) return
    void loadLocalConflictStatus()
  }, [detail, loadLocalConflictStatus, open, tab])

  useEffect(() => {
    if (!selectedConflictPath || tab !== 'conflicts') { setConflictFileText(''); setConflictDiff(null); return }
    let cancelled = false
    setConflictFileLoading(true)
    void Promise.all([
      getCrewCodeClient().fsReadFile(repoPath, selectedConflictPath),
      getCrewCodeClient().gitConflictDiff(repoPath, selectedConflictPath),
    ]).then(([result, diff]) => {
      if (cancelled) return
      if (result.error || typeof result.text !== 'string') throw new Error(result.error || `Could not read ${selectedConflictPath}`)
      setConflictFileText(result.text)
      setConflictDiff(diff)
      if (!diff.ok) setLocalConflictError(diff.error || `Could not load conflict evidence for ${selectedConflictPath}`)
    }).catch(readError => {
      if (!cancelled) setLocalConflictError(readError instanceof Error ? readError.message : String(readError))
    }).finally(() => { if (!cancelled) setConflictFileLoading(false) })
    return () => { cancelled = true }
  }, [repoPath, selectedConflictPath, tab])

  if (!open) return null
  const author = detail?.author || selected?.author || 'unknown'
  const authorAvatar = avatarByLogin[author]
  const createdAt = detail?.createdAt || selected?.createdAt || ''
  const sections = parsePullRequestBodySections(detail?.body ?? selected?.body ?? '')
  const patch = selectedNumber == null ? '' : patchByNumber[selectedNumber] ?? ''
  const patches = splitPullRequestPatch(patch)
  const selectedPatch = patches.find(file => file.path === selectedPath)?.patch ?? ''
  const reviewContext = selectedNumber == null ? null : reviewContextByNumber[selectedNumber] ?? null
  const pendingComments = selectedNumber == null ? [] : pendingCommentsByNumber[selectedNumber] ?? []
  const localViewed = selectedNumber == null ? [] : localViewedByNumber[selectedNumber] ?? []
  const viewedPaths = new Set(reviewContext ? reviewContext.files.filter(file => file.viewed).map(file => file.path) : localViewed)
  const selectedFileViewed = !!selectedPath && viewedPaths.has(selectedPath)
  const selectedThreads = (reviewContext?.threads ?? []).filter(thread => thread.path === selectedPath)
  const filesSinceLastReview = new Set(reviewContext?.filesSinceLastReview ?? [])
  const selectedFileIndex = Math.max(0, (detail?.files ?? []).findIndex(file => file.path === selectedPath))
  const comments = detail?.comments ?? []
  const managementContext = selectedNumber == null ? null : managementContextByNumber[selectedNumber] ?? null
  const checksContext = selectedNumber == null ? null : checksContextByNumber[selectedNumber] ?? null
  const timeline = detail ? [
    { id: 'opened', at: detail.createdAt, kind: 'opened' as const, author: detail.author, title: 'Opened this pull request', body: '' },
    ...detail.commits.map(commit => ({ id: commit.oid, at: commit.committedAt, kind: 'commit' as const, author: commit.author, title: commit.message, body: commit.oid.slice(0, 7) })),
    ...detail.comments.map(comment => ({ id: comment.id, at: comment.createdAt, kind: comment.kind, author: comment.author, title: comment.kind === 'review' ? comment.state?.toLowerCase().replaceAll('_', ' ') || 'Submitted a review' : 'Commented', body: comment.body })),
  ].sort((a, b) => a.at.localeCompare(b.at)) : []
  const passedChecks = detail?.checks.filter(check => checkState(check.status, check.conclusion) === 'ok').length ?? 0
  const failedChecks = detail?.checks.filter(check => checkState(check.status, check.conclusion) === 'fail').length ?? 0
  const detailedPassedChecks = checksContext?.checks.filter(check => checkState(check.status, check.conclusion) === 'ok').length ?? passedChecks
  const detailedFailedChecks = checksContext?.checks.filter(check => checkState(check.status, check.conclusion) === 'fail').length ?? failedChecks
  const detailedPendingChecks = checksContext?.checks.filter(check => checkState(check.status, check.conclusion) === 'pending').length ?? 0
  const isSelfAuthored = !!catalogue?.viewer && catalogue.viewer.toLowerCase() === author.toLowerCase()
  const isOpen = detail?.state === 'OPEN'
  const actionLocked = mutation !== null
  const showConflictFlow = detail?.mergeStateStatus === 'DIRTY'
    || /not mergeable|conflict|cleanly created/i.test(notice?.text ?? '')
    || conflictPreparation !== null
  const localConflictPaths = [...new Set([
    ...(localConflictStatus?.staged ?? []),
    ...(localConflictStatus?.unstaged ?? []),
  ].filter(file => file.status === 'U').map(file => file.path))]
  const filterChoices = {
    authors: [...new Set((catalogue?.items ?? []).map(item => item.author).filter(Boolean))].sort(),
    labels: [...new Set((catalogue?.items ?? []).flatMap(item => item.labels))].sort(),
    bases: [...new Set((catalogue?.items ?? []).map(item => item.base).filter(Boolean))].sort(),
    heads: [...new Set((catalogue?.items ?? []).map(item => item.head).filter(Boolean))].sort(),
  }
  const checkSuites = [...(checksContext?.checks ?? [])].reduce<Array<{ name: string; checks: GitHubPullRequestCheckEvidence[] }>>((suites, check) => {
    const suite = suites.find(candidate => candidate.name === check.suiteName)
    if (suite) suite.checks.push(check)
    else suites.push({ name: check.suiteName, checks: [check] })
    return suites
  }, [])
  const mergeBlockers: Array<{ kind: 'blocked' | 'waiting'; title: string; detail: string }> = []
  if (detail?.isDraft) mergeBlockers.push({ kind: 'blocked', title: 'Draft pull request', detail: 'Mark this pull request ready before merging.' })
  if (checksContext?.mergeable === 'CONFLICTING' || detail?.mergeStateStatus === 'DIRTY') mergeBlockers.push({ kind: 'blocked', title: 'Merge conflicts', detail: `Resolve conflicts between ${detail?.head ?? 'the head'} and ${detail?.base ?? 'the base'} before merging.` })
  if (checksContext?.reviewDecision === 'CHANGES_REQUESTED') mergeBlockers.push({ kind: 'blocked', title: 'Changes requested', detail: 'At least one active review requests changes.' })
  else if (checksContext?.reviewDecision === 'REVIEW_REQUIRED') mergeBlockers.push({ kind: 'waiting', title: 'Review required', detail: 'Required approving reviews have not been observed.' })
  const requiredFailed = checksContext?.checks.filter(check => check.isRequired && checkState(check.status, check.conclusion) === 'fail') ?? []
  const requiredPending = checksContext?.checks.filter(check => check.isRequired && checkState(check.status, check.conclusion) === 'pending') ?? []
  if (requiredFailed.length) mergeBlockers.push({ kind: 'blocked', title: 'Required checks failed', detail: requiredFailed.map(check => check.name).join(', ') })
  if (requiredPending.length) mergeBlockers.push({ kind: 'waiting', title: 'Required checks pending', detail: requiredPending.map(check => check.name).join(', ') })
  if (detail?.mergeStateStatus === 'BEHIND') mergeBlockers.push({ kind: 'waiting', title: 'Head branch is behind', detail: `${detail.head} needs the latest ${detail.base} changes.` })
  if (checksContext?.mergeStateStatus === 'BLOCKED' && !mergeBlockers.some(blocker => blocker.title.toLowerCase().includes('required') || blocker.title === 'Changes requested')) mergeBlockers.push({ kind: 'blocked', title: 'Repository rules', detail: 'GitHub reports this pull request as blocked but did not return a more specific rule.' })

  const selectRelativeFile = (direction: -1 | 1) => {
    const files = detail?.files ?? []
    if (!files.length) return
    const nextIndex = (selectedFileIndex + direction + files.length) % files.length
    setSelectedPath(files[nextIndex].path)
    setInlineTarget(null)
    setInlineBody('')
  }

  const selectNextUnviewedFile = () => {
    const files = detail?.files ?? []
    if (!files.length) return
    for (let offset = 1; offset <= files.length; offset += 1) {
      const candidate = files[(selectedFileIndex + offset) % files.length]
      if (!viewedPaths.has(candidate.path)) { setSelectedPath(candidate.path); setInlineTarget(null); setInlineBody(''); return }
    }
  }

  const refreshSelectedEvidence = async (number: number): Promise<GitHubPullRequestDetail> => {
    const client = getCrewCodeClient()
    const [nextCatalogue, nextDetail] = await Promise.all([
      client.githubPrCatalogue(repoPath),
      client.githubPrDetail(repoPath, number),
    ])
    if ('error' in nextCatalogue) throw new Error(nextCatalogue.error)
    if ('error' in nextDetail) throw new Error(nextDetail.error)
    setCatalogue(nextCatalogue)
    setDetailByNumber(current => ({ ...current, [number]: nextDetail }))
    setPatchByNumber(current => {
      const next = { ...current }
      delete next[number]
      return next
    })
    setChecksContextByNumber(current => {
      const next = { ...current }
      delete next[number]
      return next
    })
    setSelectedPath(current => current && nextDetail.files.some(file => file.path === current) ? current : nextDetail.files[0]?.path ?? '')
    return nextDetail
  }

  const refreshBrowser = async () => {
    setLoading(true)
    setError('')
    try {
      if (selectedNumber == null) await loadCatalogue()
      else await refreshSelectedEvidence(selectedNumber)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError))
    } finally {
      setLoading(false)
    }
  }

  const runMutation = async (
    kind: string,
    action: (number: number) => Promise<GitActionOutcome> | undefined,
    success: (nextDetail: GitHubPullRequestDetail) => string,
  ) => {
    if (!selected || actionLocked) return
    const targetNumber = selected.number
    setMutation({ kind, number: targetNumber })
    setNotice(null)
    try {
      const result = await action(targetNumber)
      if (!result?.ok) throw new Error(result?.error || `${kind} was not completed`)
      try {
        const nextDetail = await refreshSelectedEvidence(targetNumber)
        setNotice({ kind: 'ok', text: success(nextDetail) })
      } catch (refreshError) {
        setNotice({ kind: 'error', text: `${kind} completed, but CrewCode could not refresh GitHub evidence: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}` })
      }
    } catch (mutationError) {
      setNotice({ kind: 'error', text: mutationError instanceof Error ? mutationError.message : String(mutationError) })
    } finally {
      setMutation(null)
    }
  }

  const addPendingComment = () => {
    if (!detail || !inlineTarget || !inlineBody.trim() || !selectedNumber || !reviewContext?.headCommitId) return
    const comment: GitHubPullRequestInlineCommentDraft = {
      id: globalThis.crypto?.randomUUID?.() ?? `review-${Date.now()}`,
      ...inlineTarget,
      body: inlineBody.trim(),
      commitId: reviewContext.headCommitId,
    }
    setPendingCommentsByNumber(current => ({ ...current, [selectedNumber]: [...(current[selectedNumber] ?? []), comment] }))
    setInlineTarget(null)
    setInlineBody('')
  }

  const removePendingComment = (id: string) => {
    if (!selectedNumber || actionLocked) return
    setPendingCommentsByNumber(current => ({ ...current, [selectedNumber]: (current[selectedNumber] ?? []).filter(comment => comment.id !== id) }))
  }

  const toggleViewedFile = async () => {
    if (!selectedNumber || !selectedPath || actionLocked) return
    const nextViewed = !selectedFileViewed
    if (!reviewContext) {
      setLocalViewedByNumber(current => ({
        ...current,
        [selectedNumber]: nextViewed
          ? [...new Set([...(current[selectedNumber] ?? []), selectedPath])]
          : (current[selectedNumber] ?? []).filter(path => path !== selectedPath),
      }))
      return
    }
    const targetNumber = selectedNumber
    const targetPath = selectedPath
    setMutation({ kind: nextViewed ? 'Mark file viewed' : 'Mark file unviewed', number: targetNumber })
    setNotice(null)
    try {
      const result = await getCrewCodeClient().ghPrViewedFile(repoPath, targetNumber, { pullRequestId: reviewContext.pullRequestId, path: targetPath, viewed: nextViewed })
      if (!result.ok) throw new Error(result.error || 'GitHub did not update the viewed-file state')
      await loadReviewContext(targetNumber, true)
      setNotice({ kind: 'ok', text: `${targetPath} marked ${nextViewed ? 'viewed' : 'unviewed'} on GitHub.` })
    } catch (mutationError) {
      setNotice({ kind: 'error', text: mutationError instanceof Error ? mutationError.message : String(mutationError) })
    } finally {
      setMutation(null)
    }
  }

  const toggleReviewThread = async (threadId: string, resolved: boolean) => {
    if (!selectedNumber || actionLocked) return
    const targetNumber = selectedNumber
    setMutation({ kind: resolved ? 'Resolve conversation' : 'Reopen conversation', number: targetNumber })
    setNotice(null)
    try {
      const result = await getCrewCodeClient().ghPrReviewThread(repoPath, targetNumber, threadId, resolved)
      if (!result.ok) throw new Error(result.error || 'GitHub did not update the review conversation')
      await loadReviewContext(targetNumber, true)
      setNotice({ kind: 'ok', text: `Review conversation ${resolved ? 'resolved' : 'reopened'} on GitHub.` })
    } catch (mutationError) {
      setNotice({ kind: 'error', text: mutationError instanceof Error ? mutationError.message : String(mutationError) })
    } finally {
      setMutation(null)
    }
  }

  const submitReview = async () => {
    if (!onReview || !detail || (reviewEvent !== 'approve' && !reviewBody.trim()) || (reviewEvent === 'approve' && isSelfAuthored)) return
    const targetNumber = detail.number
    await runMutation('Submit review', number => onReview(number, {
      event: reviewEvent,
      body: reviewBody.trim() || undefined,
      commitId: pendingComments.length ? reviewContext?.headCommitId : undefined,
      comments: pendingComments.length ? pendingComments : undefined,
    }), () => {
      setReviewBody('')
      setPendingCommentsByNumber(current => ({ ...current, [targetNumber]: [] }))
      return 'Review submitted to GitHub and PR evidence refreshed.'
    })
    await loadReviewContext(targetNumber, true)
  }

  const beginEditingDetails = () => {
    if (!detail || actionLocked) return
    setEditTitle(detail.title)
    setEditBody(detail.body)
    setEditingDetails(true)
  }

  const saveDetails = async () => {
    if (!onEdit || !detail || !editTitle.trim()) return
    await runMutation('Update pull request', number => onEdit(number, { title: editTitle, body: editBody }), next => {
      setEditingDetails(false)
      return next.title === editTitle.trim() && next.body === editBody
        ? `GitHub confirms #${next.number} details were updated.`
        : `Update completed, but GitHub returned different pull request details.`
    })
  }

  const changeMetadata = async (kind: GitHubPullRequestMetadataOptions['kind'], operation: GitHubPullRequestMetadataOptions['operation'], value: string) => {
    if (!onMetadata || !value.trim()) return
    await runMutation(`${operation === 'add' ? 'Add' : 'Remove'} ${kind}`, number => onMetadata(number, { kind, operation, value }), next => {
      if (operation === 'add') setMetadataValue(current => ({ ...current, [kind]: '' }))
      return `GitHub confirms #${next.number} ${kind} metadata was refreshed.`
    })
  }

  const copyEvidence = async (label: string, value: string) => {
    if (!value || actionLocked) return
    const result = await getCrewCodeClient().clipboardWriteText(value)
    setNotice(result.ok ? { kind: 'ok', text: `${label} copied.` } : { kind: 'error', text: result.error || `Could not copy ${label.toLowerCase()}.` })
  }

  const loadCheckLog = async (check: GitHubPullRequestCheckEvidence) => {
    if (!selectedNumber || !checksContext || !check.runId || !check.jobId || actionLocked) return
    const key = `${selectedNumber}:${check.id}`
    setCheckLogLoadingKey(key)
    try {
      const result = await getCrewCodeClient().githubPrCheckLog(repoPath, selectedNumber, checksContext.headCommitId, check.runId, check.jobId)
      setCheckLogByKey(current => ({ ...current, [key]: result }))
    } catch (loadError) {
      setCheckLogByKey(current => ({ ...current, [key]: { ok: false, log: '', truncated: false, error: loadError instanceof Error ? loadError.message : String(loadError) } }))
    } finally {
      setCheckLogLoadingKey('')
    }
  }

  const rerunCheck = async () => {
    if (!selectedNumber || !checksContext || !checkRerunConfirm || !onRerunCheck || actionLocked || !checkRerunConfirm.check.runId) return
    const targetNumber = selectedNumber
    const target = checkRerunConfirm
    const runId = target.check.runId!
    setMutation({ kind: 'Request check rerun', number: targetNumber })
    setNotice(null)
    try {
      const result = await onRerunCheck(targetNumber, {
        headCommitId: checksContext.headCommitId,
        runId,
        mode: target.mode,
        jobId: target.mode === 'job' ? target.check.jobId ?? undefined : undefined,
      })
      if (!result.ok) throw new Error(result.error || 'GitHub did not accept the check rerun')
      await refreshSelectedEvidence(targetNumber)
      await loadChecksContext(targetNumber, true)
      setNotice({ kind: 'ok', text: `GitHub accepted the ${target.mode === 'job' ? target.check.name : target.mode === 'failed' ? 'failed-job' : 'workflow'} rerun request for #${targetNumber}.` })
    } catch (rerunError) {
      setNotice({ kind: 'error', text: rerunError instanceof Error ? rerunError.message : String(rerunError) })
    } finally {
      setCheckRerunConfirm(null)
      setMutation(null)
    }
  }

  const performMergeAutomation = async (action: GitHubPullRequestMergeAutomationOptions['action']) => {
    if (!selectedNumber || !detail || !onMergeAutomation || actionLocked) return
    const targetNumber = selectedNumber
    const headCommitId = checksContext?.headCommitId ?? detail.headCommitId
    setMutation({ kind: action === 'disable' ? 'Disable auto-merge' : action === 'queue' ? 'Submit to merge queue' : 'Enable auto-merge', number: targetNumber })
    setNotice(null)
    try {
      const result = await onMergeAutomation(targetNumber, { action, headCommitId, method: action === 'enable' ? mergeMethod : undefined })
      if (!result.ok) throw new Error(result.error || 'GitHub did not accept the merge automation action')
      const nextDetail = await refreshSelectedEvidence(targetNumber)
      const nextChecks = await loadChecksContext(targetNumber, true)
      const confirmed = action === 'disable' ? !!nextChecks && !nextChecks.autoMerge && !nextChecks.isInMergeQueue
        : action === 'queue' ? nextDetail.state === 'MERGED' || (!!nextChecks && (nextChecks.isInMergeQueue || !!nextChecks.autoMerge))
          : nextDetail.state === 'MERGED' || !!nextChecks?.autoMerge
      if (!confirmed) throw new Error(`GitHub accepted the command but did not confirm that ${action === 'disable' ? 'auto-merge is disabled' : action === 'queue' ? 'the PR is queued or waiting automatically' : 'auto-merge is enabled'}.`)
      if (nextDetail.state === 'MERGED') setFilter('all')
      setNotice({ kind: 'ok', text: nextDetail.state === 'MERGED' ? `GitHub confirms #${targetNumber} is merged.` : action === 'disable' ? `GitHub confirms auto-merge is disabled for #${targetNumber}.` : action === 'queue' ? `GitHub confirms #${targetNumber} is queued or will enter the queue when requirements pass.` : `GitHub confirms auto-merge is enabled for #${targetNumber}.` })
    } catch (automationError) {
      setNotice({ kind: 'error', text: automationError instanceof Error ? automationError.message : String(automationError) })
    } finally {
      setConfirmAction(null)
      setMutation(null)
    }
  }

  const prepareMergeConfirmation = async (action: 'merge' | 'auto' | 'queue') => {
    if (!selectedNumber || actionLocked) return
    const targetNumber = selectedNumber
    const targetHead = detail?.headCommitId
    setMutation({ kind: 'Load merge requirements', number: targetNumber })
    try {
      const evidence = await loadChecksContext(targetNumber, true)
      if (!evidence) {
        setNotice({ kind: 'error', text: `Could not load current merge requirements for #${targetNumber}. Open Checks for the GitHub error, then retry.` })
        return
      }
      if (evidence.headCommitId !== targetHead) {
        await refreshSelectedEvidence(targetNumber)
        setNotice({ kind: 'error', text: `The head commit for #${targetNumber} changed while merge requirements loaded. Review the refreshed evidence before continuing.` })
        return
      }
      setConfirmAction(action === 'merge' && evidence.isMergeQueueEnabled ? 'queue' : action)
    } finally {
      setMutation(null)
    }
  }

  const runConflictOperation = async (label: string, action: () => Promise<{ ok?: boolean; error?: string }>) => {
    if (!detail || conflictOperation || actionLocked) return false
    setConflictOperation(label)
    setLocalConflictError('')
    try {
      const before = await getCrewCodeClient().gitStatus(repoPath)
      if (before.error) throw new Error(before.error)
      if (before.branch !== detail.head) throw new Error(`This operation is locked to ${detail.head}; the worktree is on ${before.branch}.`)
      const result = await action()
      if (!result.ok) throw new Error(result.error || `${label} did not complete`)
      await loadLocalConflictStatus()
      setNotice({ kind: 'ok', text: `${label} completed for #${detail.number}.` })
      return true
    } catch (operationError) {
      setLocalConflictError(operationError instanceof Error ? operationError.message : String(operationError))
      return false
    } finally {
      setConflictOperation('')
    }
  }

  const saveResolvedConflict = async () => {
    if (!selectedConflictPath) return
    if (/^(?:<<<<<<<|=======|>>>>>>>)(?: |$)/m.test(conflictFileText)) {
      setLocalConflictError('Remove every Git conflict marker before marking this file resolved.')
      return
    }
    await runConflictOperation('Save and mark resolved', async () => {
      const write = await getCrewCodeClient().fsWriteFile(repoPath, selectedConflictPath, conflictFileText)
      if (write.error) return { ok: false, error: write.error }
      return getCrewCodeClient().gitStage(repoPath, [selectedConflictPath])
    })
  }

  const pushResolvedHead = async () => {
    if (!detail) return
    const pushed = await runConflictOperation('Push resolved head', () => getCrewCodeClient().gitPush(repoPath))
    if (pushed) {
      try {
        await refreshSelectedEvidence(detail.number)
        await loadChecksContext(detail.number, true)
        setConflictPreparation(null)
        setTab('checks')
      } catch (refreshError) {
        setNotice({ kind: 'error', text: `Push completed, but GitHub evidence could not be refreshed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}` })
      }
    }
  }

  const abortLocalMerge = async () => {
    const aborted = await runConflictOperation('Abort merge', () => getCrewCodeClient().gitMergeAbort(repoPath))
    if (aborted) {
      setConflictPreparation(null)
      setTab('overview')
    }
  }

  const prepareConflicts = async () => {
    if (!selected || !detail || !onPrepareConflicts || actionLocked) return
    const targetNumber = selected.number
    const targetHead = detail.head
    const targetBase = detail.base
    setMutation({ kind: 'Prepare conflict resolution', number: targetNumber })
    setNotice(null)
    try {
      const result = await onPrepareConflicts(targetHead, targetBase)
      setConflictPreparation(result)
      if (!result.ok) throw new Error(result.error || 'Could not start local conflict resolution')
      await loadLocalConflictStatus()
      setTab('conflicts')
      if (result.status === 'conflicts') setNotice({ kind: 'ok', text: `Local merge for #${targetNumber} started with ${result.conflicts.length} conflict${result.conflicts.length === 1 ? '' : 's'}. Resolve them here, then continue and push.` })
      else if (result.status === 'ready-to-continue') setNotice({ kind: 'ok', text: `All conflicts for #${targetNumber} are resolved. Continue the merge here, then push.` })
      else setNotice({ kind: 'ok', text: `Merged ${targetBase} into ${targetHead} locally. Push ${targetHead} to update #${targetNumber}.` })
    } catch (mutationError) {
      setNotice({ kind: 'error', text: mutationError instanceof Error ? mutationError.message : String(mutationError) })
    } finally {
      setConfirmAction(null)
      setMutation(null)
    }
  }

  return createPortal(
    <div className="pr-browser-shell" role="dialog" aria-modal="true" aria-label="Repository pull requests">
      <header className="pr-browser-header">
        <button className="pr-review-back" onClick={onClose} disabled={actionLocked}><Icon name="chevLeft" size={13} /> Git Workspace</button>
        <div className="pr-browser-header-identity"><span>Pull requests</span><h1>{repoPath.split(/[\\/]/).filter(Boolean).pop() || 'Repository'}</h1><p>Current branch <code>{currentBranch}</code></p></div>
        <div className="pr-browser-header-actions">
          <button className="pr-browser-refresh" onClick={() => void refreshBrowser()} disabled={loading || actionLocked}><Icon name="refresh" size={12} />{loading ? 'Refreshing' : 'Refresh'}</button>
          <button className="pr-review-close" onClick={onClose} disabled={actionLocked} aria-label="Close pull request browser"><Icon name="close" size={14} /></button>
        </div>
      </header>

      <div className="pr-browser-layout">
        <aside className="pr-browser-catalogue">
          <div className="pr-browser-filters" aria-label="Pull request filters">
            {(['all', 'open', 'closed', 'assigned'] as const).map(value => <button key={value} className={filter === value ? 'active' : ''} disabled={actionLocked} onClick={() => setFilter(value)}>{value === 'assigned' ? 'Assigned to you' : value}</button>)}
          </div>
          <label className="pr-browser-search"><Icon name="search" size={11} /><input value={query} disabled={actionLocked} onChange={event => setQuery(event.target.value)} placeholder="Filter pull requests" /></label>
          <button className={`pr-browser-filter-toggle ${advancedFiltersOpen ? 'active' : ''}`} disabled={actionLocked} onClick={() => setAdvancedFiltersOpen(value => !value)}><Icon name="sliders" size={11} />More filters</button>
          {advancedFiltersOpen && <div className="pr-browser-advanced-filters">
            <label><span>Author</span><select value={authorFilter} disabled={actionLocked} onChange={event => setAuthorFilter(event.target.value)}><option value="">Any author</option>{filterChoices.authors.map(value => <option key={value}>{value}</option>)}</select></label>
            <label><span>Label</span><select value={labelFilter} disabled={actionLocked} onChange={event => setLabelFilter(event.target.value)}><option value="">Any label</option>{filterChoices.labels.map(value => <option key={value}>{value}</option>)}</select></label>
            <label><span>Base</span><select value={baseFilter} disabled={actionLocked} onChange={event => setBaseFilter(event.target.value)}><option value="">Any base</option>{filterChoices.bases.map(value => <option key={value}>{value}</option>)}</select></label>
            <label><span>Head</span><select value={headFilter} disabled={actionLocked} onChange={event => setHeadFilter(event.target.value)}><option value="">Any head</option>{filterChoices.heads.map(value => <option key={value}>{value}</option>)}</select></label>
            <label><span>Review</span><select value={reviewFilter} disabled={actionLocked} onChange={event => setReviewFilter(event.target.value as PullRequestReviewFilter)}><option value="any">Any review state</option><option value="requested">Review requested</option><option value="requested-to-you">Requested from you</option><option value="approved">Approved</option><option value="changes-requested">Changes requested</option><option value="review-required">Review required</option></select></label>
            <button disabled={actionLocked} onClick={() => { setAuthorFilter(''); setLabelFilter(''); setBaseFilter(''); setHeadFilter(''); setReviewFilter('any') }}>Clear filters</button>
          </div>}
          <div className="pr-browser-count"><span>{visibleItems.length} pull request{visibleItems.length === 1 ? '' : 's'}</span>{catalogue?.viewer && <code>@{catalogue.viewer}</code>}</div>
          <div className="pr-browser-list">
            {visibleItems.map(item => <button key={item.number} className={item.number === selectedNumber ? 'active' : ''} disabled={actionLocked} onClick={() => setSelectedNumber(item.number)}>
              <span className={`pr-browser-state ${item.state.toLowerCase()} ${item.isDraft ? 'draft' : ''}`}>{prState(item)}</span><code>#{item.number}</code>
              <strong>{item.title}</strong>
              <small><span>{item.author || 'unknown'}</span><span>{dateLabel(item.createdAt || item.updatedAt)}</span></small>
              <div><code>{item.head}</code><Icon name="chevRight" size={9} /><code>{item.base}</code>{item.head === currentBranch && <em>current branch</em>}</div>
            </button>)}
            {!loading && visibleItems.length === 0 && <div className="pr-browser-empty">No pull requests match this filter.</div>}
          </div>
        </aside>

        <main className="pr-browser-main">
          {error && <div className="pr-review-error"><Icon name="alert" size={13} />{error}</div>}
          {!selected ? <div className="pr-browser-blank"><Icon name="gitPullRequest" size={20} /><strong>Select a pull request</strong><span>Repository PR details will appear here.</span></div> : <>
            <header className="pr-browser-pr-head">
              <div><span className={`pr-state ${selected.isDraft ? 'draft' : ''}`}>{prState(selected)}</span><code>#{selected.number}</code></div>
              <h2>{detail?.title ?? selected.title}</h2>
              <div className="pr-browser-authorship">
                <button onClick={() => author !== 'unknown' && void getCrewCodeClient().openExternal(githubProfile(author))} disabled={author === 'unknown'} aria-label={`Open ${author}'s GitHub profile`}><span>{authorAvatar ? <img src={authorAvatar} alt="" /> : <Icon name="github" size={13} />}</span><strong>@{author}</strong></button>
                <span>opened this pull request on <time dateTime={createdAt}>{exactDateLabel(createdAt)}</time></span>
              </div>
              <p>Merge <code>{detail?.head ?? selected.head}</code> into <code>{detail?.base ?? selected.base}</code></p>
            </header>
            <nav className="pr-browser-tabs" aria-label="Selected pull request sections">
              {(['overview', 'timeline', 'changes', 'checks', ...(showConflictFlow ? ['conflicts' as const] : [])] as PullRequestBrowserTab[]).map(value => <button key={value} className={tab === value ? 'active' : ''} disabled={actionLocked} onClick={() => setTab(value)}>
                <Icon name={value === 'overview' ? 'eye' : value === 'timeline' ? 'history' : value === 'changes' ? 'changes' : value === 'conflicts' ? 'alert' : 'check'} size={11} />
                {value === 'overview' ? 'Overview' : value === 'timeline' ? `Timeline ${timeline.length || ''}` : value === 'changes' ? `Code changes ${detail?.files.length ?? ''}` : value === 'conflicts' ? `Conflicts ${localConflictPaths.length || ''}` : `Checks ${detail?.checks.length ?? ''}`}
              </button>)}
            </nav>

            {tab === 'overview' && <div className="pr-browser-scroll">
              {detailLoading && !detail && <div className="pr-browser-loading">Loading pull request evidence…</div>}
              <div className="pr-browser-section-index">PR description</div>
              {sections.map((section, index) => <section className={`pr-browser-section ${section.provided ? '' : 'missing'}`} key={`${section.title}-${index}`}><h3>{section.title}</h3>{section.provided ? <Markdown text={section.body} onOpenLink={url => void getCrewCodeClient().openExternal(url)} /> : <p className="pr-browser-muted">Not provided in this pull request description.</p>}</section>)}
              <section className="pr-browser-conversation" aria-label="Pull request comments">
                <header><h3>Comments</h3><strong>{comments.length}</strong></header>
                {comments.map(comment => <article key={`${comment.kind}-${comment.id}`}>
                  <span className="pr-avatar" aria-hidden="true">{comment.author[0]?.toUpperCase() || '?'}</span>
                  <div>
                    <header><strong>@{comment.author || 'unknown'}</strong><span>{comment.kind === 'review' ? comment.state?.toLowerCase().replaceAll('_', ' ') || 'reviewed' : 'commented'}</span><time dateTime={comment.createdAt}>{exactDateLabel(comment.createdAt)}</time></header>
                    {comment.body ? <Markdown text={comment.body} onOpenLink={url => void getCrewCodeClient().openExternal(url)} /> : <p className="pr-browser-muted">No written review summary.</p>}
                  </div>
                </article>)}
                {!detailLoading && detail && comments.length === 0 && <p className="pr-browser-muted">No comments yet.</p>}
              </section>
            </div>}

            {tab === 'timeline' && <div className="pr-browser-timeline">
              {detailLoading && !detail && <div className="pr-browser-loading">Loading timeline…</div>}
              {timeline.map(event => <article key={`${event.kind}-${event.id}`}>
                <span className="pr-browser-timeline-mark"><Icon name={event.kind === 'commit' ? 'gitCommit' : event.kind === 'review' ? 'inspection' : event.kind === 'comment' ? 'message' : 'gitPullRequest'} size={12} /></span>
                <div><header><strong>{event.author || 'unknown'}</strong><span>{event.title}</span><time dateTime={event.at}>{exactDateLabel(event.at)}</time></header>{event.body && (event.kind === 'commit' ? <code>{event.body}</code> : <Markdown text={event.body} onOpenLink={url => void getCrewCodeClient().openExternal(url)} />)}</div>
              </article>)}
              {!detailLoading && timeline.length === 0 && <div className="pr-browser-empty">No timeline evidence returned.</div>}
            </div>}

            {tab === 'changes' && <div className="pr-browser-changes">
              <aside>
                <header><span>Changed files</span><strong>{viewedPaths.size}/{detail?.files.length ?? 0}</strong></header>
                {(detail?.files ?? []).map(file => <button key={file.path} className={selectedPath === file.path ? 'active' : ''} disabled={actionLocked} onClick={() => { setSelectedPath(file.path); setInlineTarget(null); setInlineBody('') }}>
                  <span>{file.path}</span><code>+{file.additions} −{file.deletions}</code>
                  <small>{viewedPaths.has(file.path) ? 'Viewed' : 'Unviewed'}{filesSinceLastReview.has(file.path) ? ' · New since review' : ''}</small>
                </button>)}
              </aside>
              <div className="pr-browser-diff">
                <header>
                  <code>{selectedPath || 'No file selected'}</code>
                  <div className="pr-review-file-nav">
                    <button disabled={actionLocked || !detail?.files.length} onClick={() => selectRelativeFile(-1)} aria-label="Previous changed file"><Icon name="chevLeft" size={11} /></button>
                    <button disabled={actionLocked || viewedPaths.size >= (detail?.files.length ?? 0)} onClick={selectNextUnviewedFile}>Next unviewed</button>
                    <button disabled={actionLocked || !detail?.files.length} onClick={() => selectRelativeFile(1)} aria-label="Next changed file"><Icon name="chevRight" size={11} /></button>
                    <button className={selectedFileViewed ? 'viewed' : ''} disabled={actionLocked || !selectedPath} onClick={() => void toggleViewedFile()}>{selectedFileViewed ? 'Viewed' : 'Mark viewed'}</button>
                  </div>
                </header>
                {reviewContextLoading && !reviewContext && <div className="pr-review-context-note">Loading review conversations and viewed files…</div>}
                {reviewContextError && <div className="pr-review-context-note local"><strong>Local-only viewed state</strong><span>{reviewContextError}</span></div>}
                {reviewContext && !reviewContextError && <div className="pr-review-context-note"><span>Select a line number to add an inline comment.</span><strong>Viewed state synced with GitHub</strong></div>}
                {reviewContext?.lastReviewedAt && <details className="pr-review-since">
                  <summary><span>Since your review on {exactDateLabel(reviewContext.lastReviewedAt)}</span><strong>{reviewContext.filesSinceLastReview.length} files · {reviewContext.commitsSinceLastReview.length} commits</strong></summary>
                  <div>{reviewContext.commitsSinceLastReview.map(commit => <span key={commit.oid}><code>{commit.oid.slice(0, 7)}</code>{commit.message || 'Untitled commit'}</span>)}{reviewContext.commitsSinceLastReview.length === 0 && <span>No newer commits.</span>}</div>
                </details>}
                {patchError ? <div className="pr-review-error"><Icon name="alert" size={12} />{patchError}</div> : patchLoading ? <div className="pr-browser-loading">Loading GitHub patch…</div> : selectedPath ? <PierreDiff patch={selectedPatch} className="pr-browser-pierre" onLineNumberClick={target => { if (!actionLocked && reviewContext) { setInlineTarget({ path: selectedPath, ...target }); setInlineBody('') } }} /> : <div className="pr-browser-empty">Select a changed file.</div>}
                {inlineTarget && <section className="pr-inline-composer">
                  <header><strong>Add review comment</strong><code>{inlineTarget.path}:{inlineTarget.line} {inlineTarget.side}</code></header>
                  <textarea autoFocus value={inlineBody} disabled={actionLocked} onChange={event => setInlineBody(event.target.value)} placeholder="Leave feedback on this exact diff line" />
                  <div><button className="gs-btn ghost" disabled={actionLocked} onClick={() => { setInlineTarget(null); setInlineBody('') }}>Cancel</button><button className="gs-btn primary" disabled={actionLocked || !inlineBody.trim()} onClick={addPendingComment}>Add to review</button></div>
                </section>}
                <section className="pr-review-threads" aria-label="Review conversations for selected file">
                  <header><span>Review conversations</span><strong>{selectedThreads.length}</strong></header>
                  {selectedThreads.map(thread => <article key={thread.id} className={thread.isResolved ? 'resolved' : ''}>
                    <header><code>{thread.startLine && thread.startLine !== thread.line ? `${thread.startLine}–${thread.line}` : thread.line ?? 'file'} {thread.side}</code><span>{thread.isOutdated ? 'Outdated' : thread.isResolved ? `Resolved${thread.resolvedBy ? ` by @${thread.resolvedBy}` : ''}` : 'Unresolved'}</span></header>
                    {thread.comments.map(comment => <div key={comment.id}><strong>@{comment.author || 'unknown'}</strong><time dateTime={comment.createdAt}>{exactDateLabel(comment.createdAt)}</time><Markdown text={comment.body} onOpenLink={url => void getCrewCodeClient().openExternal(url)} /></div>)}
                    {!thread.isResolved && thread.viewerCanResolve && <button disabled={actionLocked} onClick={() => void toggleReviewThread(thread.id, true)}>Resolve conversation</button>}
                    {thread.isResolved && thread.viewerCanUnresolve && <button disabled={actionLocked} onClick={() => void toggleReviewThread(thread.id, false)}>Reopen conversation</button>}
                  </article>)}
                  {!reviewContextLoading && selectedThreads.length === 0 && <p>No review conversations on this file.</p>}
                </section>
              </div>
            </div>}

            {tab === 'checks' && <main className="pr-browser-checks">
              <header><div><span>CI / Checks</span><h3>{detailedFailedChecks ? `${detailedFailedChecks} failing` : detailedPendingChecks ? `${detailedPendingChecks} in progress` : checksContext?.checks.length ? 'All reported checks are clear' : 'No checks reported'}</h3></div><code>{detailedPassedChecks}/{checksContext?.checks.length ?? detail?.checks.length ?? 0} passed</code></header>
              {checksLoading && !checksContext && <div className="pr-browser-loading">Loading suites, jobs, and merge requirements…</div>}
              {checksError && <div className="pr-review-error"><Icon name="alert" size={12} />{checksError}</div>}
              {checksContext && <>
                <section className="pr-check-merge-readiness" aria-label="Merge requirements">
                  <header><div><span>Merge requirements</span><strong>{mergeBlockers.length ? `${mergeBlockers.length} blocker${mergeBlockers.length === 1 ? '' : 's'} or pending requirement${mergeBlockers.length === 1 ? '' : 's'}` : 'No blocker returned by GitHub'}</strong></div><code>{checksContext.mergeStateStatus.toLowerCase().replaceAll('_', ' ')}</code></header>
                  {mergeBlockers.map((blocker, index) => <div className={blocker.kind} key={`${blocker.title}-${index}`}><Icon name={blocker.kind === 'blocked' ? 'alert' : 'clock'} size={12} /><span><strong>{blocker.title}</strong><small>{blocker.detail}</small></span></div>)}
                  {mergeBlockers.length === 0 && <p>GitHub currently reports no specific check, review, conflict, or branch-rule blocker. Repository rules remain authoritative when you merge.</p>}
                  {checksContext.autoMerge && <div className="waiting"><Icon name="clock" size={12} /><span><strong>Auto-merge enabled</strong><small>{checksContext.autoMerge.enabledBy ? `Enabled by @${checksContext.autoMerge.enabledBy}` : 'Enabled on GitHub'}{checksContext.autoMerge.mergeMethod ? ` with ${checksContext.autoMerge.mergeMethod}` : ''} on {exactDateLabel(checksContext.autoMerge.enabledAt)}.</small></span></div>}
                  {checksContext.mergeQueueEntry && <div className="waiting"><Icon name="gitMerge" size={12} /><span><strong>In merge queue{checksContext.mergeQueueEntry.position ? ` at position ${checksContext.mergeQueueEntry.position}` : ''}</strong><small>{checksContext.mergeQueueEntry.state.toLowerCase().replaceAll('_', ' ')} · queued {exactDateLabel(checksContext.mergeQueueEntry.enqueuedAt)}{checksContext.mergeQueueEntry.estimatedTimeToMerge ? ` · estimated ${exactDateLabel(checksContext.mergeQueueEntry.estimatedTimeToMerge)}` : ''}</small></span></div>}
                </section>
                <div className="pr-check-suites">
                  {checkSuites.map(suite => <section key={suite.name}>
                    <header><strong>{suite.name}</strong><span>{suite.checks.length} job{suite.checks.length === 1 ? '' : 's'}</span></header>
                    {suite.checks.map(check => { const state = checkState(check.status, check.conclusion); const expanded = expandedCheckId === check.id; const logKey = `${selectedNumber}:${check.id}`; const log = checkLogByKey[logKey]; return <article className={`pr-check-evidence ${state}`} key={check.id}>
                      <header><button disabled={actionLocked} onClick={() => setExpandedCheckId(expanded ? '' : check.id)} aria-expanded={expanded}><span>{state === 'ok' ? <Icon name="check" size={12} /> : state === 'fail' ? <Icon name="x" size={12} /> : <Icon name="circleDot" size={12} />}</span><strong>{check.name}</strong>{check.isRequired && <em>required</em>}<code>{(check.conclusion ?? check.status).toLowerCase().replaceAll('_', ' ')}</code><Icon name={expanded ? 'chevDown' : 'chevRight'} size={10} /></button></header>
                      {expanded && <div className="pr-check-evidence-body">
                        {(check.title || check.summary || check.text) && <div className="pr-check-output">{check.title && <strong>{check.title}</strong>}{check.summary && <Markdown text={check.summary} onOpenLink={url => void getCrewCodeClient().openExternal(url)} />}{check.text && <Markdown text={check.text} onOpenLink={url => void getCrewCodeClient().openExternal(url)} />}</div>}
                        {check.steps.length > 0 && <section className="pr-check-steps"><header><span>Steps</span>{check.stepsTruncated && <em>First 100 shown</em>}</header>{check.steps.map(step => { const stepState = checkState(step.status, step.conclusion); return <div key={`${step.number}-${step.name}`}><Icon name={stepState === 'ok' ? 'check' : stepState === 'fail' ? 'x' : 'circleDot'} size={10} /><strong>{step.name}</strong><code>{(step.conclusion ?? step.status).toLowerCase().replaceAll('_', ' ')}</code></div>})}</section>}
                        {check.annotations.length > 0 && <section className="pr-check-annotations"><header><span>Annotations</span>{check.annotationsTruncated && <em>First 50 shown</em>}</header>{check.annotations.map((annotation, index) => <article key={`${annotation.path}-${annotation.startLine}-${annotation.title}-${index}`}><Icon name={annotation.level === 'FAILURE' ? 'alert' : 'message'} size={11} /><div><header><strong>{annotation.title || annotation.level.toLowerCase()}</strong>{annotation.path && <code>{annotation.path}{annotation.startLine ? `:${annotation.startLine}` : ''}{annotation.endLine && annotation.endLine !== annotation.startLine ? `–${annotation.endLine}` : ''}</code>}</header><p>{annotation.message}</p>{annotation.details && <pre>{annotation.details}</pre>}</div></article>)}</section>}
                        <div className="pr-check-evidence-actions">
                          {check.runId && check.jobId && <button className="gs-btn ghost" disabled={actionLocked || checkLogLoadingKey === logKey} onClick={() => void loadCheckLog(check)}>{checkLogLoadingKey === logKey ? 'Loading log…' : log ? 'Reload log' : 'Load job log'}</button>}
                          {checksContext.viewerCanRerunChecks && check.runId && check.jobId && <button className="gs-btn ghost" disabled={actionLocked} onClick={() => setCheckRerunConfirm({ check, mode: 'job' })}>Rerun job</button>}
                          {checksContext.viewerCanRerunChecks && check.runId && state === 'fail' && <button className="gs-btn ghost" disabled={actionLocked} onClick={() => setCheckRerunConfirm({ check, mode: 'failed' })}>Rerun failed jobs</button>}
                          {check.detailsUrl && <button className="gs-btn ghost" disabled={actionLocked} onClick={() => void getCrewCodeClient().openExternal(check.detailsUrl!)}>Provider details <Icon name="external" size={10} /></button>}
                        </div>
                        {checkRerunConfirm?.check.id === check.id && <div className="pr-review-confirm"><span>Request GitHub to rerun {checkRerunConfirm.mode === 'job' ? `job ${check.name}` : `failed jobs in run ${check.runId}`} for PR #{selectedNumber} at <code>{checksContext.headCommitId.slice(0, 12)}</code>?</span><button className="gs-btn ghost" disabled={actionLocked} onClick={() => setCheckRerunConfirm(null)}>Cancel</button><button className="gs-btn primary" disabled={actionLocked || !onRerunCheck} onClick={() => void rerunCheck()}>Confirm rerun</button></div>}
                        {log && <section className="pr-check-log"><header><span>Job log</span>{log.truncated && <em>First 256 KiB shown</em>}</header>{log.ok ? <pre>{log.log || 'GitHub returned an empty job log.'}</pre> : <div className="pr-review-error"><Icon name="alert" size={11} />{log.error || 'Job log unavailable.'}</div>}</section>}
                        {!check.runId && <p className="pr-check-provider-limit">This provider did not expose a GitHub Actions run, so logs and reruns are unavailable in CrewCode.</p>}
                      </div>}
                    </article>})}
                  </section>)}
                  {!checksLoading && checkSuites.length === 0 && <div className="pr-browser-empty">GitHub returned no check suites or status contexts for this pull request.</div>}
                </div>
              </>}
            </main>}

            {tab === 'conflicts' && detail && <div className="pr-browser-conflicts">
              <aside>
                <header><span>Conflicted files</span><strong>{localConflictPaths.length}</strong></header>
                {localConflictPaths.map(path => <button key={path} className={selectedConflictPath === path ? 'active' : ''} disabled={!!conflictOperation || actionLocked} onClick={() => setSelectedConflictPath(path)}><Icon name="alert" size={11} /><code>{path}</code></button>)}
                {localConflictStatus?.mergeInProgress && localConflictPaths.length === 0 && <p>Every conflict is staged. Continue to create the local merge commit.</p>}
                {!localConflictStatus?.mergeInProgress && conflictPreparation?.ok && <p>The local merge commit is ready to push to <code>{detail.head}</code>.</p>}
              </aside>
              <main>
                <header><div><span>Conflict workspace</span><h3>{selectedConflictPath || (localConflictStatus?.mergeInProgress ? 'Ready to continue' : 'Ready to push')}</h3></div><code>{detail.head} ← origin/{detail.base}</code></header>
                {localConflictError && <div className="pr-review-error"><Icon name="alert" size={12} />{localConflictError}</div>}
                {!localConflictStatus ? <div className="pr-browser-loading">Loading local merge state…</div> : selectedConflictPath ? <>
                  <div className="pr-conflict-diff">
                    <header>
                      <div><span>Ours</span><strong>{detail.head}</strong><button className="gs-btn ghost" disabled={!!conflictOperation || actionLocked || !conflictDiff?.oursAvailable} onClick={() => void runConflictOperation('Use ours', () => getCrewCodeClient().gitResolveConflict(repoPath, selectedConflictPath, 'ours'))}>Use ours</button></div>
                      <div><span>Theirs</span><strong>{detail.base}</strong><button className="gs-btn ghost" disabled={!!conflictOperation || actionLocked || !conflictDiff?.theirsAvailable} onClick={() => void runConflictOperation('Use theirs', () => getCrewCodeClient().gitResolveConflict(repoPath, selectedConflictPath, 'theirs'))}>Use theirs</button></div>
                    </header>
                    {conflictFileLoading ? <div className="pr-browser-loading">Loading ours and theirs…</div> : conflictDiff?.ok ? <PierreDiff patch={conflictDiff.patch} className="pr-conflict-pierre" /> : <div className="pr-browser-empty">The conflict comparison is unavailable. You can still edit the resolution result below.</div>}
                  </div>
                  <section className="pr-conflict-result"><header><div><span>Resolution result</span><strong>Remove every conflict marker, then save this file.</strong></div><button className="gs-btn primary" disabled={!!conflictOperation || actionLocked || conflictFileLoading} onClick={() => void saveResolvedConflict()}>{conflictOperation || 'Save and mark resolved'}</button></header>{conflictFileLoading ? <div className="pr-browser-loading">Loading editable result…</div> : <textarea className="pr-conflict-editor" value={conflictFileText} disabled={!!conflictOperation || actionLocked} spellCheck={false} onChange={event => setConflictFileText(event.target.value)} aria-label={`Resolve conflicts in ${selectedConflictPath}`} />}</section>
                </> : <div className="pr-conflict-completion">
                  {localConflictStatus?.mergeInProgress ? <><Icon name="check" size={18} /><strong>All conflict files are resolved</strong><p>Create the local merge commit. CrewCode keeps the default Git merge message and remains on <code>{detail.head}</code>.</p><button className="gs-btn primary" disabled={!!conflictOperation || actionLocked} onClick={() => void runConflictOperation('Continue merge', () => getCrewCodeClient().gitMergeContinue(repoPath))}>{conflictOperation || 'Continue merge'}</button></> : <><Icon name="gitBranch" size={18} /><strong>Push the resolved head branch</strong><p>This updates PR #{detail.number}. GitHub will recalculate checks and mergeability from the new head.</p><button className="gs-btn primary" disabled={!!conflictOperation || actionLocked} onClick={() => void pushResolvedHead()}>{conflictOperation || `Push ${detail.head}`}</button></>}
                </div>}
                <div className="pr-conflict-abort"><span>Abort restores the branch to its state before this local merge.</span><button className="gs-btn danger" disabled={!!conflictOperation || actionLocked || !localConflictStatus?.mergeInProgress} onClick={() => void abortLocalMerge()}>Abort merge</button></div>
              </main>
            </div>}
          </>}
        </main>

        <aside className="pr-browser-inspector">
          {mutation && <div className="pr-browser-mutation"><span className="spinner" /><strong>{mutation.kind}</strong><code>#{mutation.number}</code></div>}
          <section className="pr-browser-manage-details">
            <span>Pull request details</span>
            {editingDetails ? <div className="pr-browser-edit-form">
              <label><span>Title</span><input value={editTitle} maxLength={256} disabled={actionLocked} onChange={event => setEditTitle(event.target.value)} /></label>
              <label><span>Markdown description</span><textarea value={editBody} maxLength={65536} disabled={actionLocked} onChange={event => setEditBody(event.target.value)} /></label>
              <div><button className="gs-btn ghost" disabled={actionLocked} onClick={() => setEditingDetails(false)}>Cancel</button><button className="gs-btn primary" disabled={actionLocked || !onEdit || !editTitle.trim()} onClick={() => void saveDetails()}>Save changes</button></div>
            </div> : <button className="gs-btn ghost" disabled={actionLocked || !detail || !onEdit} onClick={beginEditingDetails}><Icon name="edit" size={11} />Edit title and description</button>}
          </section>
          <section className="pr-review-action">
            <span className="pr-review-kicker">Submit review</span>
            <div className="pr-review-event">
              <button className={reviewEvent === 'comment' ? 'active' : ''} disabled={actionLocked || !isOpen} onClick={() => setReviewEvent('comment')}>Comment</button>
              <button className={reviewEvent === 'approve' ? 'active' : ''} disabled={actionLocked || !isOpen || isSelfAuthored} onClick={() => setReviewEvent('approve')}>Approve</button>
              <button className={reviewEvent === 'request-changes' ? 'active' : ''} disabled={actionLocked || !isOpen} onClick={() => setReviewEvent('request-changes')}>Request changes</button>
            </div>
            {pendingComments.length > 0 && <div className="pr-pending-comments">
              <header><strong>Pending inline comments</strong><code>{pendingComments.length}</code></header>
              {pendingComments.map(comment => <div key={comment.id}><span><code>{comment.path}:{comment.line}</code><small>{comment.side}</small></span><p>{comment.body}</p><button disabled={actionLocked} onClick={() => removePendingComment(comment.id)} aria-label={`Remove pending comment on ${comment.path} line ${comment.line}`}><Icon name="close" size={10} /></button></div>)}
            </div>}
            <textarea value={reviewBody} disabled={actionLocked || !isOpen} onChange={event => setReviewBody(event.target.value)} placeholder={reviewEvent === 'approve' ? 'Optional approval note' : 'Review summary'} />
            <button className="gs-btn primary" onClick={() => void submitReview()} disabled={actionLocked || !onReview || !isOpen || (reviewEvent !== 'approve' && !reviewBody.trim()) || (reviewEvent === 'approve' && isSelfAuthored)}>Submit review</button>
            <small className="pr-review-action-help">{!isOpen ? 'Reviews can only be submitted on an open pull request.' : reviewEvent === 'approve' && isSelfAuthored ? 'GitHub does not allow an author to approve their own pull request.' : reviewEvent !== 'approve' && !reviewBody.trim() ? 'Write a review summary before submitting.' : 'This review will be submitted to GitHub.'}</small>
            {notice && <div className={`pr-review-notice ${notice.kind}`}>{notice.text}</div>}
          </section>

          <section className="pr-browser-action-evidence"><span>Readiness</span><div><span>Checks</span><strong className={detailedFailedChecks ? 'bad' : ''}>{detailedPassedChecks}/{checksContext?.checks.length ?? detail?.checks.length ?? 0}{detailedPendingChecks ? ` · ${detailedPendingChecks} pending` : ''}</strong></div><div><span>Review</span><strong>{(checksContext?.reviewDecision ?? detail?.reviewDecision)?.toLowerCase().replaceAll('_', ' ') || 'pending'}</strong></div><div><span>Merge state</span><strong>{(checksContext?.mergeStateStatus ?? detail?.mergeStateStatus)?.toLowerCase().replaceAll('_', ' ') || 'unknown'}</strong></div>{checksContext && <div><span>Requirements</span><strong className={mergeBlockers.some(blocker => blocker.kind === 'blocked') ? 'bad' : ''}>{mergeBlockers.length ? `${mergeBlockers.length} unresolved` : 'clear'}</strong></div>}<button className="pr-readiness-details" disabled={actionLocked || !detail} onClick={() => setTab('checks')}>View checks and blockers</button></section>

          {detail?.mergeStateStatus === 'BEHIND' && <section className="pr-browser-update"><span>Branch update</span><p>The head branch is behind <code>{detail.base}</code>.</p>{checksContext && !checksContext.viewerCanUpdateBranch && checksContext.viewerCannotUpdateReasons.length > 0 && <small>{checksContext.viewerCannotUpdateReasons.map(reason => reason.toLowerCase().replaceAll('_', ' ')).join(', ')}</small>}<button className="gs-btn ghost" disabled={actionLocked || !onUpdateBranch || (checksContext != null && !checksContext.viewerCanUpdateBranch)} onClick={() => void runMutation('Update branch', number => onUpdateBranch?.(number), next => `Updated #${next.number}; GitHub now reports ${next.mergeStateStatus.toLowerCase().replaceAll('_', ' ')}.`)}><Icon name="refresh" size={11} />Update branch</button></section>}

          <section className="pr-review-merge">
            <span>Merge pull request</span>
            {detail?.isDraft && <div className="pr-review-draft-gate"><span>Draft pull requests cannot be merged.</span><button className="gs-btn primary" disabled={actionLocked || !onReady} onClick={() => void runMutation('Mark ready for review', number => onReady?.(number), next => next.isDraft ? `GitHub still reports #${next.number} as a draft.` : `#${next.number} is ready for review.`)}>Mark ready for review</button></div>}
            {isOpen && detail && !detail.isDraft && (confirmAction === 'draft' ? <div className="pr-review-confirm"><span>Convert #{detail.number} back to a draft? Review and merge actions will be gated until it is ready again.</span><button className="gs-btn ghost" disabled={actionLocked} onClick={() => setConfirmAction(null)}>Cancel</button><button className="gs-btn ghost" disabled={actionLocked || !onDraft} onClick={() => void runMutation('Convert to draft', number => onDraft?.(number), next => next.isDraft ? `GitHub confirms #${next.number} is a draft.` : `GitHub still reports #${next.number} as ready.`).finally(() => setConfirmAction(null))}>Convert to draft</button></div> : <button className="pr-review-secondary-action" disabled={actionLocked || !onDraft} onClick={() => setConfirmAction('draft')}>Convert to draft</button>)}
            <select value={mergeMethod} disabled={actionLocked || !isOpen || detail?.isDraft} onChange={event => setMergeMethod(event.target.value as GitHubMergeMethod)} aria-label="Merge method"><option value="merge">Create merge commit</option><option value="squash">Squash and merge</option><option value="rebase">Rebase and merge</option></select>
            {confirmAction === 'merge' ? <div className="pr-review-confirm"><span>Merge #{selected?.number} <code>{detail?.head}</code> into <code>{detail?.base}</code> with {mergeMethod}, only if the head still matches <code>{checksContext?.headCommitId.slice(0, 12)}</code>?</span><button className="gs-btn ghost" disabled={actionLocked} onClick={() => setConfirmAction(null)}>Cancel</button><button className="gs-btn primary" disabled={actionLocked || !onMerge || mergeBlockers.length > 0} onClick={() => void runMutation('Merge pull request', number => onMerge?.(number, mergeMethod, checksContext?.headCommitId), next => { if (next.state === 'MERGED') setFilter('all'); return next.state === 'MERGED' ? `GitHub confirms #${next.number} is merged.` : `GitHub did not confirm #${next.number} as merged; it currently reports ${next.state.toLowerCase()}.` }).finally(() => setConfirmAction(null))}>Confirm merge</button></div> : confirmAction === 'queue' ? <div className="pr-review-confirm"><span>Submit #{selected?.number} <code>{detail?.head}</code> → <code>{detail?.base}</code> to GitHub's merge queue at head <code>{checksContext?.headCommitId.slice(0, 12)}</code>? If requirements are pending, GitHub will enable automatic queueing.</span><button className="gs-btn ghost" disabled={actionLocked} onClick={() => setConfirmAction(null)}>Cancel</button><button className="gs-btn primary" disabled={actionLocked || !onMergeAutomation} onClick={() => void performMergeAutomation('queue')}>Confirm queue</button></div> : <button className="gs-btn primary" disabled={actionLocked || !onMerge || !isOpen || detail?.isDraft || checksContext?.isInMergeQueue} onClick={() => void prepareMergeConfirmation('merge')}><Icon name="gitMerge" size={11} />{checksContext?.isMergeQueueEnabled ? 'Add to merge queue' : 'Merge pull request'}</button>}
            <small className="pr-review-action-help">{detail?.isDraft ? 'Mark this pull request ready before merging.' : !isOpen ? 'Only an open pull request can be merged.' : checksContext?.isInMergeQueue ? 'GitHub reports this pull request is already in the merge queue.' : mergeBlockers.length ? `${mergeBlockers[0].title}: ${mergeBlockers[0].detail}` : 'CrewCode reloads GitHub requirements and pins the exact head commit before merging.'}</small>

            {checksContext?.autoMerge || checksContext?.isInMergeQueue ? <div className="pr-merge-automation-state"><strong>{checksContext.isInMergeQueue ? 'Merge queue active' : 'Auto-merge active'}</strong><span>{checksContext.mergeQueueEntry?.position ? `Queue position ${checksContext.mergeQueueEntry.position}.` : checksContext.autoMerge?.mergeMethod ? `Method: ${checksContext.autoMerge.mergeMethod}.` : 'Waiting for GitHub requirements.'}</span>{checksContext.viewerCanDisableAutoMerge && (confirmAction === 'disable-auto' ? <div className="pr-review-confirm"><span>Disable automatic merging for #{selected?.number}?</span><button className="gs-btn ghost" disabled={actionLocked} onClick={() => setConfirmAction(null)}>Cancel</button><button className="gs-btn danger" disabled={actionLocked || !onMergeAutomation} onClick={() => void performMergeAutomation('disable')}>Disable</button></div> : <button className="pr-review-secondary-action" disabled={actionLocked} onClick={() => setConfirmAction('disable-auto')}>Disable automatic merge</button>)}</div> : checksContext?.viewerCanEnableAutoMerge && !checksContext.isMergeQueueEnabled && (confirmAction === 'auto' ? <div className="pr-review-confirm"><span>Enable auto-merge for #{selected?.number} with {mergeMethod} when GitHub's required checks and reviews pass, pinned to <code>{checksContext.headCommitId.slice(0, 12)}</code>?</span><button className="gs-btn ghost" disabled={actionLocked} onClick={() => setConfirmAction(null)}>Cancel</button><button className="gs-btn primary" disabled={actionLocked || !onMergeAutomation} onClick={() => void performMergeAutomation('enable')}>Enable auto-merge</button></div> : <button className="gs-btn ghost" disabled={actionLocked || !isOpen || detail?.isDraft} onClick={() => void prepareMergeConfirmation('auto')}>Enable auto-merge</button>)}

            {showConflictFlow && isOpen && <div className="pr-review-conflict-flow">
              <strong>Resolve merge conflicts locally</strong>
              <span>CrewCode will fetch <code>origin/{detail?.base}</code> and merge it into the current <code>{detail?.head}</code> worktree. It refuses a different branch or any uncommitted changes.</span>
              {conflictPreparation?.ok ? <button className="gs-btn primary" disabled={actionLocked} onClick={() => setTab('conflicts')}>Open conflict workspace</button> : confirmAction === 'resolve' ? <div className="pr-review-confirm"><span>Start conflict resolution for #{selected?.number} by merging <code>origin/{detail?.base}</code> into <code>{detail?.head}</code>?</span><button className="gs-btn ghost" disabled={actionLocked} onClick={() => setConfirmAction(null)}>Cancel</button><button className="gs-btn primary" disabled={actionLocked || !onPrepareConflicts} onClick={() => void prepareConflicts()}>{actionLocked ? 'Preparing…' : 'Start resolution'}</button></div> : <button className="gs-btn ghost" disabled={actionLocked || !onPrepareConflicts} onClick={() => setConfirmAction('resolve')}>Resolve conflicts in CrewCode</button>}
            </div>}
          </section>

          {isOpen && <section className="pr-browser-close-action"><span>Close pull request</span>{confirmAction === 'close' ? <div className="pr-review-confirm"><span>Close #{selected?.number} without merging <code>{detail?.head}</code> into <code>{detail?.base}</code>?</span><button className="gs-btn ghost" disabled={actionLocked} onClick={() => setConfirmAction(null)}>Cancel</button><button className="gs-btn danger" disabled={actionLocked || !onClosePr} onClick={() => void runMutation('Close pull request', number => onClosePr?.(number), next => { if (next.state === 'CLOSED') setFilter('all'); return next.state === 'CLOSED' ? `GitHub confirms #${next.number} is closed.` : `Close command completed; GitHub currently reports #${next.number} as ${next.state.toLowerCase()}.` }).finally(() => setConfirmAction(null))}>Confirm close</button></div> : <button className="pr-review-close-pr" disabled={actionLocked || !onClosePr} onClick={() => setConfirmAction('close')}>Close pull request</button>}</section>}

          {detail?.state === 'CLOSED' && <section className="pr-browser-close-action"><span>Reopen pull request</span>{confirmAction === 'reopen' ? <div className="pr-review-confirm"><span>Reopen #{detail.number} from <code>{detail.head}</code> into <code>{detail.base}</code>?</span><button className="gs-btn ghost" disabled={actionLocked} onClick={() => setConfirmAction(null)}>Cancel</button><button className="gs-btn primary" disabled={actionLocked || !onReopen} onClick={() => void runMutation('Reopen pull request', number => onReopen?.(number), next => next.state === 'OPEN' ? `GitHub confirms #${next.number} is open.` : `GitHub currently reports #${next.number} as ${next.state.toLowerCase()}.`).finally(() => setConfirmAction(null))}>Confirm reopen</button></div> : <button className="gs-btn ghost" disabled={actionLocked || !onReopen} onClick={() => setConfirmAction('reopen')}>Reopen pull request</button>}</section>}

          <section className="pr-browser-copy-evidence"><span>Identity and branches</span><button disabled={actionLocked} onClick={() => void copyEvidence('PR number', `#${selected?.number}`)}><code>#{selected?.number}</code><Icon name="copy" size={10} /></button><button disabled={actionLocked || !selected?.url} onClick={() => void copyEvidence('PR URL', selected?.url ?? '')}><span>Pull request URL</span><Icon name="copy" size={10} /></button><div className="pr-browser-route"><button disabled={actionLocked} onClick={() => void copyEvidence('Head branch', detail?.head ?? selected?.head ?? '')}><code>{detail?.head ?? selected?.head ?? '—'}</code><Icon name="copy" size={9} /></button><Icon name="chevRight" size={10} /><button disabled={actionLocked} onClick={() => void copyEvidence('Base branch', detail?.base ?? selected?.base ?? '')}><code>{detail?.base ?? selected?.base ?? '—'}</code><Icon name="copy" size={9} /></button></div>{detail && <div className="pr-browser-branch-evidence"><span>Head commit</span><code>{detail.headCommitId ? detail.headCommitId.slice(0, 12) : 'unavailable'}</code><span>GitHub updated</span><time dateTime={detail.updatedAt}>{exactDateLabel(detail.updatedAt)}</time></div>}</section>
          <section className="pr-browser-metadata"><span>People and labels</span><button className="gs-btn ghost" disabled={actionLocked || !detail} onClick={() => setManagementOpen(value => !value)}><Icon name="settings" size={11} />{managementOpen ? 'Hide management' : 'Manage'}</button>{managementLoading && <p>Loading GitHub choices…</p>}{managementError && <p className="bad">{managementError}</p>}
            <div className="pr-browser-metadata-group"><strong>Reviewers</strong><div className="pr-browser-people">{(detail?.reviewers ?? (selected?.reviewers ?? []).map(login => ({ login, state: 'REQUESTED' }))).map(person => <div key={person.login}><b>{person.login[0]?.toUpperCase()}</b><strong>{person.login}</strong><small>{person.state.toLowerCase().replaceAll('_', ' ')}</small>{managementOpen && person.state === 'REQUESTED' && <button disabled={actionLocked || !onMetadata} onClick={() => void changeMetadata('reviewer', 'remove', person.login)} aria-label={`Remove reviewer ${person.login}`}><Icon name="close" size={9} /></button>}</div>)}{!detail?.reviewers.length && !selected?.reviewers.length && <em>None</em>}</div>{managementOpen && <div className="pr-browser-metadata-add"><input list="pr-reviewer-options" value={metadataValue.reviewer} disabled={actionLocked} onChange={event => setMetadataValue(current => ({ ...current, reviewer: event.target.value }))} placeholder="GitHub username or team" /><datalist id="pr-reviewer-options">{[...new Set([...(managementContext?.suggestedReviewers ?? []), ...(managementContext?.assignableUsers ?? [])])].map(login => <option key={login} value={login} />)}</datalist><button disabled={actionLocked || !metadataValue.reviewer.trim() || !onMetadata} onClick={() => void changeMetadata('reviewer', 'add', metadataValue.reviewer)}>Add</button></div>}</div>
            <div className="pr-browser-metadata-group"><strong>Assignees</strong><div className="pr-browser-people">{(detail?.assignees ?? selected?.assignees ?? []).map(login => <div key={login}><b>{login[0]?.toUpperCase()}</b><strong>{login}</strong>{managementOpen && <button disabled={actionLocked || !onMetadata} onClick={() => void changeMetadata('assignee', 'remove', login)} aria-label={`Remove assignee ${login}`}><Icon name="close" size={9} /></button>}</div>)}{!detail?.assignees.length && !selected?.assignees.length && <em>None</em>}</div>{managementOpen && <div className="pr-browser-metadata-add"><input list="pr-assignee-options" value={metadataValue.assignee} disabled={actionLocked} onChange={event => setMetadataValue(current => ({ ...current, assignee: event.target.value }))} placeholder="GitHub username" /><datalist id="pr-assignee-options">{(managementContext?.assignableUsers ?? []).map(login => <option key={login} value={login} />)}</datalist><button disabled={actionLocked || !metadataValue.assignee.trim() || !onMetadata} onClick={() => void changeMetadata('assignee', 'add', metadataValue.assignee)}>Add</button></div>}</div>
            <div className="pr-browser-metadata-group"><strong>Labels</strong><div className="pr-browser-labels">{(detail?.labels ?? selected?.labels ?? []).map(label => <code key={label}>{label}{managementOpen && <button disabled={actionLocked || !onMetadata} onClick={() => void changeMetadata('label', 'remove', label)} aria-label={`Remove label ${label}`}><Icon name="close" size={8} /></button>}</code>)}{!detail?.labels.length && !selected?.labels.length && <em>None</em>}</div>{managementOpen && <div className="pr-browser-metadata-add"><input list="pr-label-options" value={metadataValue.label} disabled={actionLocked} onChange={event => setMetadataValue(current => ({ ...current, label: event.target.value }))} placeholder="Repository label" /><datalist id="pr-label-options">{(managementContext?.labels ?? []).map(label => <option key={label} value={label} />)}</datalist><button disabled={actionLocked || !metadataValue.label.trim() || !onMetadata} onClick={() => void changeMetadata('label', 'add', metadataValue.label)}>Add</button></div>}</div>
          </section>
          <section className="pr-browser-metrics"><div><span>Files</span><strong>{detail?.files.length ?? '—'}</strong></div><div><span>Lines</span><strong>{detail ? `+${detail.additions} −${detail.deletions}` : '—'}</strong></div><div><span>Checks</span><strong>{detail?.checks.length ?? '—'}</strong></div><div><span>Comments</span><strong>{detail?.comments.length ?? '—'}</strong></div></section>
        </aside>
      </div>
    </div>,
    document.body,
  )
}

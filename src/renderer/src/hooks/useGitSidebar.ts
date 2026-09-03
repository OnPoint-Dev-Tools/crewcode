/* useGitSidebar — produces the GitState the Git Sidebar consumes from the
 * real git + GitHub IPC layer (src/main/git.ts, gh.ts, worktree:*).
 *
 * Every sidebar affordance is wired here. Action results surface as a
 * transient banner inside the sidebar. */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { Worktree, GitHubRun } from '../types'
import type {
  GitState, GitChange, GitConflict, GitPrRef, GitHistoryEntry,
  GitBranchRef, GitWorktreeRef, GitBanner, ChangeStatus, CheckState, GitSidebarHandlers,
  GitActionOutcome,
} from '../components/git/git-state'
import { getCrewCodeClient } from '../runtime/crewcode-client'

/** Synthetic id for the repo's primary checkout — git's worktree list omits it. */
const MAIN_ID = '__main__'

const EMPTY_STATE: GitState = {
  ahead: 0, behind: 0, branch: '', lastFetch: 'never', remoteUrl: '', currentWorktree: '',
  branches: [], changes: [], conflicts: [], worktrees: [], prs: [], history: [],
  isRepo: true, hasRemote: true, hasUpstream: true,
}

/** Split a repo-relative path into basename + dirname-with-trailing-slash. */
function splitPath(p: string): { name: string; dir: string } {
  const norm = p.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return idx < 0
    ? { name: norm, dir: '' }
    : { name: norm.slice(idx + 1), dir: norm.slice(0, idx + 1) }
}

/** `git status --porcelain` renames render as "orig -> dest"; keep the dest. */
function cleanPath(raw: string): string {
  const arrow = raw.indexOf(' -> ')
  return arrow >= 0 ? raw.slice(arrow + 4) : raw
}

/** Map a porcelain status char to the sidebar's status enum. */
function toChangeStatus(raw: string): ChangeStatus {
  const c = (raw || '').trim().toUpperCase()[0] ?? 'M'
  if (c === 'U') return 'U'
  if (c === 'A' || c === 'D' || c === 'R') return c
  if (c === '?') return 'A'  // untracked → shown as added
  return 'M'
}

/** Collapse a GitHub Actions run into a pass/fail/pending/skipped dot. */
function runState(r: GitHubRun): CheckState {
  if (r.status !== 'completed') return 'p'
  if (r.conclusion === 'success') return 'ok'
  if (r.conclusion === 'failure' || r.conclusion === 'cancelled') return 'f'
  return 's'
}

function githubPrUrl(remoteUrl: string, num: number): string | null {
  const normalized = remoteUrl.trim().replace(/^https?:\/\//, '').replace(/\.git$/, '')
  return normalized ? `https://${normalized}/pull/${num}` : null
}

export interface GitAuthRequest {
  remoteUrl?: string
  error?: string
}

export interface GitAuthCredentials {
  username: string
  password: string
}

export interface GitSigningRequest {
  error?: string
}

export interface UseGitSidebarArgs {
  repoPath:          string                       // effective path — worktree or workspace
  workspacePath:     string                       // repo root, for worktree + GitHub lookups
  mainBranch:        string                       // branch of the primary checkout
  comparisonRef?:    string                       // Settings-selected review base
  currentWorktreeId: string | null
  enabled:           boolean                      // only fetch while the sidebar is open
  onSwitchWorktree:  (id: string | null) => void  // App owns worktree selection
  onAskAgent?:       (text: string, targetTabId?: string) => void  // delegate a task to a chat tab's agent
  onWorktreesChanged?: () => void | Promise<void> // worktree added/removed — refresh app state
  onRequestGitAuth?: (request: GitAuthRequest) => Promise<GitAuthCredentials | null>
  // Resolve a commit signing-key passphrase, or null if the user declines signing.
  onRequestSigningPassphrase?: (request: GitSigningRequest) => Promise<string | null>
  // When true, skip the passphrase prompt entirely and commit unsigned on a
  // signing failure (Settings → "always commit unsigned").
  alwaysCommitUnsigned?: boolean
}

export interface UseGitSidebarResult {
  state:    GitState
  handlers: GitSidebarHandlers
  refresh:  () => Promise<void>
}

// `warn` lets an action report success-with-a-caveat (e.g. committed unsigned).
type ActionResult = { ok?: boolean; error?: string; warn?: string } | void | undefined

export function useGitSidebar(args: UseGitSidebarArgs): UseGitSidebarResult {
  const {
    repoPath, workspacePath, mainBranch, comparisonRef, currentWorktreeId,
    enabled, onSwitchWorktree, onAskAgent, onWorktreesChanged, onRequestGitAuth, onRequestSigningPassphrase,
    alwaysCommitUnsigned,
  } = args

  // Read the latest toggle inside handlers without rebuilding them on every flip.
  const alwaysUnsignedRef = useRef(alwaysCommitUnsigned)
  alwaysUnsignedRef.current = alwaysCommitUnsigned

  const [state, setState] = useState<GitState>(EMPTY_STATE)
  const [actionBanner, setActionBanner] = useState<GitBanner | null>(null)

  const lastFetchRef = useRef<string>('never')
  const worktreesRef = useRef<Worktree[]>([])   // extra worktrees (no primary)
  const prsRef       = useRef<GitPrRef[]>([])
  const bannerTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  // GitHub data is slow / rate-limited — refreshed only on open + manual fetch.
  const ghRef = useRef<{ prs: GitPrRef[]; remoteUrl: string }>({ prs: [], remoteUrl: '' })

  const showBanner = useCallback((b: GitBanner | null) => {
    if (bannerTimer.current) { clearTimeout(bannerTimer.current); bannerTimer.current = null }
    setActionBanner(b)
    if (b && b.auto && b.auto > 0) {
      bannerTimer.current = setTimeout(() => setActionBanner(null), b.auto)
    }
  }, [])

  useEffect(() => () => { if (bannerTimer.current) clearTimeout(bannerTimer.current) }, [])

  const refresh = useCallback(async (opts?: { github?: boolean }) => {
    const api = getCrewCodeClient()
    if (!repoPath) { setState(EMPTY_STATE); return }

    if (opts?.github) {
      const gh = await api.githubStatus(workspacePath).catch(() => null)
      const ghData = gh && !('error' in gh) ? gh : null
      if (ghData) {
        const runs: GitHubRun[] = ghData.runs ?? []
        ghRef.current = {
          remoteUrl: `github.com/${ghData.owner}/${ghData.repo}`,
          prs: (ghData.prs ?? []).map(pr => {
            const prRuns = runs.filter(r => r.branch === pr.branch)
            return {
              num:     pr.number,
              status:  pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open',
              title:   pr.title,
              head:    pr.branch,
              base:    pr.base || comparisonRef || mainBranch,
              author:  pr.author || '',
              updated: pr.updatedAt || '',
              url:     pr.url,
              body:    pr.body,
              mergeStateStatus: pr.mergeStateStatus,
              reviewDecision: pr.reviewDecision,
              checks:  prRuns.map(runState),
              runs:    prRuns.map(r => ({ name: r.name, state: runState(r), dur: '' })),
            }
          }),
        }
      }
    }

    const [st, log, br, wt, auth, rem, compared] = await Promise.all([
      api.gitStatus(repoPath).catch(() => null),
      api.gitLog(repoPath, 30).catch(() => null),
      api.gitBranches(repoPath).catch(() => null),
      api.worktreeList(workspacePath).catch(() => null),
      api.ghStatus().catch(() => null),
      api.gitRemotes(repoPath).catch(() => null),
      comparisonRef ? api.gitChangesVsRef(repoPath, comparisonRef).catch(() => null) : Promise.resolve(null),
    ])

    // Publish affordance keys off these: a folder that isn't a repo, or a repo
    // with zero remotes, has nothing to push to yet.
    const isRepo    = rem ? rem.isRepo !== false : true
    const hasRemote = isRepo && (rem?.remotes?.length ?? 0) > 0

    const user = auth?.user ?? undefined
    const stOk = !!st && !st.error

    // Working-tree changes + conflict derivation.
    const changes: GitChange[] = []
    const conflictPaths = new Set<string>()
    if (stOk) {
      const all = [...(st!.staged ?? []), ...(st!.unstaged ?? []), ...(st!.untracked ?? [])]
      for (const f of all) {
        const path   = cleanPath(f.path)
        const status = toChangeStatus(f.status)
        if (status === 'U') conflictPaths.add(path)
        const { name, dir } = splitPath(path)
        changes.push({ staged: f.staged, status, path, name, dir })
      }
    }
    // A clean worktree can still contain committed work relative to the chosen
    // base. Add those paths as review-only; local status rows retain staging.
    if (comparisonRef && compared && !compared.error) {
      for (const file of compared.files ?? []) {
        const path = cleanPath(file.path)
        if (!path || changes.some(change => change.path === path)) continue
        const { name, dir } = splitPath(path)
        changes.push({ staged: false, stageable: false, status: toChangeStatus(file.status), path, name, dir })
      }
    }
    const conflicts: GitConflict[] = [...conflictPaths].map(path => ({ path, hunks: 0 }))

    const branches: GitBranchRef[] = (br?.branches ?? []).map(b => ({
      kind: 'local', name: b.name, updated: '',
    }))

    // Worktree list = synthetic primary checkout + git's extra worktrees.
    const rawWt = wt?.worktrees ?? []
    worktreesRef.current = rawWt
    const worktrees: GitWorktreeRef[] = [
      { id: MAIN_ID, branch: mainBranch, path: workspacePath, dirty: 0, ahead: 0, behind: 0, agent: null },
      ...rawWt.map(w => ({
        id: w.id, branch: w.branch, path: w.path,
        dirty: w.dirty, ahead: 0, behind: 0, agent: null as string | null,
      })),
    ]
    const currentWorktree = currentWorktreeId ?? MAIN_ID

    const history: GitHistoryEntry[] = (log?.commits ?? []).map(c => ({
      sha:    c.hash,
      msg:    c.message,
      author: c.author,
      when:   c.date,
      you:    user ? c.author === user : false,
      merge:  c.message.startsWith('Merge '),
    }))

    const banner = conflicts.length > 0
      ? {
          kind: 'warn' as const,
          text: `merge in progress · ${conflicts.length} file${conflicts.length === 1 ? '' : 's'} conflicted`,
          auto: 0,
        }
      : comparisonRef && compared?.error
        ? { kind: 'warn' as const, text: `default branch ${comparisonRef}: ${compared.error}`, auto: 0 }
        : undefined

    prsRef.current = ghRef.current.prs
    setState({
      ahead:     stOk ? (st!.ahead ?? 0)  : 0,
      behind:    stOk ? (st!.behind ?? 0) : 0,
      branch:    stOk ? (st!.branch || '') : '',
      lastFetch: lastFetchRef.current,
      remoteUrl: ghRef.current.remoteUrl || rem?.remoteUrls?.[0] || '',
      currentWorktree,
      branches,
      changes,
      conflicts,
      mergeInProgress: stOk ? st!.mergeInProgress === true : false,
      worktrees,
      prs:       ghRef.current.prs,
      history,
      banner,
      user,
      isRepo,
      hasRemote,
      hasUpstream: stOk ? st!.hasUpstream : true,
      comparisonRef,
      defaultBase: comparisonRef || mainBranch,
    })
  }, [repoPath, workspacePath, mainBranch, comparisonRef, currentWorktreeId])

  // Fetch shortly after opening so the sidebar can paint/animate first; GitHub
  // status is the slow path and should not make the pane feel blocked.
  useEffect(() => {
    if (!enabled) return
    const initial = setTimeout(() => refresh({ github: true }), 180)
    const poll = setInterval(() => refresh(), 30_000)
    return () => {
      clearTimeout(initial)
      clearInterval(poll)
    }
  }, [enabled, refresh])

  /** Run an action, surface pending / done / error as a sidebar banner, then refresh. */
  const runAction = useCallback(async (
    pending: string,
    fn: () => Promise<ActionResult>,
    okText: string,
    opts?: { github?: boolean },
  ): Promise<boolean> => {
    showBanner({ kind: '', text: pending, spinning: true, auto: 0 })
    let ok = false
    try {
      const r = await fn()
      if (r && r.error)     showBanner({ kind: 'err', text: r.error, auto: 7000 })
      else if (r && r.warn) { showBanner({ kind: 'warn', text: r.warn, auto: 7000 }); ok = true }
      else                  { showBanner({ kind: '', text: okText, auto: 3000 }); ok = true }
    } catch (e) {
      showBanner({ kind: 'err', text: e instanceof Error ? e.message : String(e), auto: 7000 })
    }
    await refresh(opts)
    return ok
  }, [showBanner, refresh])

  const runPrAction = useCallback(async (
    pending: string,
    fn: () => Promise<ActionResult>,
    okText: string,
  ): Promise<GitActionOutcome> => {
    showBanner({ kind: '', text: pending, spinning: true, auto: 0 })
    try {
      const result = await fn()
      if (result?.error) {
        showBanner({ kind: 'err', text: result.error, auto: 7000 })
        return { ok: false, error: result.error }
      }
      showBanner({ kind: result?.warn ? 'warn' : '', text: result?.warn ?? okText, auto: result?.warn ? 7000 : 3000 })
      await refresh({ github: true })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      showBanner({ kind: 'err', text: message, auto: 7000 })
      return { ok: false, error: message }
    }
  }, [showBanner, refresh])

  /** Resolve a worktree id (incl. the synthetic primary) to its path + branch. */
  const resolveWt = useCallback((id: string): { path: string; branch: string; isMain: boolean } | null => {
    if (id === MAIN_ID) return { path: workspacePath, branch: mainBranch, isMain: true }
    const w = worktreesRef.current.find(x => x.id === id)
    return w ? { path: w.path, branch: w.branch, isMain: false } : null
  }, [workspacePath, mainBranch])

  const isAuthFailure = (error: string | undefined): boolean => (
    !!error && /authentication failed|could not read username|could not read password|terminal prompts disabled|invalid username|permission denied|repository not found|403|401|askpass/i.test(error)
  )

  const pushWithOptionalCredentials = async (): Promise<ActionResult> => {
    const first = await window.electronAPI!.gitPush(repoPath)
    if (!first?.error || !isAuthFailure(first.error) || !onRequestGitAuth) return first
    const credentials = await onRequestGitAuth({ remoteUrl: ghRef.current.remoteUrl, error: first.error })
    if (!credentials) return first
    return window.electronAPI!.gitPushWithCredentials(repoPath, credentials.username, credentials.password)
  }

  const handlers: GitSidebarHandlers = useMemo(() => ({
    onPush:  () => runAction('pushing…',  pushWithOptionalCredentials,  'pushed'),
    onPull:  () => runAction('pulling…',  () => window.electronAPI!.gitPull(repoPath),  'pulled', { github: true }),
    onFetch: () => {
      lastFetchRef.current = 'just now'
      runAction('fetching…', () => window.electronAPI!.gitFetch(repoPath), 'fetched', { github: true })
    },
    onSync: () => runAction(
      'syncing…',
      async () => {
        const pl = await window.electronAPI!.gitPull(repoPath)
        if (pl?.error) return pl
        return pushWithOptionalCredentials()
      },
      'synced',
      { github: true },
    ),

    onCheckoutBranch: (ref) => {
      const branch = ref.replace(/^origin\//, '')
      const wt = worktreesRef.current.find(w => w.branch === branch || w.branch === ref)
      if (wt) {
        onSwitchWorktree(wt.id)
        showBanner({ kind: '', text: `opened worktree ${wt.branch}`, auto: 2500 })
        return
      }
      if (branch === mainBranch || ref === mainBranch) {
        onSwitchWorktree(null)
        showBanner({ kind: '', text: `opened ${mainBranch}`, auto: 2500 })
        return
      }
      // Never checkout another branch into this surface's current directory:
      // that directory may be the primary checkout or belong to another chat.
      // Materialize/open a worktree so branch changes remain surface-local.
      runAction(
        `opening ${ref} in a worktree…`,
        async () => {
          const created = await window.electronAPI!.worktreeCreate(
            workspacePath,
            branch,
            undefined,
            ref.startsWith('origin/') ? ref : undefined,
          )
          if (created.error || !created.path) return created
          const listed = await window.electronAPI!.worktreeList(workspacePath)
          const next = listed.worktrees?.find(candidate => candidate.path === created.path || candidate.branch === branch)
          await onWorktreesChanged?.()
          if (next) onSwitchWorktree(next.id)
          return next ? { ok: true } : { error: `created ${branch}, but could not resolve its worktree` }
        },
        `opened ${branch} in its own worktree`,
      )
    },
    onCreateBranch: (name) => {
      runAction(
        `creating ${name} in a worktree…`,
        async () => {
          const created = await window.electronAPI!.worktreeCreate(workspacePath, name)
          if (created.error || !created.path) return created
          const listed = await window.electronAPI!.worktreeList(workspacePath)
          const next = listed.worktrees?.find(candidate => candidate.path === created.path || candidate.branch === name)
          await onWorktreesChanged?.()
          if (next) onSwitchWorktree(next.id)
          return next ? { ok: true } : { error: `created ${name}, but could not resolve its worktree` }
        },
        `created ${name} in its own worktree`,
      )
    },

    onStageFile:   (p) => runAction('staging…',   () => window.electronAPI!.gitStage(repoPath, [p]),   'staged'),
    onUnstageFile: (p) => runAction('unstaging…', () => window.electronAPI!.gitUnstage(repoPath, [p]), 'unstaged'),
    // Stage/unstage all in ONE git call + ONE refetch. Stage All asks Git for
    // current state rather than replaying paths that may have moved meanwhile.
    onStageAll:    (paths) => { if (paths.length) runAction('staging…',   () => window.electronAPI!.gitStageAll(repoPath),       'staged') },
    onUnstageAll:  (paths) => { if (paths.length) runAction('unstaging…', () => window.electronAPI!.gitUnstage(repoPath, paths), 'unstaged') },
    onDiscardFile: (p) => runAction('discarding…', () => window.electronAPI!.gitDiscard(repoPath, p), 'discarded'),
    onCommit: ({ message, amend, push, sync }) => runAction(
      sync ? 'commit & sync…' : push ? 'commit & push…' : amend ? 'amending…' : 'committing…',
      async () => {
        let c = await window.electronAPI!.gitCommit(repoPath, message, amend)
        let unsigned = false
        // Commit signing can't prompt for a key passphrase in this GUI process.
        // On that failure, offer a passphrase prompt; if the user provides one we
        // retry signed (surfacing a wrong-passphrase error rather than silently
        // committing unsigned). If they decline, fall back to an unsigned commit.
        if (c?.error && c.signingFailure) {
          const passphrase = (!alwaysUnsignedRef.current && onRequestSigningPassphrase)
            ? await onRequestSigningPassphrase({ error: c.error })
            : null
          if (passphrase) {
            c = await window.electronAPI!.gitCommitWithPassphrase(repoPath, message, amend, passphrase)
          } else {
            c = await window.electronAPI!.gitCommit(repoPath, message, amend, true)
            unsigned = !c?.error
          }
        }
        if (c?.error) return c
        const warn = unsigned ? 'committed unsigned — signing key passphrase was not provided' : undefined
        if (sync) {
          const pl = await window.electronAPI!.gitPull(repoPath)
          if (pl?.error) return pl
          const ps = await pushWithOptionalCredentials()
          return ps?.error ? ps : { ...ps, warn }
        }
        if (push) {
          const ps = await pushWithOptionalCredentials()
          return ps?.error ? ps : { ...ps, warn }
        }
        return { ...c, warn }
      },
      sync ? 'committed & synced' : push ? 'committed & pushed' : amend ? 'amended' : 'committed',
      sync ? { github: true } : undefined,
    ),

    onSwitchWorktree: (id) => onSwitchWorktree(id === MAIN_ID ? null : id),
    onCreateWorktree: (branch) => {
      runAction(
        `creating worktree ${branch}…`,
        () => window.electronAPI!.worktreeCreate(workspacePath, branch),
        `worktree ${branch} created`,
      ).then(() => onWorktreesChanged?.())
    },
    onRemoveWorktree: (id) => {
      const wt = resolveWt(id)
      if (!wt || wt.isMain) {
        showBanner({ kind: 'err', text: 'cannot remove the primary checkout', auto: 5000 })
        return
      }
      runAction('removing worktree…', () => window.electronAPI!.worktreeRemove(wt.path), 'worktree removed')
        .then(ok => {
          if (!ok) return
          // The app-level workspace list refreshes async; update the sidebar's
          // local list immediately so deleted rows don't linger after removal.
          worktreesRef.current = worktreesRef.current.filter(w => w.id !== id)
          setState(prev => ({
            ...prev,
            currentWorktree: prev.currentWorktree === id ? MAIN_ID : prev.currentWorktree,
            worktrees: prev.worktrees.filter(w => w.id !== id),
          }))
          if (currentWorktreeId === id) onSwitchWorktree(null)
          onWorktreesChanged?.()
        })
    },
    onMergeWorktree: ({ from, into }) => {
      const src = resolveWt(from)
      const dst = resolveWt(into)
      if (!src || !dst) { showBanner({ kind: 'err', text: 'worktree not found', auto: 5000 }); return }
      runAction(
        `merging ${src.branch} → ${dst.branch}…`,
        () => window.electronAPI!.gitMerge(dst.path, src.branch),
        `merged ${src.branch} → ${dst.branch}`,
      )
    },

    onResolveConflict: ({ file, strategy, targetTabId }) => {
      if (strategy === 'ours' || strategy === 'theirs') {
        runAction(
          `resolving (${strategy})…`,
          () => window.electronAPI!.gitResolveConflict(repoPath, file, strategy),
          `${file} resolved (${strategy})`,
        )
      } else if (strategy === 'editor') {
        window.electronAPI?.openExternal(`file://${repoPath}/${file}`)
        showBanner({ kind: '', text: `opening ${file}…`, auto: 3000 })
      } else if (strategy === 'agent') {
        onAskAgent?.(`There's a merge conflict in \`${file}\`. Please resolve it, keeping both intents where possible, then stage the file.`, targetTabId)
        showBanner({ kind: '', text: `asked agent to resolve ${file}`, auto: 3000 })
      }
    },
    onAbortMerge:    () => runAction('aborting merge…',  () => window.electronAPI!.gitMergeAbort(repoPath),    'merge aborted'),
    onContinueMerge: () => runAction('continuing merge…', () => window.electronAPI!.gitMergeContinue(repoPath), 'merge committed'),

    onCreatePR:  (options) => runPrAction(
      'creating pull request…',
      () => getCrewCodeClient().ghPrCreate(repoPath, options),
      options.draft ? 'draft pull request created' : 'pull request created',
    ),
    onMergePR:   (num, method, headCommitId) => runPrAction(`merging #${num} with ${method}…`,  () => getCrewCodeClient().ghPrMerge(repoPath, num, method, headCommitId),   `#${num} merged with ${method}`),
    onApprovePR: (num) => runAction(`approving #${num}…`, () => window.electronAPI!.ghPrApprove(repoPath, num), `#${num} approved`, { github: true }),
    onUpdatePRBranch: (num) => runPrAction(`updating #${num}…`, () => getCrewCodeClient().ghPrUpdateBranch(repoPath, num), `#${num} updated`),
    onReadyPR: (num) => runPrAction(`marking #${num} ready for review…`, () => getCrewCodeClient().ghPrReady(repoPath, num), `#${num} is ready for review`),
    onDraftPR: (num) => runPrAction(`converting #${num} to draft…`, () => getCrewCodeClient().ghPrDraft(repoPath, num), `#${num} is now a draft`),
    onReopenPR: (num) => runPrAction(`reopening #${num}…`, () => getCrewCodeClient().ghPrReopen(repoPath, num), `#${num} reopened`),
    onEditPR: (num, options) => runPrAction(`updating #${num}…`, () => getCrewCodeClient().ghPrEdit(repoPath, num, options), `#${num} details updated`),
    onMetadataPR: (num, options) => runPrAction(`${options.operation === 'add' ? 'adding' : 'removing'} ${options.kind} on #${num}…`, () => getCrewCodeClient().ghPrMetadata(repoPath, num, options), `#${num} ${options.kind} updated`),
    onRerunPRCheck: (num, options) => runPrAction(`requesting check rerun for #${num}…`, () => getCrewCodeClient().ghPrCheckRerun(repoPath, num, options), `check rerun requested for #${num}`),
    onMergeAutomationPR: (num, options) => runPrAction(`${options.action === 'disable' ? 'disabling auto-merge' : options.action === 'queue' ? 'submitting to merge queue' : 'enabling auto-merge'} for #${num}…`, () => getCrewCodeClient().ghPrMergeAutomation(repoPath, num, options), `merge automation updated for #${num}`),
    onPreparePRConflicts: async (head, base) => {
      showBanner({ kind: '', text: `merging origin/${base} into ${head}…`, spinning: true, auto: 0 })
      try {
        const result = await getCrewCodeClient().ghPrPrepareConflictResolution(repoPath, head, base)
        if (!result.ok) showBanner({ kind: 'err', text: result.error || 'Could not start conflict resolution', auto: 8000 })
        else if (result.status === 'conflicts') showBanner({ kind: 'warn', text: `merge started · ${result.conflicts.length} conflict${result.conflicts.length === 1 ? '' : 's'} to resolve`, auto: 0 })
        else if (result.status === 'ready-to-continue') showBanner({ kind: 'warn', text: 'all conflicts resolved · continue the merge', auto: 0 })
        else showBanner({ kind: '', text: `${base} merged locally · push ${head} to update the PR`, auto: 0 })
        await refresh({ github: false })
        return result
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        showBanner({ kind: 'err', text: message, auto: 8000 })
        return { ok: false, conflicts: [], output: '', error: message }
      }
    },
    onCommentPR: (num, body) => runAction(`commenting on #${num}…`, () => getCrewCodeClient().ghPrComment(repoPath, num, body), `comment added to #${num}`, { github: true }),
    onClosePR: (num) => runPrAction(`closing #${num}…`, () => getCrewCodeClient().ghPrClose(repoPath, num), `#${num} closed`),
    onReviewPR: (num, options) => runPrAction(`submitting review for #${num}…`, () => getCrewCodeClient().ghPrReview(repoPath, num, options), `review submitted for #${num}`),
    onOpenPR: (num) => {
      const pr = prsRef.current.find(p => p.num === num)
      const url = pr?.url ?? githubPrUrl(ghRef.current.remoteUrl, num)
      if (url) window.electronAPI?.openExternal(url)
      else showBanner({ kind: 'err', text: `could not find URL for PR #${num}`, auto: 5000 })
    },

    // Init + publish both run against workspacePath (the repo root) — worktrees
    // can't be the source of a fresh repo or `gh repo create`.
    onInitRepo: () => runAction(
      'initializing repo…',
      () => window.electronAPI!.gitInit(workspacePath),
      'repository initialized — commit, then publish',
    ),
    onPublish: (opts) => runAction(
      `publishing ${opts.name}…`,
      () => window.electronAPI!.ghRepoCreate(workspacePath, opts),
      `published ${opts.name}`,
      { github: true },
    ),
  }), [repoPath, workspacePath, mainBranch, runAction, resolveWt, showBanner,
       onSwitchWorktree, onAskAgent, onWorktreesChanged, onRequestGitAuth, onRequestSigningPassphrase, runPrAction, refresh])

  // Action banner takes precedence over the derived conflict banner.
  const mergedState = useMemo(
    () => actionBanner ? { ...state, banner: actionBanner } : state,
    [state, actionBanner],
  )

  return { state: mergedState, handlers, refresh: () => refresh({ github: true }) }
}

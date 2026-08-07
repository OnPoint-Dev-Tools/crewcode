// Renderer half of the delegation API. Main owns the loopback HTTP socket and
// marshals each call in over `delegation:request`; this hook performs it against
// the real session/message/bridge state and answers by correlation id.
//
// Session state lives here, not in main, so every route is a round trip. Handlers
// must therefore always answer — a thrown error that never replies leaves the
// delegating agent's curl hanging until main's 10s timeout.

import { useEffect, useRef } from 'react'
import type { DelegationRendererRequest, DelegationResult } from '../../../shared/delegation-types'
import type { Session } from '../types'
import { childrenOf, detailThread, summarizeThread } from './delegated-thread-projection'
import { canSessionDelegate, DELEGATION_DEPTH_REFUSAL } from './delegation-eligibility'
import { isSelectionError, resolveProviderSelection } from './delegation-provider-selection'
import type { DelegatedSpawn } from './useChatSessions'
import type { DelegationProviderInfo } from '../../../shared/delegation-types'

export interface DelegatedThreadsDeps {
  /** Every live session across every tab, so a child can be found by id alone. */
  allSessions: () => Session[]
  /** Tab that owns the delegating session — read-only children are created there
   *  and inherit its cwd. */
  tabIdForSession: (sessionId: string) => string | undefined
  messagesForSession: (sessionId: string) => import('../types').Message[]
  isRunning: (sessionId: string) => boolean
  completedAtForSession: (sessionId: string) => number | undefined
  addDelegated: (tabId: string, spawn: DelegatedSpawn) => Session | null
  /** Deliver a prompt into a session, starting its bridge if needed. */
  sendToSession: (session: Session, text: string) => Promise<void>
  /** Mark a thread done / not-done. Deliberately NOT archiving: an agent must
   *  never be able to decide the user is finished with a chat and hide it. This
   *  only frees a concurrency slot and dims the drawer row. */
  setThreadClosed: (tabId: string, sessionId: string, closed: boolean) => void
  /** Live provider registry, so a spawn's agentId/model is validated against what
   *  can actually run rather than accepted and failed later at bridge start. */
  providers: () => DelegationProviderInfo[]
  /** Navigate the UI to a thread — switching workspace and tab as needed. */
  focusSession: (session: Session) => void
  /** Create an isolated worktree for a write-capable spawn. Returns the branch,
   *  path, and the commit it forked from (the ref its work merges back onto). */
  createWorktree: (parentSessionId: string, title: string) => Promise<
    | { ok: true; path: string; branch: string; base?: string }
    | { ok: false; error: string }
  >
  /** Repository root for a session's workspace — where a merge fast-forwards. */
  repoPathForSession: (sessionId: string) => string | undefined
  /** Cohort id for threads spawned right now, and whether the spawning turn was
   *  autonomous. Read at spawn because neither is recoverable later. */
  spawnCohort: (parentSessionId: string) => { runId: string; duringWake: boolean }
}

function ok<T>(data: T): DelegationResult<T> {
  return { ok: true, data }
}

function fail(error: string, status?: number): DelegationResult<never> {
  return { ok: false, error, ...(status != null ? { status } : {}) }
}

export function useDelegatedThreads(deps: DelegatedThreadsDeps): void {
  // Handlers run from an IPC callback registered once; reading deps through a ref
  // keeps that subscription stable instead of resubscribing on every App render.
  const depsRef = useRef(deps)
  depsRef.current = deps

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onDelegationRequest) return

    const findChild = (parentSessionId: string, threadId: string): Session | undefined =>
      childrenOf(parentSessionId, depsRef.current.allSessions()).find(s => s.id === threadId)

    async function perform(request: DelegationRendererRequest): Promise<DelegationResult<unknown>> {
      const d = depsRef.current
      const parent = d.allSessions().find(s => s.id === request.sessionId)
      // Credentials outlive their session if it was deleted mid-turn.
      if (!parent) return fail('the delegating chat no longer exists', 410)
      // Depth-1, enforced at the API rather than only by withholding credentials.
      // This is the layer that holds when a token reaches a delegated thread by
      // some route the UI and the minting path did not anticipate.
      if (!canSessionDelegate(parent)) return fail(DELEGATION_DEPTH_REFUSAL, 403)

      switch (request.kind) {
        case 'list': {
          const rows = childrenOf(request.sessionId, d.allSessions())
            .map(child => summarizeThread(
              child,
              d.messagesForSession(child.id),
              d.isRunning(child.id),
              d.completedAtForSession(child.id),
            ))
          return ok(rows)
        }

        case 'providers':
          return ok(d.providers())

        case 'create': {
          const parentTabId = d.tabIdForSession(request.sessionId)
          if (!parentTabId) return fail('the delegating chat has no workspace tab', 409)

          // Validate the provider/model BEFORE creating anything: an unknown id
          // accepted here becomes a thread that dies at bridge start, leaving a
          // dead row in the drawer with an error the agent can't act on.
          const selection = resolveProviderSelection(
            { agentId: request.request.agentId, model: request.request.model },
            { agentId: parent.agentId, model: parent.model },
            d.providers(),
          )
          if (isSelectionError(selection)) return fail(selection.error, selection.status)

          // Write-capable threads fork their own worktree. Do this BEFORE creating
          // the session: a failed `worktree add` must not leave a thread pointing
          // at the parent's checkout, which is exactly what isolation prevents.
          //
          // The child still lives in the parent's TAB. cwd is resolved per send
          // from `session.delegatedWorktreePath`, so the bridge runs in the
          // isolated checkout without the workspace's active worktree (which is
          // per-workspace, and shared with the parent) having to change.
          let worktree: { path: string; branch: string; base?: string } | undefined
          // Only `worktree` isolation touches git. `build` + `shared` runs in the
          // parent's checkout and works in a plain folder — gating shell access on
          // git repo status was the bug that made test-running impossible.
          if (request.request.isolation === 'worktree') {
            const created = await d.createWorktree(request.sessionId, request.request.title)
            if (!created.ok) return fail(created.error, 409)
            worktree = { path: created.path, branch: created.branch, base: created.base }
          }

          const child = d.addDelegated(parentTabId, {
            title: request.request.title,
            parentSessionId: request.sessionId,
            mode: request.request.mode,
            agentId: selection.agentId,
            model: selection.model,
            // Cohort + provenance are stamped at spawn, because at report time
            // there is no way to reconstruct which request a thread belonged to
            // or whether an autonomous turn created it.
            runId: d.spawnCohort(request.sessionId).runId,
            duringWake: d.spawnCohort(request.sessionId).duringWake,
            ...(worktree ? { worktreePath: worktree.path, branch: worktree.branch, base: worktree.base } : {}),
          })
          if (!child) return fail('could not create the delegated thread', 500)

          // Answer only after the prompt is accepted: an agent that gets an id
          // back must be able to poll it, not race the thread's first turn.
          await d.sendToSession(child, request.request.prompt)
          return ok(summarizeThread(child, d.messagesForSession(child.id), true))
        }

        case 'read': {
          const child = findChild(request.sessionId, request.threadId)
          if (!child) return fail('no such delegated thread', 404)
          return ok(detailThread(
            child,
            d.messagesForSession(child.id),
            d.isRunning(child.id),
            d.completedAtForSession(child.id),
          ))
        }

        case 'message': {
          const child = findChild(request.sessionId, request.threadId)
          if (!child) return fail('no such delegated thread', 404)
          if (child.archived) return fail('that thread was archived by the user', 409)
          // More work reopens a thread the agent had marked done, so it counts
          // against the concurrency cap again while it is actually working.
          if (child.delegationClosedAt != null) d.setThreadClosed(child.tabId, child.id, false)
          await d.sendToSession(child, request.text)
          return ok({ delivered: true })
        }

        case 'close': {
          const child = findChild(request.sessionId, request.threadId)
          if (!child) return fail('no such delegated thread', 404)
          if (child.archived || child.delegationClosedAt != null) return ok({ closed: true })
          d.setThreadClosed(child.tabId, child.id, true)
          return ok({ closed: true })
        }

        case 'diff': {
          const child = findChild(request.sessionId, request.threadId)
          if (!child) return fail('no such delegated thread', 404)
          if (!child.delegatedWorktreePath || !child.delegatedBranch) {
            return fail('that thread shares this worktree, so it has no branch of its own to diff', 409)
          }
          const base = child.delegationBase ?? 'HEAD'
          const gitApi = window.electronAPI
          if (!gitApi) return fail('CrewCode window is not available', 503)
          const result = await gitApi.gitDiffDelegated(
            child.delegatedWorktreePath, base, child.delegatedBranch,
          )
          if (!result?.ok) return fail(result?.error ?? 'could not read the diff', 500)
          return ok({ branch: child.delegatedBranch, base, stat: result.stat, patch: result.patch })
        }

        case 'merge': {
          const child = findChild(request.sessionId, request.threadId)
          if (!child) return fail('no such delegated thread', 404)
          if (!child.delegatedWorktreePath || !child.delegatedBranch) {
            return fail('that thread shares this worktree, so it has nothing to merge', 409)
          }
          if (d.isRunning(child.id)) {
            return fail('that thread is still working; wait for it to finish before merging', 409)
          }
          const repoPath = d.repoPathForSession(child.id)
          if (!repoPath) return fail('could not resolve the repository for that thread', 500)

          const mergeApi = window.electronAPI
          if (!mergeApi) return fail('CrewCode window is not available', 503)
          const outcome = await mergeApi.gitMergeDelegated({
            worktreePath: child.delegatedWorktreePath,
            repoPath,
            branch: child.delegatedBranch,
            base: child.delegationBase ?? 'HEAD',
          })
          // Conflicts and dirty trees are answers, not transport failures — pass
          // the whole outcome through so the agent can act on the paths.
          if (!outcome) return fail('merge produced no result', 500)
          if (outcome.ok) return ok(outcome)
          return { ok: false, error: JSON.stringify(outcome), status: outcome.status === 'error' ? 500 : 409 }
        }

        case 'focus': {
          // Focus is scoped to the caller's own children, like every other route:
          // an agent must not be able to yank the user's view to an arbitrary chat.
          const child = findChild(request.sessionId, request.threadId)
          if (!child) return fail('no such delegated thread', 404)
          // A thread marked done is still open in the UI, so it is still a valid
          // focus target; only a user-archived one is genuinely gone.
          if (child.archived) return fail('that thread was archived by the user', 409)
          d.focusSession(child)
          return ok({ focused: child.id })
        }

        default:
          return fail('unsupported delegation request', 400)
      }
    }

    const unsubscribe = api.onDelegationRequest(request => {
      const { id, ...rest } = request
      void perform(rest as DelegationRendererRequest)
        .then(result => api.delegationRespond(id, result))
        .catch(error => api.delegationRespond(id, fail(
          error instanceof Error ? error.message : 'delegation request failed',
          500,
        )))
    })

    return unsubscribe
  }, [])
}

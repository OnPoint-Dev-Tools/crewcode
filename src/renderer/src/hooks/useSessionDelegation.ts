// Per-chat delegation credentials and the context block built from them.
//
// Owned by the chat pane, not App: App tracks only the *active* session, so an
// App-level effect would silently leave the second pane of a split layout without
// credentials. Each mounted pane manages its own session's registration.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { DelegationProviderInfo } from '../../../shared/delegation-types'
import type { ModeLevel, Session } from '../types'
import { buildDelegationPreamble } from './delegation-preamble'
import { canSessionDelegate } from './delegation-eligibility'

export interface SessionDelegationOptions {
  session: Session | null
  /** Effective mode for the session — children inherit it when a spawn omits one. */
  mode: ModeLevel
  maxConcurrent: number
  allowFullAccess: boolean
  /** ssh:// workspace: the agent's 127.0.0.1 is the remote host, so delegation
   *  can't reach this API. Registered anyway so the refusal is a clear 409. */
  remote: boolean
  providers: () => DelegationProviderInfo[]
  /** Whether `isolation: 'worktree'` can be offered. `build` mode itself is
   *  always available — running a command needs a shell, not a git repo. */
  worktreeIsolationEnabled?: boolean
  /** Settings → "Wake chat on delegated report". The agent must be told whether
   *  a turn can start without the user present. */
  wakeParentOnReport?: boolean
}

export interface SessionDelegation {
  enabled: boolean
  /** Empty until main has minted credentials, so the send path sends nothing
   *  rather than a half-built block. */
  preamble: string
  delivered: (sessionId: string) => boolean
  markDelivered: (sessionId: string) => void
}

/** Delivery is keyed by `<sessionId>::<token>`, not session id alone.
 *
 *  The endpoint AND token change on every app restart (ephemeral port, per-launch
 *  token), so a transcript can end up holding a block whose endpoint now refuses
 *  connections. Keying on the token re-delivers the moment credentials change, and
 *  the new block tells the agent to ignore the older one. */
function deliveryKey(sessionId: string, token: string): string {
  return `${sessionId}::${token}`
}

export function useSessionDelegation(options: SessionDelegationOptions): SessionDelegation {
  const {
    session, mode, maxConcurrent, allowFullAccess, remote, providers,
    worktreeIsolationEnabled = false, wakeParentOnReport = false,
  } = options
  const [preamble, setPreamble] = useState('')
  // Delivered set, keyed by session + token so rotated credentials re-deliver.
  const deliveredRef = useRef<Set<string>>(new Set())
  const tokenRef = useRef('')

  const sessionId = session?.id ?? ''
  // Depth-1 is enforced here as well as in the UI and the API: a delegated
  // thread must never be minted credentials, even if `delegationEnabled` got
  // persisted true (an older build, or a duplicate of an enabled chat).
  const enabled = !!session?.delegationEnabled && canSessionDelegate(session)
  const providersRef = useRef(providers)
  providersRef.current = providers

  useEffect(() => {
    const api = window.electronAPI
    if (!api?.delegationEnable || !sessionId) return

    if (!enabled) {
      void api.delegationDisable?.(sessionId)
      setPreamble('')
      tokenRef.current = ''
      return
    }

    let cancelled = false
    void api.delegationEnable(sessionId, {
      allowFullAccess,
      parentMode: mode,
      maxConcurrent,
      remote,
    }).then(result => {
      if (cancelled) return
      if (!result?.ok || !result.credentials) {
        setPreamble('')
        return
      }
      // A restart rotates the endpoint and token, so an earlier block in this
      // transcript is now dead. Say so explicitly rather than leaving the agent
      // to pick whichever endpoint it happens to remember.
      const supersedes = tokenRef.current !== '' && tokenRef.current !== result.credentials.token
      tokenRef.current = result.credentials.token
      setPreamble(buildDelegationPreamble({
        credentials: result.credentials,
        providers: providersRef.current(),
        maxConcurrent,
        allowFullAccess,
        worktreeIsolationEnabled,
        wakeParentOnReport,
        supersedesEarlierCredentials: supersedes,
      }))
    })
    return () => { cancelled = true }
  }, [sessionId, enabled, mode, maxConcurrent, allowFullAccess, remote, worktreeIsolationEnabled, wakeParentOnReport])

  // Revoke on unmount so a closed pane doesn't leave a live token behind.
  useEffect(() => () => {
    if (sessionId) void window.electronAPI?.delegationDisable?.(sessionId)
  }, [sessionId])

  const delivered = useCallback((id: string) => deliveredRef.current.has(deliveryKey(id, tokenRef.current)), [])
  const markDelivered = useCallback((id: string) => {
    deliveredRef.current.add(deliveryKey(id, tokenRef.current))
  }, [])

  return { enabled, preamble, delivered, markDelivered }
}

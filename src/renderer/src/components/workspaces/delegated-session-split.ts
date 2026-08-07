// Splits a workspace's chat sessions into human-created threads and threads an
// agent spawned through the delegation API, so the drawer can show delegated
// work as its own section instead of one flat pile.
//
// Pure and separate from WorkspacesDrawer.tsx so the grouping rules are testable
// without mounting the drawer.

import type { Session } from '../../types'

export interface DelegatedSessionSplit {
  /** Threads the user created. Rendered in the workspace's normal list. */
  own: Session[]
  /** Threads spawned by an agent, newest first — a delegating turn can create
   *  several at once, and the most recent is the one you're waiting on. */
  delegated: Session[]
}

/** True only for threads created through the delegation API. */
export function isDelegated(session: Session): boolean {
  return session.origin === 'delegated'
}

/**
 * Partition one workspace's sessions. Order within `own` is preserved (the
 * drawer's existing ordering is meaningful); `delegated` is sorted newest-first
 * by `delegatedAt`, with entries missing that field kept last in stable order so
 * a legacy or malformed row can't jump to the top.
 */
export function splitDelegatedSessions(sessions: Session[]): DelegatedSessionSplit {
  const own: Session[] = []
  const delegated: Session[] = []
  for (const session of sessions) {
    (isDelegated(session) ? delegated : own).push(session)
  }

  const orderOf = new Map(delegated.map((s, i) => [s.id, i]))
  delegated.sort((a, b) => {
    const at = a.delegatedAt
    const bt = b.delegatedAt
    if (at == null && bt == null) return (orderOf.get(a.id) ?? 0) - (orderOf.get(b.id) ?? 0)
    if (at == null) return 1
    if (bt == null) return -1
    return bt - at
  })

  return { own, delegated }
}

/**
 * Label for the delegated section header. Names the parent when every thread in
 * the group came from the same one, which is the common case — a single turn
 * fanning out — and stays generic for a mixed group.
 */
export function delegatedSectionLabel(delegated: Session[], labelForSession: (id: string) => string | undefined): string {
  const parents = new Set(delegated.map(s => s.delegatedBy).filter((id): id is string => !!id))
  if (parents.size !== 1) return 'delegated'
  const parentLabel = labelForSession([...parents][0])
  return parentLabel ? `delegated · ${parentLabel}` : 'delegated'
}

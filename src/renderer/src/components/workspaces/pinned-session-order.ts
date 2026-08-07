import type { Session } from '../../types'

/** Move pinned sessions first while preserving each group's existing order. */
export function pinnedSessionsFirst(sessions: Session[]): Session[] {
  const pinned: Session[] = []
  const unpinned: Session[] = []
  for (const session of sessions) {
    if (session.pinned) pinned.push(session)
    else unpinned.push(session)
  }
  return [...pinned, ...unpinned]
}

/**
 * archive-retention — pure helpers for the Archive page's retention policy.
 *
 * Retention in CrewCode NEVER deletes anything on its own. It classifies
 * archived sessions as "expired" so the Archive page can offer a reviewed,
 * explicit bulk delete. Keeping the rule in a pure module means the "what is
 * expired" question is testable without mounting the page.
 */

import type { Session } from '../types'

export const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Wall-clock ms an archived session started its retention clock. */
export function archivedAtOf(session: Session): number | null {
  return typeof session.archivedAt === 'number' && Number.isFinite(session.archivedAt)
    ? session.archivedAt
    : null
}

/** Whole days a session has been sitting in the archive. */
export function daysArchived(session: Session, now: number): number | null {
  const at = archivedAtOf(session)
  if (at == null) return null
  return Math.max(0, Math.floor((now - at) / MS_PER_DAY))
}

/**
 * True when a session is past the retention window.
 *
 * `retentionDays === 0` means "never expire". A session with no `archivedAt`
 * is NEVER expired: we cannot prove how long it has been there, and guessing
 * would put unrecoverable transcripts behind a "Delete all" button.
 */
export function isExpired(session: Session, retentionDays: number, now: number): boolean {
  if (!session.archived) return false
  if (retentionDays <= 0) return false
  const at = archivedAtOf(session)
  if (at == null) return false
  return now - at >= retentionDays * MS_PER_DAY
}

export function expiredSessions(sessions: Session[], retentionDays: number, now: number): Session[] {
  return sessions.filter(s => isExpired(s, retentionDays, now))
}

/** "3d ago" / "just now" — compact enough for a dense archive row. */
export function formatArchivedAgo(session: Session, now: number): string {
  const days = daysArchived(session, now)
  if (days == null) return 'unknown'
  if (days === 0) return 'today'
  if (days === 1) return '1d ago'
  return `${days}d ago`
}

export function retentionLabel(days: number): string {
  return days <= 0 ? 'Never' : `${days} days`
}

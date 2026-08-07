import { describe, expect, it } from 'vitest'

import type { Session } from '../types'
import { MS_PER_DAY, daysArchived, expiredSessions, formatArchivedAgo, isExpired, retentionLabel } from './archive-retention'

const NOW = 1_800_000_000_000

function session(patch: Partial<Session> = {}): Session {
  return {
    id: 'tab', tabId: 'tab', label: 'Session', agentId: 'claude', model: '',
    mode: 'build', effort: 'medium', mcpServerIds: [], enabledSkillIds: [],
    ...patch,
  }
}

function archivedDaysAgo(days: number): Session {
  return session({ archived: true, archivedAt: NOW - days * MS_PER_DAY })
}

describe('archive retention', () => {
  it('never expires anything when retention is off', () => {
    expect(isExpired(archivedDaysAgo(9999), 0, NOW)).toBe(false)
  })

  it('expires only past the window', () => {
    expect(isExpired(archivedDaysAgo(29), 30, NOW)).toBe(false)
    expect(isExpired(archivedDaysAgo(30), 30, NOW)).toBe(true)
    expect(isExpired(archivedDaysAgo(31), 30, NOW)).toBe(true)
    expect(isExpired(archivedDaysAgo(31), 60, NOW)).toBe(false)
  })

  it('never expires a session with no archivedAt', () => {
    // We cannot prove how long it has been archived, so it must not land
    // behind a "Delete all expired" button.
    expect(isExpired(session({ archived: true }), 30, NOW)).toBe(false)
    expect(isExpired(session({ archived: true, archivedAt: Number.NaN }), 30, NOW)).toBe(false)
  })

  it('never expires a live session', () => {
    expect(isExpired(session({ archivedAt: NOW - 999 * MS_PER_DAY }), 30, NOW)).toBe(false)
  })

  it('selects only the expired subset', () => {
    const list = [archivedDaysAgo(5), archivedDaysAgo(45), archivedDaysAgo(90), session()]
    expect(expiredSessions(list, 30, NOW)).toHaveLength(2)
    expect(expiredSessions(list, 0, NOW)).toHaveLength(0)
  })

  it('reports whole days archived and never goes negative', () => {
    expect(daysArchived(archivedDaysAgo(3), NOW)).toBe(3)
    // Clock skew (archivedAt in the future) must not produce a negative age.
    expect(daysArchived(session({ archived: true, archivedAt: NOW + MS_PER_DAY }), NOW)).toBe(0)
    expect(daysArchived(session({ archived: true }), NOW)).toBeNull()
  })

  it('formats ages and labels for the archive rows', () => {
    expect(formatArchivedAgo(archivedDaysAgo(0), NOW)).toBe('today')
    expect(formatArchivedAgo(archivedDaysAgo(1), NOW)).toBe('1d ago')
    expect(formatArchivedAgo(archivedDaysAgo(12), NOW)).toBe('12d ago')
    expect(formatArchivedAgo(session({ archived: true }), NOW)).toBe('unknown')
    expect(retentionLabel(0)).toBe('Never')
    expect(retentionLabel(90)).toBe('90 days')
  })
})

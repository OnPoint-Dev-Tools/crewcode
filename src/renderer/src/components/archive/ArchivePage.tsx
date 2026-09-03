/**
 * ArchivePage — one place to review every archived chat across all workspaces.
 *
 * Retention here is a REVIEW prompt, never a scheduler: expired chats are
 * flagged and offered for bulk delete, but nothing is destroyed without an
 * explicit click. See docs/chat-archiving.md.
 */

import React, { useMemo, useState } from 'react'

import type { Session, Workspace } from '../../types'
import { ARCHIVE_RETENTION_CHOICES, type ArchiveRetentionDays } from '../../hooks/useSettings'
import { formatLastUsedDate, isExpired, retentionLabel } from '../../hooks/archive-retention'
import { PROVIDER_IMAGES, providerImageClass } from '../composer/provider-meta'
import { ConfirmModal, type ConfirmModalRequest } from '../ui/ConfirmModal'
import { Icon } from '../ui/Icon'

export interface ArchivedEntry {
  session: Session
  wsId:    string
  wsName:  string
}

interface ArchivePageProps {
  entries:        ArchivedEntry[]
  workspaces:     Workspace[]
  retentionDays:  ArchiveRetentionDays
  onSetRetention: (days: ArchiveRetentionDays) => void
  onRestore:      (session: Session) => void
  onDelete:       (session: Session) => void
}

export function ArchivePage({
  entries, workspaces, retentionDays, onSetRetention, onRestore, onDelete,
}: ArchivePageProps) {
  const [query,   setQuery]   = useState('')
  const [wsFilter, setWsFilter] = useState('')
  const [confirm, setConfirm] = useState<ConfirmModalRequest | null>(null)
  // One clock for the whole page — archived ages are day-grained, so a value
  // captured at mount is accurate for the life of the view.
  const now = useMemo(() => Date.now(), [entries.length, retentionDays])

  const expired = useMemo(
    () => entries.filter(e => isExpired(e.session, retentionDays, now)),
    [entries, retentionDays, now],
  )

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries
      .filter(e => !wsFilter || e.wsId === wsFilter)
      .filter(e => !q || e.session.label.toLowerCase().includes(q) || e.wsName.toLowerCase().includes(q))
      // Most recently used first; filing a chat away must not affect its order.
      .sort((a, b) => (b.session.lastUsedAt ?? b.session.createdAt ?? 0) - (a.session.lastUsedAt ?? a.session.createdAt ?? 0))
  }, [entries, query, wsFilter])

  const confirmDeleteOne = (entry: ArchivedEntry) => {
    setConfirm({
      title:       `Delete "${entry.session.label}"?`,
      body:        'This permanently removes the chat and its transcript from disk.',
      confirmText: 'Delete',
      danger:      true,
      onConfirm:   () => onDelete(entry.session),
    })
  }

  const confirmDeleteExpired = () => {
    setConfirm({
      title:       `Delete ${expired.length} expired chat${expired.length === 1 ? '' : 's'}?`,
      body:        `These have been archived longer than ${retentionLabel(retentionDays)}. This permanently removes their transcripts from disk and cannot be undone.`,
      confirmText: `Delete ${expired.length}`,
      danger:      true,
      onConfirm:   () => { for (const e of expired) onDelete(e.session) },
    })
  }

  return (
    <div className="archive-page">
      <div className="archive-head">
        <div className="archive-title">
          <Icon name="archive" size={16} />
          <span>Archive</span>
          <span className="archive-total">{entries.length}</span>
        </div>

        <div className="archive-controls">
          <input
            className="archive-search"
            placeholder="search archived chats"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <select
            className="archive-select"
            value={wsFilter}
            onChange={e => setWsFilter(e.target.value)}
            aria-label="Filter by workspace"
          >
            <option value="">All workspaces</option>
            {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <label className="archive-retention">
            <span>Retention</span>
            <select
              className="archive-select"
              value={retentionDays}
              onChange={e => onSetRetention(Number(e.target.value) as ArchiveRetentionDays)}
            >
              {ARCHIVE_RETENTION_CHOICES.map(d => (
                <option key={d} value={d}>{retentionLabel(d)}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="archive-retention-note">
        {retentionDays > 0
          ? `Chats archived longer than ${retentionLabel(retentionDays)} are flagged below. CrewCode never deletes them for you.`
          : 'Archived chats are kept indefinitely. Set a retention window to have old ones flagged for review.'}
      </div>

      {expired.length > 0 && (
        <div className="archive-expired-banner">
          <Icon name="alert" size={13} />
          <span className="archive-expired-text">
            {expired.length} chat{expired.length === 1 ? ' is' : 's are'} past retention
          </span>
          <button className="archive-danger-btn" onClick={confirmDeleteExpired}>
            <Icon name="trash" size={11} /> Delete {expired.length}
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="archive-empty">
          <div className="archive-empty-title">
            {entries.length === 0 ? 'Nothing archived' : 'No matches'}
          </div>
          <div className="archive-empty-sub">
            {entries.length === 0
              ? 'Right-click a chat in the workspaces sidebar to archive it.'
              : 'Try a different search or workspace filter.'}
          </div>
        </div>
      ) : (
        <div className="archive-list">
          {visible.map(entry => {
            const gone = isExpired(entry.session, retentionDays, now)
            return (
              <div key={entry.session.id} className={`archive-row ${gone ? 'expired' : ''}`}>
                {PROVIDER_IMAGES[entry.session.agentId] ? (
                  <img
                    src={PROVIDER_IMAGES[entry.session.agentId]}
                    alt={entry.session.agentId}
                    className={`archive-provider-img ${providerImageClass(entry.session.agentId)}`}
                    width={15}
                    height={15}
                  />
                ) : <span className="archive-dot" />}

                <span className="archive-label">{entry.session.label}</span>
                <span className="archive-ws">{entry.wsName}</span>
                <span className="archive-age">{formatLastUsedDate(entry.session)}</span>
                {gone && <span className="archive-expired-pill">expired</span>}

                <div className="archive-row-actions">
                  <button
                    className="archive-row-btn"
                    title="restore chat"
                    onClick={() => onRestore(entry.session)}
                  >
                    <Icon name="unarchive" size={12} /> Restore
                  </button>
                  <button
                    className="archive-row-btn danger"
                    title="delete chat permanently"
                    onClick={() => confirmDeleteOne(entry)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ConfirmModal request={confirm} onClose={() => setConfirm(null)} />
    </div>
  )
}

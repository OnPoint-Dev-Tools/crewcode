import React, { useEffect, useState } from 'react'

import { Icon } from '../ui/Icon'
import type { CrewRole, CrewRoleInput } from '../../orchestrator/crew-roles'

interface CrewRoleModalProps {
  open:     boolean
  roles:    CrewRole[]
  /** Pre-select a role to edit when opened; null opens straight into the new-role form. */
  editingId?: string | null
  onClose:  () => void
  onSave:   (input: CrewRoleInput) => CrewRole
  onUpdate: (id: string, input: CrewRoleInput) => void
  onDelete: (id: string) => void
  /** When set, saving a *new* role hands it back so the triggering lane can adopt it. */
  onAdopt?: (role: CrewRole) => void
}

const EMPTY: CrewRoleInput = { name: '', role: '', instructions: '' }

/**
 * Author and manage reusable agent roles. A role bundles a name, a role
 * descriptor, and standing instructions — all injected verbatim into a worker
 * on spawn. The left rail lists saved roles (edit / delete); the right pane is
 * the create / edit form. Esc or backdrop click closes.
 */
export function CrewRoleModal({
  open, roles, editingId, onClose, onSave, onUpdate, onDelete, onAdopt,
}: CrewRoleModalProps) {
  const [selId, setSelId]   = useState<string | null>(editingId ?? null)
  const [draft, setDraft]   = useState<CrewRoleInput>(EMPTY)

  // Sync the form to the externally-requested role each time the modal opens.
  useEffect(() => {
    if (!open) return
    setSelId(editingId ?? null)
    const seed = editingId ? roles.find(r => r.id === editingId) : null
    setDraft(seed ? { name: seed.name, role: seed.role, instructions: seed.instructions } : EMPTY)
  }, [open, editingId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const editing = selId !== null
  const canSave = draft.name.trim().length > 0

  const selectForEdit = (role: CrewRole): void => {
    setSelId(role.id)
    setDraft({ name: role.name, role: role.role, instructions: role.instructions })
  }

  const startNew = (): void => {
    setSelId(null)
    setDraft(EMPTY)
  }

  const handleSave = (): void => {
    if (!canSave) return
    if (editing && selId) {
      onUpdate(selId, draft)
      onClose()
    } else {
      const created = onSave(draft)
      onAdopt?.(created)
      onClose()
    }
  }

  const handleDelete = (id: string): void => {
    onDelete(id)
    if (selId === id) startNew()
  }

  return (
    <div className="crew-modal-backdrop" onClick={onClose}>
      <div
        className="crew-modal crew-role-modal"
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="agent roles"
      >
        <header className="crew-modal-head">
          <span className="crew-modal-icon"><Icon name="cpu" size={14} /></span>
          <h2 className="crew-modal-title">agent roles</h2>
        </header>

        <div className="crew-role-modal-body">
          <aside className="crew-role-list" aria-label="saved roles">
            <button type="button" className="crew-role-new" onClick={startNew}>
              <Icon name="plus" size={11} /> new role
            </button>
            {roles.length === 0 ? (
              <p className="crew-role-empty">no roles yet</p>
            ) : roles.map(r => (
              <div key={r.id} className={`crew-role-row ${selId === r.id ? 'on' : ''}`}>
                <button
                  type="button"
                  className="crew-role-pick"
                  onClick={() => selectForEdit(r)}
                  title={r.role || undefined}
                >
                  <span className="crew-role-name">{r.name}</span>
                  {r.role && <small className="crew-role-desc">{r.role}</small>}
                </button>
                <button
                  type="button"
                  className="crew-role-del"
                  title="delete role"
                  aria-label={`delete ${r.name}`}
                  onClick={() => handleDelete(r.id)}
                >
                  <Icon name="trash" size={11} />
                </button>
              </div>
            ))}
          </aside>

          <div className="crew-role-form">
            <label className="crew-role-field">
              <span>name</span>
              <input
                type="text"
                value={draft.name}
                placeholder="e.g. Security Auditor"
                onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                autoFocus
              />
            </label>
            <label className="crew-role-field">
              <span>role</span>
              <input
                type="text"
                value={draft.role}
                placeholder="what this agent does — e.g. reviews code for vulnerabilities"
                onChange={e => setDraft(d => ({ ...d, role: e.target.value }))}
              />
            </label>
            <label className="crew-role-field">
              <span>instructions</span>
              <textarea
                value={draft.instructions}
                placeholder="specific standing instructions, sent to the agent on spawn"
                rows={6}
                onChange={e => setDraft(d => ({ ...d, instructions: e.target.value }))}
              />
            </label>
          </div>
        </div>

        <footer className="crew-modal-foot">
          <button type="button" className="crew-btn-ghost" onClick={onClose}>cancel</button>
          <button type="button" className="crew-btn-go" onClick={handleSave} disabled={!canSave}>
            {editing ? 'save changes' : 'create role'}
          </button>
        </footer>
      </div>
    </div>
  )
}

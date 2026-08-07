import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui/Icon'
import type { GitBranchRef } from './git-state'

const BRANCH_PREFIXES = ['feature/', 'fix/', 'chore/', 'docs/']

export function slugBranchName(value: string): string {
  return value
    .trim()
    .replace(/^origin\//, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-/.]+|[-/.]+$/g, '')
}

export function branchNameIssue(name: string): string | null {
  if (!name) return 'branch name required'
  // Keep the modal aligned with git check-ref-format's common footguns before IPC.
  if (/\s/.test(name)) return 'use dashes instead of spaces'
  if (name.startsWith('/') || name.endsWith('/')) return 'cannot start or end with /'
  if (name.includes('..') || name.includes('//')) return 'cannot contain .. or //'
  if (/[~^:?*[\\]/.test(name)) return 'contains a git-reserved character'
  if (name.endsWith('.') || name.endsWith('.lock')) return 'invalid git branch ending'
  if (name.includes('@{')) return 'cannot contain @{'
  return null
}

interface CreateBranchModalProps {
  open: boolean
  seed: string
  sourceBranch: string
  onCreate?: (name: string) => void
  onClose: () => void
}

export function CreateBranchModal({ open, seed, sourceBranch, onCreate, onClose }: CreateBranchModalProps) {
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setName(slugBranchName(seed))
    const t = setTimeout(() => inputRef.current?.select(), 30)
    return () => clearTimeout(t)
  }, [open, seed])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const cleanName = slugBranchName(name)
  const issue = branchNameIssue(cleanName)
  const examples = ['feature/git-sidebar-polish', 'fix/branch-picker', 'chore/refactor-git-actions']
  const applyPrefix = (prefix: string) => {
    const rest = slugBranchName(name.replace(/^[^/]+\//, ''))
    setName(`${prefix}${rest}`)
    setTimeout(() => inputRef.current?.focus(), 0)
  }
  const commit = () => {
    if (issue) return
    onCreate?.(cleanName)
    onClose()
  }

  return createPortal(
    <div className="im-backdrop" onClick={onClose}>
      <div className="im-modal gb-modal" role="dialog" aria-modal="true" aria-label="create branch" onClick={e => e.stopPropagation()}>
        <div className="im-head gb-head">
          <span className="im-title"><Icon name="gitBranch" size={13} /> create branch</span>
          <button className="im-close" onClick={onClose}><Icon name="close" size={12} /></button>
        </div>

        <div className="gb-source">
          <span className="gb-source-label">from</span>
          <span className="gb-source-branch"><Icon name="gitBranch" size={10} />{sourceBranch}</span>
        </div>

        <label className="im-label" htmlFor="git-branch-name">branch name</label>
        <div className={`gb-input-wrap ${issue ? 'invalid' : ''}`}>
          <Icon name="gitBranch" size={12} />
          <input
            id="git-branch-name"
            ref={inputRef}
            autoFocus
            value={name}
            placeholder="feature/short-readable-name"
            onChange={e => setName(e.target.value)}
            onBlur={() => setName(cleanName)}
            onKeyDown={e => {
              if (e.key === 'Enter')  { e.preventDefault(); commit() }
              if (e.key === 'Escape') { e.preventDefault(); onClose() }
            }}
          />
        </div>
        <div className={`gb-hint ${issue ? 'warn' : ''}`}>
          {issue || <>will create <code>{cleanName}</code></>}
        </div>

        <div className="gb-prefixes" aria-label="branch prefixes">
          {BRANCH_PREFIXES.map(prefix => (
            <button key={prefix} type="button" onClick={() => applyPrefix(prefix)}>{prefix}</button>
          ))}
        </div>

        <div className="gb-examples">
          <span>examples</span>
          {examples.map(example => (
            <button key={example} type="button" onClick={() => setName(example)}>{example}</button>
          ))}
        </div>

        <div className="im-actions">
          <button className="im-btn" onClick={onClose}>cancel</button>
          <button className="im-btn primary" onClick={commit} disabled={!!issue}>
            <Icon name="plus" size={11} /> create
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

interface BranchPickerPanelProps {
  branches: GitBranchRef[]
  currentBranch: string
  query: string
  onQueryChange: (query: string) => void
  onCheckoutBranch?: (ref: string) => void
  onCreateRequest: () => void
  onClose?: () => void
}

export function BranchPickerPanel({
  branches,
  currentBranch,
  query,
  onQueryChange,
  onCheckoutBranch,
  onCreateRequest,
  onClose,
}: BranchPickerPanelProps) {
  const filtered = useMemo(
    () => branches.filter(b => !query || b.name.toLowerCase().includes(query.toLowerCase())),
    [branches, query],
  )
  const locals = filtered.filter(b => b.kind === 'local')
  const remotes = filtered.filter(b => b.kind === 'remote')

  const checkout = (ref: string) => {
    onCheckoutBranch?.(ref)
    onClose?.()
  }

  return (
    <>
      <div className="gs-pop-search">
        <Icon name="search" size={12} />
        <input autoFocus value={query} onChange={e => onQueryChange(e.target.value)} placeholder="filter branches or paste ref…" />
      </div>
      <div className="gs-pop-section">Local · this worktree</div>
      <div className="gs-pop-list">
        {locals.map(b => (
          <div key={b.name} className={`gs-pop-item ${b.name === currentBranch ? 'on' : ''}`}
               onClick={() => checkout(b.name)}>
            <Icon name="gitBranch" size={11} />
            <span className="name">{b.name}</span>
            <span className="meta">{b.updated}</span>
          </div>
        ))}
        {locals.length === 0 && (
          <div className="gs-pop-item muted">
            <span className="name">no local branches found</span>
          </div>
        )}
        <div className="gs-pop-section">Remote</div>
        {remotes.map(b => (
          <div key={b.name} className="gs-pop-item"
               onClick={() => checkout(b.name.startsWith('origin/') ? b.name : `origin/${b.name}`)}>
            <Icon name="gitBranch" size={11} />
            <span className="name">{b.name.startsWith('origin/') ? b.name : `origin/${b.name}`}</span>
            <span className="meta">{b.updated}</span>
          </div>
        ))}
        <div className="gs-pop-item create" onClick={onCreateRequest}>
          <Icon name="plus" size={11} />
          <span className="name">create branch…</span>
          {query.trim() && <span className="meta">from “{slugBranchName(query)}”</span>}
        </div>
      </div>
    </>
  )
}

interface ComposerBranchPickerProps {
  currentBranch: string
  branches: GitBranchRef[]
  onCheckoutBranch?: (ref: string) => void
  onCreateBranch?: (name: string) => void
  onRefresh?: () => void
}

export function ComposerBranchPicker({
  currentBranch,
  branches,
  onCheckoutBranch,
  onCreateBranch,
  onRefresh,
}: ComposerBranchPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [menu, setMenu] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const placeMenu = () => {
    const buttonRect = buttonRef.current?.getBoundingClientRect()
    if (!buttonRect) return
    const composerRect = buttonRef.current?.closest('.composer')?.getBoundingClientRect()
    const desiredWidth = Math.max(340, composerRect?.width ?? 360)
    const width = Math.min(desiredWidth, window.innerWidth - 16)
    const leftBase = composerRect?.left ?? buttonRect.left
    const left = Math.max(8, Math.min(leftBase, window.innerWidth - width - 8))
    const spaceAbove = Math.max(0, buttonRect.top - 8)
    const spaceBelow = Math.max(0, window.innerHeight - buttonRect.bottom - 8)
    const openUp = spaceAbove >= 220 || spaceAbove >= spaceBelow
    const maxHeight = Math.max(180, Math.min(320, openUp ? spaceAbove - 8 : spaceBelow - 8))
    const top = openUp ? Math.max(8, buttonRect.top - maxHeight - 8) : buttonRect.bottom + 8
    setMenu({ top, left, width, maxHeight })
  }

  const openPicker = () => {
    placeMenu()
    setOpen(true)
    onRefresh?.()
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onResize = () => placeMenu()
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        className={`ibtn composer-branch-btn ${open ? 'active' : ''}`}
        title={`branches · ${currentBranch}`}
        type="button"
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        <Icon name="gitBranch" />
      </button>

      {open && menu && createPortal(
        <>
          <div className="composer-branch-backdrop" onClick={() => setOpen(false)} />
          <div
            className="gs-pop composer-branch-pop"
            style={{
              top: menu.top,
              left: menu.left,
              right: 'auto',
              width: menu.width,
              maxHeight: menu.maxHeight,
              ['--branch-pop-max' as string]: `${menu.maxHeight}px`,
            } as React.CSSProperties}
            onClick={e => e.stopPropagation()}
          >
            <BranchPickerPanel
              branches={branches}
              currentBranch={currentBranch}
              query={query}
              onQueryChange={setQuery}
              onCheckoutBranch={onCheckoutBranch}
              onCreateRequest={() => { setOpen(false); setCreateOpen(true) }}
              onClose={() => setOpen(false)}
            />
          </div>
        </>,
        document.body,
      )}

      <CreateBranchModal
        open={createOpen}
        seed={query}
        sourceBranch={currentBranch}
        onCreate={onCreateBranch}
        onClose={() => setCreateOpen(false)}
      />
    </>
  )
}

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import {
  getAllCategories, getCategoryColor, getCategoryLabel, extractVars,
  type Prompt, type PromptCategory, type Skill, type CustomCategoryDef,
} from '../../types/prompts'
import { renderMarkdownNodes } from './renderMarkdown'

export type MdMode = 'source' | 'split' | 'preview'

interface PromptDetailProps {
  p:            Prompt | Skill
  kind:         'prompts' | 'skills'
  isMobile:     boolean
  mdMode:       MdMode
  setMdMode:    (m: MdMode) => void
  customCategories?: CustomCategoryDef[]
  onCommit:     (draft: Prompt | Skill) => void
  onUseInChat:  () => void
  onApplySkill: () => void
  onDuplicate:  () => void
  onDelete:     () => void
  /**
   * Skill-only — flip the `enabled` flag and commit to the library
   * immediately. Bypasses the editor's draft state because `enabled` is a
   * live session binding, not editor content.
   */
  onToggleEnabled?: () => void
  /**
   * Phone-only — return to the prompt library. When set, a `[< Back]`
   * button is rendered at the front of the detail header. The button is
   * hidden on desktop via CSS (`.pd-back-btn { display: none }` by default
   * and `inline-flex` only inside `@media (max-width: 768px)`).
   */
  onBack?:       () => void
}

export function PromptDetail({
  p, kind, isMobile, mdMode, setMdMode, customCategories = [], onCommit, onUseInChat, onApplySkill, onDuplicate, onDelete,
  onToggleEnabled, onBack,
}: PromptDetailProps) {
  const [draft, setDraft] = useState<Prompt | Skill>(p)
  const [savedAt, setSavedAt] = useState<string>('saved')
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setDraft(p); setSavedAt('saved') }, [p])

  useEffect(() => {
    if (!moreOpen) return
    const fn = (e: MouseEvent): void => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', fn)
    return () => document.removeEventListener('mousedown', fn)
  }, [moreOpen])

  const dirty  = JSON.stringify(draft) !== JSON.stringify(p)
  const preview = useMemo(() => renderMarkdownNodes(draft.body), [draft.body])
  const vars   = extractVars(draft.body)
  const accent = getCategoryColor(draft.category)
  const isSkill = kind === 'skills'
  const skillEnabled = isSkill && (draft as Skill).enabled
  // Split remains the desktop default, but a phone treats it as source mode
  // so opening a detail never spends editor height on an implicit preview.
  const visibleMdMode: MdMode = isMobile && mdMode === 'split' ? 'source' : mdMode

  const patch = (k: string, v: unknown): void => {
    setDraft(d => ({ ...d, [k]: v }) as Prompt | Skill)
  }

  const handleSave = (): void => {
    onCommit(draft)
    setSavedAt('saved · just now')
  }

  useEffect(() => {
    const fn = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        const inSelf = (document.activeElement as HTMLElement | null)?.closest?.('.pd')
        if (inSelf) { e.preventDefault(); if (dirty) handleSave() }
      }
    }
    window.addEventListener('keydown', fn)
    return () => window.removeEventListener('keydown', fn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, draft])

  const primaryLabel = isSkill ? (skillEnabled ? 'Applied' : 'Apply skill') : 'Use in chat'
  const onPrimary    = isSkill ? onApplySkill : onUseInChat

  return (
    <div className="pd" ref={rootRef}>
      <div className="pd-h">
        {onBack && (
          <button type="button" className="pd-back-btn" onClick={onBack} title="back to library">
            <Icon name="chevLeft" size={12} /> Back
          </button>
        )}
        <div className="pd-h-meta">
          <span className="pd-cat-pill" style={{ ['--cat' as string]: accent } as React.CSSProperties}>
            <span className="pd-cat-dot" />
            {getCategoryLabel(draft.category, customCategories)}
          </span>
          <span className="pd-sep" />
          <span className="pd-id">{(isSkill ? 'skill:' : 'prompt:') + draft.id}</span>
          <span className="pd-sep" />
          <span className="pd-when">used {draft.used}× · {draft.lastUsed}</span>
        </div>
        <div className="pd-h-actions">
          {skillEnabled && (
            <span className="pd-on-pill"><span className="dot" />active</span>
          )}
          <span className={`pd-save-status ${dirty ? 'dirty' : 'clean'}`}
            title={dirty ? 'unsaved changes' : savedAt}>
            {dirty
              ? (<><span className="pd-save-dot" />unsaved</>)
              : (
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                  strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )
            }
          </span>
          <button className={`pd-save ${dirty ? 'dirty' : ''}`}
            onClick={handleSave} disabled={!dirty}>
            Save
            <span className="pd-save-kbd">⌘S</span>
          </button>
          <span className="pd-h-divider" />
          <button className="pd-icobtn" title="favorite"
            onClick={() => patch('favorite', !draft.favorite)}>
            <svg viewBox="0 0 24 24" width="13" height="13"
              fill={draft.favorite ? 'currentColor' : 'none'}
              stroke="currentColor" strokeWidth={1.75}
              strokeLinecap="round" strokeLinejoin="round"
              style={{ color: draft.favorite ? 'var(--warning)' : 'inherit' }}>
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </button>
          <button className="pd-icobtn" title="duplicate" onClick={onDuplicate}>
            <Icon name="copy" size={13} />
          </button>
          <div className="pd-more-wrap" ref={moreRef}>
            <button className="pd-icobtn" title="more" onClick={() => setMoreOpen(o => !o)}>
              <Icon name="more" size={13} />
            </button>
            {moreOpen && (
              <div className="pd-menu">
                <button className="pd-menu-item" onClick={() => {
                  setMoreOpen(false)
                  navigator.clipboard?.writeText(draft.body).catch(() => {})
                }}>
                  <Icon name="copy" size={12} />Copy {isSkill ? 'skill' : 'prompt'} to clipboard
                </button>
                <button className="pd-menu-item" onClick={() => {
                  setMoreOpen(false)
                  const blob = new Blob([draft.body], { type: 'text/markdown' })
                  const url  = URL.createObjectURL(blob)
                  const a    = document.createElement('a')
                  a.href = url
                  a.download = `${draft.title.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}.md`
                  a.click()
                  URL.revokeObjectURL(url)
                }}>
                  <Icon name="code" size={12} />Export as .md
                </button>
                <div className="pd-menu-sep" />
                <button className="pd-menu-item danger" onClick={() => {
                  setMoreOpen(false)
                  if (confirm(`Delete ${isSkill ? 'skill' : 'prompt'} "${draft.title}"?`)) onDelete()
                }}>
                  <Icon name="x" size={12} />Delete {isSkill ? 'skill' : 'prompt'}
                </button>
              </div>
            )}
          </div>
          <button className={`pd-use ${skillEnabled ? 'on' : ''}`} onClick={onPrimary}>
            <Icon name={isSkill ? 'sparkle' : 'send'} size={11} /> {primaryLabel}
            {!isSkill && <span className="pd-use-kbd">⏎</span>}
          </button>
        </div>
      </div>

      <div className="pd-title-row">
        <input className="pd-title"
          value={draft.title} onChange={e => patch('title', e.target.value)}
          placeholder={isSkill ? 'untitled skill' : 'untitled prompt'} />
      </div>
      <input className="pd-desc"
        value={draft.description} onChange={e => patch('description', e.target.value)}
        placeholder={isSkill
          ? 'one-line description — what behaviour does this enforce?'
          : 'one-line description — what does this prompt do?'} />

      <div className="pd-chips">
        <label className="pd-chip">
          <span className="pd-chip-k">category</span>
          <select value={draft.category}
            onChange={e => patch('category', e.target.value)}>
            {getAllCategories(customCategories).filter(c => c.id !== 'all').map(c => (
              <option key={c.id} value={c.id}>{getCategoryLabel(c.id, customCategories)}</option>
            ))}
          </select>
        </label>
        {!isSkill && (
          <span className="pd-chip readonly">
            <span className="pd-chip-k">vars</span>
            <span className="pd-chip-v">{vars.length}</span>
          </span>
        )}
        {isSkill && (
          <label className="pd-chip pd-chip-toggle">
            <span className="pd-chip-k">enabled</span>
            <button type="button"
              className={`pd-toggle ${(p as Skill).enabled ? 'on' : ''}`}
              onClick={() => onToggleEnabled?.()}
              title="apply this skill to the active session immediately (no save needed)">
              <span className="pd-toggle-knob" />
            </button>
          </label>
        )}
      </div>

      <div className="pd-mdt">
        <button className="pd-mdt-btn" title="H1"
          onClick={() => patch('body', `# ${draft.body}`)}>H₁</button>
        <button className="pd-mdt-btn" title="H2"
          onClick={() => patch('body', `## ${draft.body}`)}>H₂</button>
        <span className="pd-mdt-sep" />
        <button className="pd-mdt-btn" title="bold"><strong>B</strong></button>
        <button className="pd-mdt-btn" title="italic"><em>I</em></button>
        {!isSkill && (<>
          <span className="pd-mdt-sep" />
          <button className="pd-mdt-btn" title="insert variable"
            onClick={() => patch('body', draft.body + '\n\n{{new_variable}}')}>{'{}'}</button>
        </>)}
        <span className="pd-mdt-spacer" />
        <div className="pd-view-seg">
          <button className={visibleMdMode === 'source' ? 'on' : ''} onClick={() => setMdMode('source')}>source</button>
          {!isMobile && (
            <button className={visibleMdMode === 'split' ? 'on' : ''} onClick={() => setMdMode('split')}>split</button>
          )}
          <button className={visibleMdMode === 'preview' ? 'on' : ''} onClick={() => setMdMode('preview')}>preview</button>
        </div>
      </div>

      <div className={`pd-body md-mode-${visibleMdMode}`}>
        {visibleMdMode !== 'preview' && (
          <textarea className="pd-source" spellCheck={false}
            value={draft.body}
            onChange={e => patch('body', e.target.value)} />
        )}
        {visibleMdMode !== 'source' && (
          <div className="pd-preview">{preview}</div>
        )}
      </div>

      {!isSkill && (
        <div className="pd-vars">
          <span className="pd-vars-h">VARIABLES</span>
          {vars.length === 0 && (
            <span className="pd-vars-empty">
              none — add <code>{'{{var}}'}</code> to the body to define one.
            </span>
          )}
          {vars.map(v => (
            <span key={v} className="pd-var-chip">
              <span className="pd-var-chip-k">{'{{}}'}</span>
              {v}
            </span>
          ))}
        </div>
      )}
            {isSkill && (
        <div className="pd-vars">
          <span className="pd-vars-h">BINDING</span>
          <span className="pd-var-chip">MODE · {getCategoryLabel(draft.category, customCategories)}</span>
          <span className="pd-var-chip">SCOPE · session</span>
        </div>
      )}
    </div>
  )
}

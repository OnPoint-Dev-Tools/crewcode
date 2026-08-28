import { useMemo, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { useMobileLayout } from '../../hooks/useMobileLayout'
import { PromptCard } from './PromptCard'
import { PromptDetail, type MdMode } from './PromptDetail'
import type { PromptLibrary } from '../../hooks/usePromptLibrary'
import {
  getAllCategories, getCategoryColor, getCategoryLabel,
  type Prompt, type Skill, type CustomCategoryDef,
} from '../../types/prompts'

type TabKind = 'prompts' | 'skills'

interface PromptBuilderProps {
  /**
   * The shared library instance. Must come from App.tsx so the composer's
   * picker, the chat strip, and this page all see the same state — calling
   * usePromptLibrary() in multiple places creates parallel React states that
   * only re-sync on full reload (localStorage on its own doesn't notify).
   */
  lib:          PromptLibrary
  onUseInChat:  (p: Prompt) => void
  onApplySkill: (s: Skill) => void
}

export function PromptBuilder({ lib, onUseInChat, onApplySkill }: PromptBuilderProps) {

  const [tab, setTab]             = useState<TabKind>('prompts')
  const [activePromptId, setActivePromptId] = useState<string>(lib.prompts[0]?.id ?? '')
  const [activeSkillId,  setActiveSkillId]  = useState<string>(lib.skills[0]?.id  ?? '')
  const [category, setCategory] = useState<string>('all')
  const [q,        setQ]        = useState<string>('')
  const [mdMode,   setMdMode]   = useState<MdMode>('split')
  const [favOnly,  setFavOnly]  = useState<boolean>(false)
  const [layout,   setLayout]   = useState<'cards' | 'rows'>('cards')

  // On phones the rail and detail can't share the screen. The `view` state
  // toggles between them; CSS hides whichever is inactive via the
  // `data-view` attribute on `.pb`. We default to `'list'` so a phone user
  // opening the page lands on the catalogue first.
  const { isMobile } = useMobileLayout()
  const [view, setView] = useState<'list' | 'detail'>('list')

  // Custom category management UI
  const [catMenuOpen, setCatMenuOpen] = useState(false)
  const [newCatName, setNewCatName]   = useState('')
  const catMenuRef = useRef<HTMLDivElement>(null)

  const items: (Prompt | Skill)[] = tab === 'prompts' ? lib.prompts : lib.skills
  const activeId   = tab === 'prompts' ? activePromptId : activeSkillId
  const setActiveId = tab === 'prompts' ? setActivePromptId : setActiveSkillId

  const active = items.find(x => x.id === activeId) ?? items[0]

  const categories = useMemo(() => getAllCategories(lib.customCategories), [lib.customCategories])

  const filtered = items.filter(x => {
    // Category chips are not part of the phone UI, so a category selected at
    // desktop width must not leave an invisible filter active after resize.
    if (!isMobile && category !== 'all' && x.category !== category) return false
    if (favOnly && !x.favorite) return false
    if (q) {
      const h = (x.title + ' ' + x.description + ' ' + x.body).toLowerCase()
      if (!h.includes(q.toLowerCase())) return false
    }
    return true
  })

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: items.length }
    for (const x of items) m[x.category] = (m[x.category] ?? 0) + 1
    return m
  }, [items])

  const commit = (draft: Prompt | Skill): void => {
    if (tab === 'prompts') lib.upsertPrompt(draft as Prompt)
    else                   lib.upsertSkill(draft as Skill)
  }

  const handleNew = (): void => {
    if (tab === 'prompts') {
      const np = lib.newPrompt()
      lib.upsertPrompt(np)
      setActivePromptId(np.id)
    } else {
      const ns = lib.newSkill()
      lib.upsertSkill(ns)
      setActiveSkillId(ns.id)
    }
  }

  const handleDuplicate = (): void => {
    if (!active) return
    const newId = lib.duplicate(tab, active.id)
    if (newId) setActiveId(newId)
  }

  const handleDelete = (): void => {
    if (!active) return
    if (tab === 'prompts') lib.deletePrompt(active.id)
    else                   lib.deleteSkill(active.id)
    const remaining = items.filter(x => x.id !== active.id)
    setActiveId(remaining[0]?.id ?? '')
  }

  const handleUseInChat = (): void => {
    if (!active || tab !== 'prompts') return
    lib.incUsage('prompts', active.id)
    onUseInChat(active as Prompt)
  }

  const handleApplySkill = (): void => {
    if (!active || tab !== 'skills') return
    const current = active as Skill
    lib.toggleSkillEnabled(current.id)
    lib.incUsage('skills', current.id)
    // Hand the parent the NEW state (post-toggle) so its status message
    // reads correctly. `active` is still the pre-toggle reference here.
    onApplySkill({ ...current, enabled: !current.enabled })
  }

  /** Flip a skill's `enabled` flag immediately (no draft / save dance). */
  const handleToggleSkillEnabled = (): void => {
    if (!active || tab !== 'skills') return
    const current = active as Skill
    lib.toggleSkillEnabled(current.id)
    onApplySkill({ ...current, enabled: !current.enabled })
  }

  const handleAddCategory = (): void => {
    const raw = newCatName.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    if (!raw) return
    const label = newCatName.trim()
    const id = raw
    const def: CustomCategoryDef = { id, label, color: getCategoryColor(id) }
    lib.addCustomCategory(def)
    setNewCatName('')
    setCatMenuOpen(false)
    if (!isMobile) setCategory(id)
  }

  return (
    <div className="pb" data-view={isMobile ? view : undefined}>
      <aside className="pb-left">
        <div className="pb-inner">
          <div className="pb-left-h">
          <div className="pb-title-row">
            <div className="pb-tabs">
              <button type="button" className={`pb-tab ${tab === 'prompts' ? 'on' : ''}`}
                onClick={() => setTab('prompts')}>
                <Icon name="sparkle" size={11} />
                Prompts
                <span className="pb-tab-c">{lib.prompts.length}</span>
              </button>
              <button type="button" className={`pb-tab ${tab === 'skills' ? 'on' : ''}`}
                onClick={() => setTab('skills')}>
                <Icon name="crew" size={11} />
                Skills
                <span className="pb-tab-c">{lib.skills.length}</span>
              </button>
            </div>
            <button type="button" className="pb-new" onClick={handleNew}>
              <Icon name="plus" size={11} /> New
            </button>
          </div>
          <div className="pb-search">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
              strokeWidth={1.75} strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input value={q} onChange={e => setQ(e.target.value)}
              placeholder={tab === 'prompts' ? 'search title, body, vars…' : 'search skills…'} />
            <span className="kbd">⌘F</span>
          </div>
        </div>

        <div className="pb-cats">
          {isMobile ? (
            <div className="pb-cats-tools">
                <div className="pb-cat-menu-wrap" ref={catMenuRef} style={{ position: 'relative' }}>
                  <button type="button"
                    className={`pb-icobtn ${catMenuOpen ? 'on' : ''}`}
                    onClick={() => setCatMenuOpen(o => !o)}
                    title="manage categories">
                    <Icon name="settings" size={12} />
                  </button>
                  {catMenuOpen && (
                    <div className="pd-menu" style={{ top: 'calc(100% + 6px)', right: 0, left: 'auto', minWidth: 200 }}>
                      {/* Section header — no hover, no pd-menu-item */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontFamily: 'var(--font-family-sans)', fontSize: 12.5, fontWeight: 600, color: 'var(--foreground)', cursor: 'default' }}>
                        <Icon name="folderPlus" size={13} />
                        add category
                      </div>
                      <div style={{ padding: '4px 10px', display: 'flex', gap: 6 }}>
                        <input
                          className="pd-chip"
                          style={{ flex: 1, fontSize: 11, padding: '4px 8px' }}
                          placeholder="frontend"
                          value={newCatName}
                          onChange={e => setNewCatName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleAddCategory() }}
                        />
                        <button className="pb-new" style={{ padding: '4px 8px', fontSize: 11 }}
                          onClick={handleAddCategory}>
                          <Icon name="plus" size={11} />
                        </button>
                      </div>
                      {lib.customCategories.length > 0 && (
                        <>
                          <div className="pd-menu-sep" />
                          {/* Section header — no hover, no pd-menu-item */}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontFamily: 'var(--font-family-sans)', fontSize: 12.5, fontWeight: 600, color: 'var(--foreground)', cursor: 'default' }}>
                            <Icon name="tags" size={13} />
                            custom
                          </div>
                          {lib.customCategories.map(c => (
                            <div key={c.id} className="pd-menu-item" style={{ justifyContent: 'space-between' }}>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span className="pb-cat-dot" style={{ background: c.color }} />
                                {c.label}
                              </span>
                              <button className="pd-icobtn" style={{ width: 22, height: 22 }}
                                onClick={() => lib.removeCustomCategory(c.id)} title="remove">
                                <Icon name="trash" size={11} />
                              </button>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
                <button type="button" className={`pb-icobtn ${favOnly ? 'on' : ''}`}
                  onClick={() => setFavOnly(f => !f)} title="favorites only">
                  <svg viewBox="0 0 24 24" width="13" height="13"
                    fill={favOnly ? 'currentColor' : 'none'} stroke="currentColor"
                    strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                </button>
                <button type="button" className={`pb-icobtn ${layout === 'cards' ? 'on' : ''}`}
                  onClick={() => setLayout(l => l === 'cards' ? 'rows' : 'cards')} title="layout">
                  <Icon name="grid" size={12} />
                </button>
            </div>
          ) : (
            <>
              {categories.map(c => (
                <button key={c.id} type="button"
                  className={`pb-cat ${category === c.id ? 'on' : ''}`}
                  onClick={() => setCategory(c.id)}>
                  <span className="pb-cat-dot" style={{
                    background: c.id === 'all'
                      ? 'var(--muted-foreground)'
                      : getCategoryColor(c.id),
                  }} />
                  {getCategoryLabel(c.id, lib.customCategories)}
                  <span className="pb-cat-count">{counts[c.id] ?? 0}</span>
                </button>
              ))}
              <span className="pb-cats-spacer" />
              <div className="pb-cat-menu-wrap" ref={catMenuRef} style={{ position: 'relative' }}>
                <button type="button"
                  className={`pb-icobtn ${catMenuOpen ? 'on' : ''}`}
                  onClick={() => setCatMenuOpen(o => !o)}
                  title="manage categories">
                  <Icon name="settings" size={12} />
                </button>
                {catMenuOpen && (
                  <div className="pd-menu" style={{ top: 'calc(100% + 6px)', right: 0, left: 'auto', minWidth: 200 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontFamily: 'var(--font-family-sans)', fontSize: 12.5, fontWeight: 600, color: 'var(--foreground)', cursor: 'default' }}>
                      <Icon name="folderPlus" size={13} />
                      add category
                    </div>
                    <div style={{ padding: '4px 10px', display: 'flex', gap: 6 }}>
                      <input
                        className="pd-chip"
                        style={{ flex: 1, fontSize: 11, padding: '4px 8px' }}
                        placeholder="frontend"
                        value={newCatName}
                        onChange={e => setNewCatName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleAddCategory() }}
                      />
                      <button className="pb-new" style={{ padding: '4px 8px', fontSize: 11 }}
                        onClick={handleAddCategory}>
                        <Icon name="plus" size={11} />
                      </button>
                    </div>
                    {lib.customCategories.length > 0 && (
                      <>
                        <div className="pd-menu-sep" />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', fontFamily: 'var(--font-family-sans)', fontSize: 12.5, fontWeight: 600, color: 'var(--foreground)', cursor: 'default' }}>
                          <Icon name="tags" size={13} />
                          custom
                        </div>
                        {lib.customCategories.map(c => (
                          <div key={c.id} className="pd-menu-item" style={{ justifyContent: 'space-between' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span className="pb-cat-dot" style={{ background: c.color }} />
                              {c.label}
                            </span>
                            <button className="pd-icobtn" style={{ width: 22, height: 22 }}
                              onClick={() => lib.removeCustomCategory(c.id)} title="remove">
                              <Icon name="trash" size={11} />
                            </button>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
              <button type="button" className={`pb-icobtn ${favOnly ? 'on' : ''}`}
                onClick={() => setFavOnly(f => !f)} title="favorites only">
                <svg viewBox="0 0 24 24" width="13" height="13"
                  fill={favOnly ? 'currentColor' : 'none'} stroke="currentColor"
                  strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
              </button>
              <button type="button" className={`pb-icobtn ${layout === 'cards' ? 'on' : ''}`}
                onClick={() => setLayout(l => l === 'cards' ? 'rows' : 'cards')} title="layout">
                <Icon name="grid" size={12} />
              </button>
            </>
          )}
        </div>

        <div className={`pb-list ${layout}`}>
          {filtered.length === 0 && (
            <div className="pb-empty">
              <div className="pb-empty-glyph">&gt;_</div>
              <div className="pb-empty-t">no {tab} match</div>
              <div className="pb-empty-s">try a different category, or clear the search.</div>
            </div>
          )}
          {filtered.map(x => (
            <PromptCard key={x.id} p={x} kind={tab} layout={layout}
              active={x.id === activeId}
              onSelect={() => {
                setActiveId(x.id)
                if (isMobile) setView('detail')
              }} />
          ))}
        </div>

        <div className="pb-left-foot">
          <span>{filtered.length} of {items.length}</span>
          <span className="pb-foot-kbd">
            {tab === 'prompts' ? '⌘P picker · / slash' : '⌘J apply skill'}
          </span>
        </div>
        </div>
      </aside>

      <section className="pb-right">
        {active ? (
          <PromptDetail
            key={active.id}
            kind={tab}
            p={active}
            isMobile={isMobile}
            mdMode={mdMode}
            setMdMode={setMdMode}
            customCategories={lib.customCategories}
            onCommit={commit}
            onUseInChat={handleUseInChat}
            onApplySkill={handleApplySkill}
            onToggleEnabled={handleToggleSkillEnabled}
            onDuplicate={handleDuplicate}
            onDelete={handleDelete}
            onBack={isMobile ? () => setView('list') : undefined}
          />
        ) : (
          <div className="pb-blank">
            <div className="pb-blank-glyph">&gt;_</div>
            <div className="pb-blank-t">no {tab === 'prompts' ? 'prompt' : 'skill'} selected</div>
            <button type="button" className="pb-blank-btn" onClick={handleNew}>
              <Icon name="plus" size={11} /> new {tab === 'prompts' ? 'prompt' : 'skill'}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

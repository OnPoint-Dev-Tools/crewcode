import { getCategoryLabel, getCategoryColor, extractVars, type Prompt, type Skill } from '../../types/prompts'

interface PromptCardProps {
  p:        Prompt | Skill
  kind:     'prompts' | 'skills'
  active:   boolean
  layout:   'cards' | 'rows'
  onSelect: () => void
}

export function PromptCard({ p, kind, active, layout, onSelect }: PromptCardProps) {
  const vars   = extractVars(p.body)
  const catLabel = getCategoryLabel(p.category)
  const accent = getCategoryColor(p.category)
  const isSkill = kind === 'skills'
  const enabled = isSkill && (p as Skill).enabled

  if (layout === 'rows') {
    return (
      <button type="button" className={`pb-row ${active ? 'on' : ''}`} onClick={onSelect}>
        <span className="pb-row-dot" style={{ background: accent }} />
        <span className="pb-row-main">
          <span className="pb-row-title">{p.title}</span>
          <span className="pb-row-desc">{p.description}</span>
        </span>
        <span className="pb-row-meta">
          {enabled && <span className="pb-row-on">on</span>}
          {!isSkill && vars.length > 0 && <span className="pb-row-var">{`{{${vars.length}}}`}</span>}
          <span className="pb-row-when">{p.lastUsed}</span>
        </span>
      </button>
    )
  }

  return (
    <button type="button" className={`pb-card ${active ? 'on' : ''}`} onClick={onSelect}>
      <span className="pb-card-bar" style={{ background: accent }} />
      <span className="pb-card-h">
        <span className="pb-card-cat" style={{ color: accent }}>
          <span className="pb-card-cat-dot" style={{ background: accent }} />
          {catLabel}
        </span>
        {enabled && (
          <span className="pb-card-on"><span className="dot" />active</span>
        )}
        {p.favorite && (
          <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" stroke="currentColor"
            strokeWidth={1.5} style={{ color: 'var(--warning)', marginLeft: 'auto' }}>
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        )}
      </span>
      <span className="pb-card-title">{p.title}</span>
      <span className="pb-card-desc">{p.description}</span>
      <span className="pb-card-foot">
        {!isSkill && vars.length > 0 && (
          <span className="pb-card-vars">{vars.length} var{vars.length === 1 ? '' : 's'}</span>
        )}
        <span className="pb-card-spacer" />
        <span className="pb-card-when">{p.lastUsed}</span>
      </span>
    </button>
  )
}

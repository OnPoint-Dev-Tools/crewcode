/**
 * ActiveSkillsStrip — persistent visible row of skills currently bound to the
 * active chat session. Sits above the composer so the user can see at a glance
 * what behaviour the agent has been told to adopt.
 *
 * Each chip shows two things:
 *  - the skill name
 *  - a delivery state dot:
 *      pending (●, amber) → enabled but not yet sent to this session
 *      live    (●, mint)  → already delivered as a system block this session
 *
 * Click the chip to jump to the skill in Prompt Builder. Click the × to
 * disable the skill globally.
 */
import { Icon } from '../ui/Icon'
import type { Skill } from '../../types/prompts'

interface ActiveSkillsStripProps {
  enabledSkills:    Skill[]
  deliveredIds:     string[]
  onToggleEnabled:  (skillId: string) => void
  onOpenInBuilder?: (skillId: string) => void
}

export function ActiveSkillsStrip({
  enabledSkills, deliveredIds, onToggleEnabled, onOpenInBuilder,
}: ActiveSkillsStripProps) {
  if (enabledSkills.length === 0) return null

  return (
    <div className="skill-strip" role="status" aria-label="active skills">
      <span className="skill-strip-label">
        <Icon name="crew" size={11} />
        skills active
      </span>
      {enabledSkills.map(s => {
        const live = deliveredIds.includes(s.id)
        return (
          <span
            key={s.id}
            className={`skill-chip ${live ? 'live' : 'pending'}`}
            title={live
              ? `${s.title} — injected as system prompt this session`
              : `${s.title} — will inject on your next message`}
          >
            <span className="skill-chip-dot" />
            <button
              type="button"
              className="skill-chip-name"
              onClick={() => onOpenInBuilder?.(s.id)}
            >
              {s.title}
            </button>
            <button
              type="button"
              className="skill-chip-x"
              onClick={() => onToggleEnabled(s.id)}
              aria-label={`disable skill ${s.title}`}
              title="disable this skill"
            >
              <Icon name="x" size={9} />
            </button>
          </span>
        )
      })}
    </div>
  )
}

import React, { useState } from 'react'

import { Icon } from '../ui/Icon'
import type { CrewTemplate } from '../../orchestrator/crew-templates'
import { shortModel } from './model-label'

interface CrewTemplatesCardProps {
  templates: CrewTemplate[]
  agentName: (agentId: string) => string
  onApply:   (tpl: CrewTemplate) => void
  onDelete:  (tplId: string) => void
}

/**
 * Lists saved crew presets and applies one on click. Lives inside the configure
 * surface, ahead of mode selection — picking a template is the fastest path to
 * a useful crew. Deletion is two-click (trash → confirm) so a fat-finger doesn't
 * lose a preset the operator depended on.
 */
export function CrewTemplatesCard({ templates, agentName, onApply, onDelete }: CrewTemplatesCardProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null)

  if (templates.length === 0) {
    return (
      <section className="crew-cfg-card crew-templates-card crew-templates-empty">
        <div className="crew-cfg-card-head">
          <span className="crew-cfg-card-title">templates</span>
        </div>
        <div className="crew-templates-blank">
          no saved templates yet — launch a crew, then save its setup from the surface header.
        </div>
      </section>
    )
  }

  return (
    <section className="crew-cfg-card crew-templates-card">
      <div className="crew-cfg-card-head">
        <span className="crew-cfg-card-title">templates</span>
        <span className="crew-cfg-card-count">{templates.length}</span>
      </div>
      <div className="crew-template-list">
        {templates.map(tpl => {
          const confirm = confirmId === tpl.id
          return (
            <div key={tpl.id} className="crew-template-row">
              <button
                type="button"
                className="crew-template-apply"
                onClick={() => onApply(tpl)}
                title={`apply · ${tpl.lanes.length} lane${tpl.lanes.length === 1 ? '' : 's'}`}
              >
                <span className="crew-template-name">{tpl.name}</span>
                <span className={`crew-template-mode mode-${tpl.mode}`}>
                  {tpl.mode === 'isolated' ? 'multi' : 'single'}
                </span>
                <span className="crew-template-summary mono">
                  {tpl.lanes.map(l => agentName(l.agentId) + (l.model ? `·${shortModel(l.model)}` : '')).join(' · ')}
                </span>
              </button>
              {confirm ? (
                <>
                  <button
                    type="button"
                    className="crew-template-rm crew-template-rm-yes"
                    onClick={() => { onDelete(tpl.id); setConfirmId(null) }}
                  >delete?</button>
                  <button
                    type="button"
                    className="crew-template-rm"
                    onClick={() => setConfirmId(null)}
                    title="cancel"
                  ><Icon name="x" size={11} /></button>
                </>
              ) : (
                <button
                  type="button"
                  className="crew-template-rm"
                  onClick={() => setConfirmId(tpl.id)}
                  title="delete"
                ><Icon name="trash" size={11} /></button>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

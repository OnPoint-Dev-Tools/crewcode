import React, { useRef, useState } from 'react'

import { Icon } from '../ui/Icon'
import { ModelPicker } from '../composer/ModelPicker'
import { shortModel } from './model-label'

interface LaneModelButtonProps {
  provider: string   // the lane's agent id — scopes the model list
  model:    string
  onPick:   (model: string) => void
  placement?: 'auto' | 'down'
}

/**
 * Per-lane model selector — an anchored ModelPicker scoped to the lane's agent.
 * Each lane can run a different model, so this lives in the lane row rather than
 * the shared composer.
 */
export function LaneModelButton({ provider, model, onPick, placement }: LaneModelButtonProps) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="crew-lane-model"
        title={model || 'provider default'}
        onClick={() => setOpen(o => !o)}
      >
        <Icon name="box" size={11} />
        <span className="crew-lane-model-id">{shortModel(model)}</span>
        <Icon name="chevDown" size={10} />
      </button>
      <ModelPicker
        open={open}
        onClose={() => setOpen(false)}
        anchor={ref.current}
        provider={provider}
        value={model}
        onPick={m => { onPick(m); setOpen(false) }}
        placement={placement}
      />
    </>
  )
}

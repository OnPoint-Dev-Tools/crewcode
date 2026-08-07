import React from 'react'
import { TASK_SHAPES, type TaskShape } from '../../orchestrator/decision-guide'

interface DecisionGuideProps {
  /** Task shape the user picked, or null if mode was set manually. */
  selectedShapeId: string | null
  onPick: (shape: TaskShape) => void
}

/**
 * The visual decision guide — five recognisable task shapes, each mapped to a
 * recommended workspace mode. Picking one applies its recommendation.
 */
export function DecisionGuide({ selectedShapeId, onPick }: DecisionGuideProps) {
  // Renders into the config panel's `.ccp-guide-body` (a flex column), so the
  // shapes use the panel's own `.ccp-shape` register rather than a separate one.
  return (
    <>
      {TASK_SHAPES.map(shape => (
        <button
          key={shape.id}
          type="button"
          className={`ccp-shape ${shape.id === selectedShapeId ? 'is-selected' : ''}`}
          onClick={() => onPick(shape)}
        >
          <div className="ccp-shape-row">
            <span>{shape.scenario}</span>
            <span className={`ccp-shape-tag is-${shape.recommend}`}>{shape.modeLabel}</span>
          </div>
          <div className="ccp-shape-rationale">{shape.rationale}</div>
        </button>
      ))}
    </>
  )
}

import React, { useState } from 'react'

import { Icon } from '../ui/Icon'
import type { CrewCollisionFinding } from '../../orchestrator/crew-collision-analysis'

/** What the heuristic actually matched, in operator language. */
const KIND_LABEL: Record<CrewCollisionFinding['kind'], string> = {
  'file-overlap':    'same file, both lanes',
  'behavioral-risk': 'cross-file contract',
}

/** High signals are the ones that can silently corrupt intent — show them first. */
const SEVERITY_RANK: Record<CrewCollisionFinding['severity'], number> = { high: 0, medium: 1 }

/** Files beyond this are collapsed behind a count so one finding can't flood the panel. */
const FILE_PREVIEW = 4

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

interface CrewCollisionReviewProps {
  findings: CrewCollisionFinding[]
  /** Heading shown when there is at least one finding. */
  title?: string
  /** One-line explanation under the heading. */
  note?: string
  /** Closing line — what the operator must do before the merge can proceed. */
  footer?: string
  /** Heading shown when the heuristics matched nothing. */
  emptyTitle?: string
  /** Copy under the empty heading. Absence of a finding is not a safety claim. */
  emptyNote?: string
}

/**
 * The cross-lane behavioral review gate, shared by the merge sidebar and the
 * Cross-lane Diff. Findings are advisory heuristics, never a correctness claim,
 * so the presentation leads with severity and the exact evidence (which lanes,
 * which files) rather than a verdict.
 */
export function CrewCollisionReview({
  findings,
  title,
  note,
  footer,
  emptyTitle = 'No cross-lane signals found',
  emptyNote,
}: CrewCollisionReviewProps) {
  const high   = findings.filter(f => f.severity === 'high').length
  const medium = findings.length - high
  // Copy, not sort-in-place: the caller's memoized array must not be mutated.
  const ordered = [...findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])

  if (findings.length === 0) {
    return (
      <section className="crew-risk-gate is-clear">
        <header className="crew-risk-gate-head">
          <span className="crew-risk-gate-icon"><Icon name="check" size={14} /></span>
          <div className="crew-risk-gate-heading">
            <strong>{emptyTitle}</strong>
            {emptyNote && <span>{emptyNote}</span>}
          </div>
        </header>
      </section>
    )
  }

  return (
    <section className="crew-risk-gate">
      <header className="crew-risk-gate-head">
        <span className="crew-risk-gate-icon"><Icon name="alert" size={14} /></span>
        <div className="crew-risk-gate-heading">
          <strong>{title ?? `${findings.length} cross-lane review signal${findings.length === 1 ? '' : 's'}`}</strong>
          {note && <span>{note}</span>}
        </div>
        <div className="crew-risk-tally">
          {high > 0   && <span className="crew-risk-count is-high">{high} high</span>}
          {medium > 0 && <span className="crew-risk-count is-medium">{medium} medium</span>}
        </div>
      </header>

      <ol className="crew-risk-list">
        {ordered.map((finding, index) => (
          <li
            className={`crew-risk-item is-${finding.severity}`}
            key={`${finding.kind}-${finding.laneIds.join('-')}-${index}`}
          >
            <div className="crew-risk-item-top">
              <span className={`crew-risk-badge is-${finding.severity}`}>{finding.severity}</span>
              <span className="crew-risk-kind">{KIND_LABEL[finding.kind]}</span>
            </div>

            <div className="crew-risk-lanes">
              <span className="crew-risk-lane">{finding.laneLabels[0]}</span>
              <span className="crew-risk-lane-link" aria-label="collides with">↔</span>
              <span className="crew-risk-lane">{finding.laneLabels[1]}</span>
            </div>

            <p className="crew-risk-reason">{sentence(finding.reason)}</p>

            <CollisionFiles files={finding.files} />
          </li>
        ))}
      </ol>

      {footer && (
        <footer className="crew-risk-gate-foot">
          <Icon name="inspection" size={11} />
          <span>{footer}</span>
        </footer>
      )}
    </section>
  )
}

/** Evidence list — one chip per path, collapsed past FILE_PREVIEW. */
function CollisionFiles({ files }: { files: string[] }) {
  const [expanded, setExpanded] = useState(false)
  if (files.length === 0) return null

  const shown  = expanded ? files : files.slice(0, FILE_PREVIEW)
  const hidden = files.length - shown.length

  return (
    <div className="crew-risk-files">
      {shown.map(file => (
        // Long paths are truncated at the front so the filename stays readable;
        // the full path is always available on hover.
        <span className="crew-risk-file mono" key={file} title={file}>{file}</span>
      ))}
      {hidden > 0 && (
        <button type="button" className="crew-risk-file-more" onClick={() => setExpanded(true)}>
          +{hidden} more
        </button>
      )}
      {expanded && files.length > FILE_PREVIEW && (
        <button type="button" className="crew-risk-file-more" onClick={() => setExpanded(false)}>
          show less
        </button>
      )}
    </div>
  )
}

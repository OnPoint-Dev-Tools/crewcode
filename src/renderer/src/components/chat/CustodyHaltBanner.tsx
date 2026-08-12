/**
 * Execution-custody halt banner.
 *
 * Shown when an invariant tripped and CrewCode can no longer vouch for the
 * authority a thread was executing under. The thread refuses privileged actions
 * until the user explicitly reauthorizes it.
 *
 * This surface exists to fail loudly. It names the exact failed invariant and
 * the exact affected scope rather than a generic "something went wrong", and it
 * shows the preserved evidence so the interrupted turn is not lost silently.
 */

import { useState } from 'react'
import type { CustodyHaltPayload } from '../../types'
import { Icon } from '../ui/Icon'

interface CustodyHaltBannerProps {
  halt: CustodyHaltPayload
  onReauthorize: () => void | Promise<void>
}

export function CustodyHaltBanner({ halt, onReauthorize }: CustodyHaltBannerProps) {
  const [showEvidence, setShowEvidence] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const { violation } = halt
    const hasEvidence = !!(halt.interruptedPrompt || halt.interruptedPartial)
  
    const reauthorize = async () => {
      setBusy(true)
      setError(null)
      try {
        await onReauthorize()
      } catch (cause) {
        setError((cause as Error).message || 'Reauthorization failed')
      } finally {
        setBusy(false)
      }
    }
  
    return (
      <div className="custody-halt" role="alert">
        <div className="custody-halt-head">
          <Icon name="alert" size={14} />
          <span className="custody-halt-title">{titleFor(violation.invariant)}</span>
          <span className="custody-halt-id">{violation.invariant}</span>
        </div>
  
        <p className="custody-halt-detail">{violation.detail}</p>
  
        <div className="custody-halt-scope">
          <span>agent <b>{violation.scope.provider}</b></span>
          <span>root <b>{violation.scope.cwd}</b></span>
          {violation.scope.turnId && <span>turn <b>{violation.scope.turnId}</b></span>}
        </div>
  
        <p className="custody-halt-note">
          Privileged actions on this thread are refused until you reauthorize.
          Nothing about the interrupted turn is assumed to have completed — check
          the workspace before continuing.
        </p>
  
        {hasEvidence && (
          <div className="custody-halt-evidence">
            <button type="button" className="custody-halt-link" onClick={() => setShowEvidence(v => !v)}>
              {showEvidence ? 'Hide' : 'Show'} preserved evidence
            </button>
            {showEvidence && (
              <>
                {halt.interruptedPrompt && (
                  <div className="custody-halt-quote">
                    <span className="custody-halt-quote-label">interrupted prompt</span>
                    <pre>{halt.interruptedPrompt}</pre>
                  </div>
                )}
                {halt.interruptedPartial && (
                  <div className="custody-halt-quote">
                    <span className="custody-halt-quote-label">partial response</span>
                    <pre>{halt.interruptedPartial}</pre>
                  </div>
                )}
              </>
            )}
          </div>
        )}
  
        {error && <p className="custody-halt-error">{error}</p>}
  
        <div className="custody-halt-actions">
          <button type="button" className="custody-halt-btn" onClick={reauthorize} disabled={busy}>
            {busy ? 'Reauthorizing…' : 'Reauthorize this thread'}
          </button>
        </div>
      </div>
    )
}

function titleFor(invariant: CustodyHaltPayload['violation']['invariant']): string {
  switch (invariant) {
    case 'authority-drift':        return 'Authority changed mid-execution'
    case 'execution-custody-lost': return 'Lost custody of a running turn'
    case 'scope-unknown':          return 'Workspace scope is unknown'
    case 'restart-recovery':       return 'Turn interrupted by restart'
    case 'orphaned-authorization': return 'Permission request orphaned'
  }
}

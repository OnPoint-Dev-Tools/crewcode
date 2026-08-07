import React, { useEffect, useState } from 'react'
import type { GhAuthEvent } from '../../types'

interface Props {
  onClose:   () => void
  onSuccess: () => void
}

/**
 * Drives the gh CLI device-code flow. Main spawns `gh auth login --web`,
 * we listen for code/url events, render the OTP in big mono characters
 * and a copy-to-clipboard helper, and close on success.
 */
export function GhAuthModal({ onClose, onSuccess }: Props) {
  const [code, setCode]     = useState<string | null>(null)
  const [url, setUrl]       = useState<string | null>(null)
  const [phase, setPhase]   = useState<'starting' | 'waiting' | 'success' | 'failure' | 'cancelled'>('starting')
  const [error, setError]   = useState<string | null>(null)
  const [log, setLog]       = useState<string[]>([])

  useEffect(() => {
    const off = window.electronAPI?.onGhAuthEvent((event: GhAuthEvent) => {
      if (event.type === 'code')     { setCode(event.code ?? null); setPhase('waiting') }
      else if (event.type === 'url') { setUrl(event.url ?? null);   setPhase('waiting') }
      else if (event.type === 'success')   { setPhase('success'); onSuccess() }
      else if (event.type === 'failure')   { setPhase('failure'); setError(event.error ?? 'auth failed') }
      else if (event.type === 'cancelled') { setPhase('cancelled') }
      else if (event.type === 'output' && event.text) {
        setLog(prev => [...prev.slice(-6), event.text!])
      }
    })

    window.electronAPI?.ghLoginStart().then(r => {
      if (!r.ok) {
        setPhase('failure')
        setError(r.error ?? 'failed to start gh auth login')
      }
    })

    return () => {
      off?.()
      // If the modal unmounts while a login is in flight, cancel it.
      window.electronAPI?.ghLoginCancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cancel = () => {
    window.electronAPI?.ghLoginCancel()
    onClose()
  }

  const copy = (s: string) => {
    navigator.clipboard.writeText(s).catch(() => { /* clipboard blocked */ })
  }

  return (
    <div className="ss-rebind-backdrop" onClick={cancel}>
      <div className="ss-rebind-modal ss-gh-modal" onClick={e => e.stopPropagation()}>
        <div className="ss-rebind-h">github authentication</div>

        {phase === 'starting' && (
          <div className="ss-gh-body">
            <div className="ss-gh-msg">starting gh auth login…</div>
          </div>
        )}

        {phase === 'waiting' && (
          <div className="ss-gh-body">
            {code && (
              <>
                <div className="ss-gh-label">one-time code</div>
                <div className="ss-gh-code" onClick={() => copy(code)} title="click to copy">{code}</div>
                <div className="ss-gh-hint">click to copy</div>
              </>
            )}
            {url && (
              <>
                <div className="ss-gh-label">open in browser</div>
                <a className="ss-gh-url" href={url} onClick={e => { e.preventDefault(); copy(url) }}>{url}</a>
                <div className="ss-gh-hint">opened automatically · paste the code there</div>
              </>
            )}
            {!code && !url && <div className="ss-gh-msg">waiting for github to issue a code…</div>}
          </div>
        )}

        {phase === 'success' && (
          <div className="ss-gh-body">
            <div className="ss-gh-msg">authenticated — closing…</div>
          </div>
        )}

        {(phase === 'failure' || phase === 'cancelled') && (
          <div className="ss-gh-body">
            <div className="ss-gh-msg">{phase === 'cancelled' ? 'cancelled' : 'failed'}</div>
            {error && <div className="ss-gh-error">{error}</div>}
          </div>
        )}

        {log.length > 0 && (
          <details className="ss-gh-log">
            <summary>gh output</summary>
            <pre>{log.join('\n')}</pre>
          </details>
        )}

        <div className="ss-rebind-actions">
          {phase === 'success'
            ? <button className="ss-btn primary" onClick={onClose}>done</button>
            : <button className="ss-btn" onClick={cancel}>cancel</button>}
        </div>
      </div>
    </div>
  )
}

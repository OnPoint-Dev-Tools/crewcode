import { useEffect, useMemo, useState } from 'react'
import type { BrainAccessScope } from '../../../../shared/hub-relay-types'
import { brainAuthorizationRelay } from '../../runtime/brain-authorization-runtime'

const SCOPES: Array<{ id: BrainAccessScope; label: string; detail: string }> = [
  { id: 'workspace:read', label: 'Workspace read', detail: 'Files, Git status, and workspace discovery' },
  { id: 'workspace:write', label: 'Workspace write', detail: 'File changes, Git mutations, and attachments' },
  { id: 'terminal', label: 'Terminal', detail: 'Create and control Brain-local shells' },
  { id: 'agent', label: 'Agents', detail: 'Start providers, prompts, tools, and MCP' },
]
interface Policy {
  scopes: BrainAccessScope[]; roots: string[]; updatedAt: number
  audit: Array<{ at: number; scopes: BrainAccessScope[]; roots: string[] }>
}

export function BrainAuthorizationSection() {
  const relay = brainAuthorizationRelay()
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [scopes, setScopes] = useState<BrainAccessScope[]>([])
  const [roots, setRoots] = useState<string[]>([])
  const [newRoot, setNewRoot] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!relay) return
    void relay.transport.rpc<Policy>('brain.authorization.get', {}).then(next => {
      setPolicy(next); setScopes(next.scopes); setRoots(next.roots)
    }).catch(error => setMessage((error as Error).message))
  }, [relay])
  const reducing = useMemo(() => !!policy && (policy.scopes.some(scope => !scopes.includes(scope)) || policy.roots.some(root => !roots.includes(root))), [policy, roots, scopes])
  if (!relay) return null

  const save = async () => {
    const trimmed = newRoot.trim()
    const nextRoots = trimmed && !roots.includes(trimmed) ? [...roots, trimmed] : roots
    if (scopes.length > 0 && nextRoots.length === 0) { setMessage('At least one workspace root is required while scopes are enabled.'); return }
    if (reducing && !window.confirm('Reducing Brain authority immediately stops affected agents and terminals. Continue?')) return
    setSaving(true); setMessage('')
    try {
      const result = await relay.transport.rpc<{ policy: Policy; stopped: { paneIds: string[]; bridgeIds: string[] } }>('brain.authorization.update', { scopes, roots: nextRoots })
      setPolicy(result.policy); setScopes(result.policy.scopes); setRoots(result.policy.roots); setNewRoot('')
      await relay.reconnect({ force: true })
      const stopped = result.stopped.paneIds.length + result.stopped.bridgeIds.length
      setMessage(stopped ? `Saved. ${stopped} affected resource${stopped === 1 ? '' : 's'} stopped.` : 'Authorization saved and secure tunnel renewed.')
    } catch (error) { setMessage((error as Error).message) }
    finally { setSaving(false) }
  }

  return (
    <section id="brain-authorization" className="ss-section">
      <div className="ss-section-h"><h2>Brain Authorization</h2><span className="desc">remote scopes &amp; workspace roots</span></div>
      <div className="ss-card" data-q="brain authorization remote scopes workspace roots permissions access">
        <div className="ss-row"><div><div className="name">Brain-local policy</div><div className="help">Stored and enforced on the enrolled Brain. The Hub cannot read or widen these grants.</div></div></div>
        {SCOPES.map(item => <div className="ss-row" key={item.id}>
          <div><div className="name">{item.label}</div><div className="help">{item.detail}</div></div>
          <button className={'ss-toggle' + (scopes.includes(item.id) ? ' on' : '')} role="switch" aria-checked={scopes.includes(item.id)} onClick={() => setScopes(current => current.includes(item.id) ? current.filter(scope => scope !== item.id) : [...current, item.id])} />
        </div>)}
      </div>
      <div className="ss-section-h" style={{ marginTop: 18 }}><h2>Workspace Roots</h2><span className="desc">absolute directories permitted on Brain</span></div>
      <div className="ss-card" data-q="brain workspace roots directories allowed paths">
        {roots.map(root => <div className="ss-row" key={root}><div className="help" style={{ fontFamily: 'var(--font-mono)', overflowWrap: 'anywhere' }}>{root}</div><button className="ss-btn" onClick={() => setRoots(current => current.filter(value => value !== root))}>Remove</button></div>)}
        <div className="ss-row"><input value={newRoot} onChange={event => setNewRoot(event.target.value)} placeholder="/absolute/path/on/brain" style={{ flex: 1, minWidth: 0 }} /><button className="ss-btn" onClick={() => { const root = newRoot.trim(); if (root && !roots.includes(root)) setRoots([...roots, root]); setNewRoot('') }}>Add</button></div>
        {reducing && <div className="help" style={{ color: 'var(--warning, #e4b66a)' }}>Reducing authority immediately stops affected live agents and terminals.</div>}
        {message && <div className="help" role="status" style={{ marginTop: 10 }}>{message}</div>}
        <div className="ss-row" style={{ justifyContent: 'flex-end' }}><button className="ss-btn primary" disabled={saving || !policy} onClick={() => void save()}>{saving ? 'Saving…' : 'Save and renew tunnel'}</button></div>
      </div>
      {policy?.audit.length ? <div className="ss-card" data-q="brain authorization audit history" style={{ marginTop: 12 }}><details><summary>Local audit history ({policy.audit.length})</summary>{policy.audit.slice(-10).reverse().map((event, index) => <pre key={`${event.at}-${index}`} style={{ whiteSpace: 'pre-wrap', fontSize: 11 }}>{new Date(event.at).toLocaleString()} · scopes: {event.scopes.join(', ') || 'none'} · roots: {event.roots.join(', ') || 'none'}</pre>)}</details></div> : null}
    </section>
  )
}

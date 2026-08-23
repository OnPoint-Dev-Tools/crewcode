import { useEffect, useRef, useState } from 'react'
import type { AgentProviderId, AgentUserRequest, BridgeEvent } from '../types'
import { getCrewCodeClient } from './crewcode-client'

interface ChatRow { id: string; role: 'user' | 'agent' | 'system'; text: string }

const PROVIDERS: Array<{ id: AgentProviderId; label: string }> = [
  { id: 'crewcoder', label: 'CrewCoder' }, { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' }, { id: 'opencode', label: 'OpenCode' },
  { id: 'pi', label: 'Pi' }, { id: 'hermes', label: 'Hermes' },
  { id: 'grok', label: 'Grok Build' },
  { id: 'ollama', label: 'Ollama' }, { id: 'openrouter', label: 'OpenRouter' },
]

export function WebAgentChat({ workspacePath, workspaceId, onClose }: { workspacePath: string; workspaceId: string; onClose: () => void }) {
  // Stable browser identity allows a fresh authenticated page to reclaim the
  // same Brain-owned execution instead of spawning or stopping it on teardown.
  const bridgeId = useRef(`web-chat-${workspaceId}`)
  const [provider, setProvider] = useState<AgentProviderId>('crewcoder')
  const [rows, setRows] = useState<ChatRow[]>([])
  const [draft, setDraft] = useState('')
  const [running, setRunning] = useState(false)
  const [startedProvider, setStartedProvider] = useState<AgentProviderId | null>(null)
  const [request, setRequest] = useState<AgentUserRequest | null>(null)

  useEffect(() => {
    const api = getCrewCodeClient()
    const off = api.onBridgeEvent((event: BridgeEvent) => {
      const eventBridgeId = event.type === 'user_request' ? event.request.bridgeId : event.bridgeId
      if (eventBridgeId !== bridgeId.current) return
      if (event.type === 'turn_start') setRunning(true)
      else if (event.type === 'history_agent') {
        // Reclaim sends an authoritative snapshot because final deltas may have
        // raced the old page closing. Replace that turn rather than appending a
        // duplicate or preserving only the partial text rendered before close.
        setRows(current => {
          const existing = current.findIndex(row => row.role === 'agent' && row.id === event.turnId)
          if (existing === -1) return [...current, { id: event.turnId, role: 'agent', text: event.text }]
          return current.map((row, index) => index === existing ? { ...row, text: event.text } : row)
        })
      } else if (event.type === 'text_delta') {
        setRows(current => {
          const last = current[current.length - 1]
          return last?.role === 'agent' ? [...current.slice(0, -1), { ...last, text: last.text + event.delta }] : [...current, { id: event.turnId, role: 'agent', text: event.delta }]
        })
      } else if (event.type === 'turn_end') setRunning(false)
      else if (event.type === 'error') { setRunning(false); setRows(current => [...current, { id: `${Date.now()}`, role: 'system', text: event.message }]) }
      else if (event.type === 'closed') setRunning(false)
      else if (event.type === 'status') setRows(current => [...current, { id: `${Date.now()}-status`, role: 'system', text: event.message }])
      else if (event.type === 'user_request') setRequest(event.request)
      else if (event.type === 'user_request_resolved') setRequest(current => current?.requestId === event.requestId ? null : current)
    })
    // Browser/component teardown only detaches event observation. Execution
    // lifecycle belongs to Brain; explicit Stop/reset/removal actions terminate.
    return () => { off() }
  }, [])

  const send = async () => {
    const text = draft.trim()
    if (!text || running) return
    setDraft('')
    setRows(current => [...current, { id: `${Date.now()}-user`, role: 'user', text }])
    const api = getCrewCodeClient()
    if (startedProvider !== provider) {
      if (startedProvider) api.bridgeStop(bridgeId.current)
      const started = await api.bridgeStart({ bridgeId: bridgeId.current, provider, cwd: workspacePath, mode: 'build', thinking: 'medium', conversationScopeKey: `web:${workspaceId}:${provider}` })
      if (started.error) {
        setRows(current => [...current, { id: `${Date.now()}-error`, role: 'system', text: started.error! }])
        return
      }
      setStartedProvider(provider)
    }
    setRunning(true)
    const result = await api.bridgePrompt(bridgeId.current, text)
    if (!result.ok) {
      setRunning(false)
      setRows(current => [...current, { id: `${Date.now()}-error`, role: 'system', text: result.error ?? 'prompt failed' }])
    }
  }

  const answer = async (action: 'accept' | 'decline') => {
    if (!request) return
    await getCrewCodeClient().bridgeRespondUserRequest({ requestId: request.requestId, action })
    setRequest(null)
  }

  return (
    <div style={{ display: 'grid', gridTemplateRows: '42px 1fr auto 74px', minHeight: 0 }}>
      <header style={{ borderBottom: '1px solid #1c2f2f', display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px' }}>
        <strong style={{ flex: 1 }}>Agent Chat</strong>
        <select value={provider} disabled={running} onChange={event => setProvider(event.target.value as AgentProviderId)} style={{ background: '#131713', color: '#d7e0dc', border: '1px solid #1c2f2f', padding: 5 }}>
          {PROVIDERS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        {running && <button onClick={() => getCrewCodeClient().bridgeAbort(bridgeId.current)}>Stop</button>}
        <button onClick={onClose}>Close</button>
      </header>
      <div style={{ overflow: 'auto', padding: 16 }}>
        {rows.length === 0 && <p style={{ color: '#8da49a' }}>Send a task to an agent running on the CrewCode server.</p>}
        {rows.map(row => <div key={row.id} style={{ margin: '0 0 14px', padding: 10, border: '1px solid #1c2f2f', background: row.role === 'user' ? '#11201b' : row.role === 'system' ? '#131713' : 'transparent', whiteSpace: 'pre-wrap' }}><small style={{ color: '#8da49a' }}>{row.role}</small><div>{row.text}</div></div>)}
      </div>
      {request && <div style={{ borderTop: '1px solid #1c2f2f', padding: 12 }}><strong>{request.title}</strong><p>{request.message ?? request.detail}</p><button onClick={() => void answer('decline')}>Decline</button> <button onClick={() => void answer('accept')} style={{ background: '#285a48', color: '#fff' }}>Allow once</button></div>}
      <div style={{ borderTop: '1px solid #1c2f2f', padding: 10, display: 'grid', gridTemplateColumns: '1fr auto', gap: 8 }}>
        <textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} placeholder="Message the agent" style={{ resize: 'none', background: '#131713', color: '#d7e0dc', border: '1px solid #1c2f2f', padding: 8 }} />
        <button disabled={!draft.trim() || running} onClick={() => void send()} style={{ background: '#285a48', color: '#fff', border: '1px solid #1c2f2f', padding: '0 16px' }}>Send</button>
      </div>
    </div>
  )
}

import React, { useEffect, useMemo, useState } from 'react'
import { Icon } from '../ui/Icon'
import { effortRowsForProvider, type EffortLevel } from '../composer/EffortPicker'
import { useProviderModels } from '../../hooks/useProviderModels'
import type { AgentInfo, Session } from '../../types'

export interface HandoffSelection {
  targetSessionId: string | 'new'
  provider: string
  model: string
  effort: EffortLevel
}

interface HandoffCardProps {
  open: boolean
  sourceSessionId: string
  sessions: Session[]
  agents: AgentInfo[]
  defaultProvider: string
  defaultModel: string
  defaultEffort: EffortLevel
  busy?: boolean
  error?: string | null
  onClose: () => void
  onConfirm: (selection: HandoffSelection) => void
}

export function HandoffCard({
  open, sourceSessionId, sessions, agents, defaultProvider, defaultModel, defaultEffort,
  busy = false, error, onClose, onConfirm,
}: HandoffCardProps) {
  const [destinationTab, setDestinationTab] = useState<'new' | 'used'>('new')
  const [targetSessionId, setTargetSessionId] = useState<string | null>(null)
  const [provider, setProvider] = useState(defaultProvider)
  const [model, setModel] = useState(defaultModel)
  const [effort, setEffort] = useState<EffortLevel>(defaultEffort)
  const availableAgents = useMemo(() => agents.filter(agent => agent.available && agent.transport === 'bridge'), [agents])
  const targetSessions = useMemo(() => sessions.filter(session => session.id !== sourceSessionId), [sessions, sourceSessionId])
  const detected = useProviderModels(provider, open && destinationTab === 'new', open && destinationTab === 'new')
  const effortRows = effortRowsForProvider(provider)
  const selectedExisting = destinationTab === 'used'
    ? targetSessions.find(session => session.id === targetSessionId) ?? null
    : null

  useEffect(() => {
    if (!open) return
    setDestinationTab('new')
    setTargetSessionId(null)
    setProvider(defaultProvider)
    setModel(defaultModel)
    setEffort(defaultEffort)
  }, [open, defaultProvider, defaultModel, defaultEffort])

  useEffect(() => {
    if (destinationTab !== 'used') return
    if (!targetSessions.some(session => session.id === targetSessionId)) {
      setTargetSessionId(targetSessions[0]?.id ?? null)
    }
  }, [destinationTab, targetSessionId, targetSessions])

  useEffect(() => {
    if (!selectedExisting) return
    setProvider(selectedExisting.agentId)
    setModel(selectedExisting.model)
    setEffort(selectedExisting.effort)
  }, [selectedExisting])

  useEffect(() => {
    if (destinationTab !== 'new') return
    if (effortRows.length > 0 && !effortRows.some(row => row.id === effort)) setEffort(effortRows[0].id)
  }, [provider, destinationTab, effort, effortRows])

  if (!open) return null

  const selectNewTab = () => {
    setDestinationTab('new')
    setProvider(defaultProvider)
    setModel(defaultModel)
    setEffort(defaultEffort)
  }
  const selectUsedTab = () => setDestinationTab('used')
  const canConfirm = availableAgents.length > 0 && (destinationTab === 'new' || !!selectedExisting)

  return (
    <div className="handoff-card-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="handoff-card" role="dialog" aria-modal="true" aria-labelledby="handoff-card-title">
        <header className="handoff-card-header">
          <span className="handoff-card-icon"><Icon name="refresh" size={15} /></span>
          <div>
            <h2 id="handoff-card-title">Context handoff</h2>
            <p>Summarize this chat and continue it in another provider session.</p>
          </div>
          <button type="button" className="handoff-card-close" onClick={onClose} disabled={busy} aria-label="Close handoff"><Icon name="close" size={13} /></button>
        </header>

        <div className="handoff-card-tabs" role="tablist" aria-label="Handoff destination">
          <button type="button" role="tab" aria-selected={destinationTab === 'new'} className={destinationTab === 'new' ? 'on' : ''} onClick={selectNewTab} disabled={busy}>New chat</button>
          <button type="button" role="tab" aria-selected={destinationTab === 'used'} className={destinationTab === 'used' ? 'on' : ''} onClick={selectUsedTab} disabled={busy}>Chats <span>{targetSessions.length}</span></button>
        </div>

        {destinationTab === 'new' ? (
          <div className="handoff-new-destination" role="tabpanel">
            <b>Start a clean destination</b>
            <small>Choose the provider, model, and effort for this workspace.</small>
          </div>
        ) : (
          <div className="handoff-card-section" role="tabpanel">
            {targetSessions.length === 0 ? <p className="handoff-empty">No other used chats are available in this workspace.</p> : null}
            {targetSessions.map(session => (
              <label key={session.id} className={`handoff-target-row ${targetSessionId === session.id ? 'on' : ''}`}>
                <input type="radio" name="handoff-target" checked={targetSessionId === session.id} onChange={() => setTargetSessionId(session.id)} />
                <span><b>{session.label}</b><small>{session.agentId} · {session.model || 'default model'} · {session.effort}</small></span>
              </label>
            ))}
          </div>
        )}

        <div className="handoff-config-grid">
          <label>Provider
            <select value={provider} disabled={!!selectedExisting || busy} onChange={event => { setProvider(event.target.value); setModel('') }}>
              {availableAgents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          <label>Model
            <select value={model} disabled={!!selectedExisting || busy} onChange={event => setModel(event.target.value)}>
              <option value="">Provider default</option>
              {detected.list.filter(item => item.id).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
              {model && !detected.list.some(item => item.id === model) ? <option value={model}>{model}</option> : null}
            </select>
          </label>
          <label>Effort
            <select value={effort} disabled={!!selectedExisting || busy || effortRows.length === 0} onChange={event => setEffort(event.target.value as EffortLevel)}>
              {effortRows.length === 0 ? <option value={effort}>Provider default</option> : effortRows.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
            </select>
          </label>
        </div>

        {selectedExisting ? <p className="handoff-existing-note">This used chat keeps its selected provider, model, effort, and existing transcript.</p> : null}
        {error ? <div className="handoff-card-error">{error}</div> : null}

        <footer className="handoff-card-footer">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="primary" disabled={busy || !canConfirm} onClick={() => onConfirm({ targetSessionId: destinationTab === 'new' ? 'new' : selectedExisting!.id, provider, model, effort })}>
            {busy ? 'Preparing handoff…' : 'Hand off context'}
          </button>
        </footer>
      </section>
    </div>
  )
}

import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { ProviderPicker } from './ProviderPicker'
import { ModelPicker } from './ModelPicker'
import { EffortPicker, effortRowsForProvider, providerSupportsEffort } from './EffortPicker'
import { McpPicker } from './McpPicker'
import { PROVIDER_META, PROVIDER_IMAGES, providerImageClass } from './provider-meta'
import { prefetchProviderModels, useProviderModels } from '../../hooks/useProviderModels'
import type { EffortLevel } from './EffortPicker'
import type { AgentInfo } from '../../types'
import type { McpServerConfig } from '../../hooks/useSettings'
import type { Mode } from './ModeSegment'
import { ModeSegment } from './ModeSegment'
import { CrewCoderModePicker } from './CrewCoderModePicker'
import { CrewCoderApprovalPicker } from './CrewCoderApprovalPicker'
import type { CrewCoderApprovalMode, CrewCoderMode } from '../../../../shared/crewcoder-types'

interface ModelRowProps {
  agents:        AgentInfo[]
  activeAgentId: string
  onSelectAgent: (id: string) => void

  model:         string
  onSelectModel: (m: string) => void

  effort:        EffortLevel
  onSelectEffort: (e: EffortLevel) => void
  mode:    Mode
  setMode: (m: Mode) => void
  crewcoderMode?: CrewCoderMode
  onSelectCrewCoderMode: (mode: CrewCoderMode | undefined) => void
  crewcoderApprovalMode: CrewCoderApprovalMode
  onSelectCrewCoderApprovalMode: (mode: CrewCoderApprovalMode) => void
  crewcoderModeDisabled?: boolean
  executionModeDisabled?: boolean

  // MCP picker is only rendered when enabled in Settings. `mcpServers` is the
  // registry; `selectedMcpIds` is the active session's opt-in set.
  mcpEnabled?:    boolean
  mcpServers?:    McpServerConfig[]
  selectedMcpIds?: string[]
  onToggleMcp?:   (id: string) => void

  // Fires when any picker opens or closes, so a
  // hover-reveal container can stay pinned open while a portaled dropdown is up.
  onOpenChange?:  (open: boolean) => void
}

const EFFORT_LABEL: Record<EffortLevel, string> = {
  off: 'off', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'ultra',
}

function shortModel(id: string): string {
  if (!id) return 'auto'
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

export interface ModelRowHandle {
  openModelPicker: () => void
  // Advance to the next (+1) / previous (-1) model in the active provider's
  // list, wrapping at the ends. Drives the ⌘⇧M switch-model shortcut.
  cycleModel: (dir: 1 | -1) => void
}

export function crewCoderModesAvailable(agents: AgentInfo[], activeAgentId: string): boolean {
  return activeAgentId === 'crewcoder' && agents.some(agent => agent.id === 'crewcoder' && agent.available)
}

export function crewCoderApprovalAvailable(agents: AgentInfo[], activeAgentId: string, mode?: CrewCoderMode): boolean {
  return crewCoderModesAvailable(agents, activeAgentId) && mode === 'crewcoder'
}

export const ModelRow = forwardRef<ModelRowHandle, ModelRowProps>(function ModelRow({
  agents, setMode, mode, crewcoderMode, onSelectCrewCoderMode, crewcoderApprovalMode, onSelectCrewCoderApprovalMode, crewcoderModeDisabled = false, executionModeDisabled = false, activeAgentId, onSelectAgent,
  model, onSelectModel,
  effort, onSelectEffort,
  mcpEnabled = false, mcpServers = [], selectedMcpIds = [], onToggleMcp,
  onOpenChange,
}, ref) {
  const provRef   = useRef<HTMLButtonElement>(null)
  const modelRef  = useRef<HTMLButtonElement>(null)
  const effortRef = useRef<HTMLButtonElement>(null)
  const mcpRef    = useRef<HTMLButtonElement>(null)
  const crewCoderModeRef = useRef<HTMLButtonElement>(null)
  const crewCoderApprovalRef = useRef<HTMLButtonElement>(null)

  const [provOpen,   setProvOpen]   = useState(false)
  const [modelOpen,  setModelOpen]  = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [mcpOpen,    setMcpOpen]    = useState(false)
  const [crewCoderModeOpen, setCrewCoderModeOpen] = useState(false)
  const [crewCoderApprovalOpen, setCrewCoderApprovalOpen] = useState(false)

  useEffect(() => {
    onOpenChange?.(provOpen || modelOpen || effortOpen || mcpOpen || crewCoderModeOpen || crewCoderApprovalOpen)
  }, [provOpen, modelOpen, effortOpen, mcpOpen, crewCoderModeOpen, crewCoderApprovalOpen, onOpenChange])

  useEffect(() => {
    if (crewcoderModeDisabled) {
      setCrewCoderModeOpen(false)
      setCrewCoderApprovalOpen(false)
    }
  }, [crewcoderModeDisabled])

  // Only count selections that still exist in the registry, so a removed server
  // doesn't leave a stale badge count.
  const mcpCount = selectedMcpIds.filter(id => mcpServers.some(s => s.id === id)).length

  // Resolved once here and handed to the picker so we don't fetch the list twice.
  const { list: models } = useProviderModels(activeAgentId)

  useImperativeHandle(ref, () => ({
    openModelPicker: () => { setModelOpen(true); setProvOpen(false); setEffortOpen(false); setCrewCoderModeOpen(false); setCrewCoderApprovalOpen(false) },
    cycleModel: (dir: 1 | -1) => {
      if (models.length === 0) return
      const idx  = models.findIndex(m => m.id === model)
      const from = idx === -1 ? (dir === 1 ? -1 : 0) : idx
      const next = models[((from + dir) % models.length + models.length) % models.length]
      if (next) onSelectModel(next.id)
    },
  }), [models, model, onSelectModel])

  const active = agents.find(a => a.id === activeAgentId) ?? agents.find(a => a.available)
  const showCrewCoderModes = crewCoderModesAvailable(agents, activeAgentId)
  const showCrewCoderApproval = crewCoderApprovalAvailable(agents, activeAgentId, crewcoderMode)

  const handleSelectAgent = (id: string) => {
    // Start resolving the next provider immediately so the model picker is warm.
    void prefetchProviderModels(id, true)
    // Provider changes must not silently downgrade an unsupported effort preset.
    if (!providerSupportsEffort(id, effort)) onSelectEffort(effortRowsForProvider(id)[0]?.id ?? 'off')
    onSelectAgent(id)
  }

  return (
    <div className="model-row">
      <button
        ref={provRef}
        className={`model-btn ${active?.id ? 'active' : ''}`}
        onClick={() => { setProvOpen(o => !o); setModelOpen(false); setEffortOpen(false); setCrewCoderModeOpen(false); setCrewCoderApprovalOpen(false) }}
        title={active?.path ?? active?.name}
      >
        {PROVIDER_IMAGES[active?.id ?? '']
          ? <img src={PROVIDER_IMAGES[active?.id ?? '']} alt={active?.id} width={18} height={18} className={providerImageClass(active?.id ?? '')} style={{ display: 'block' }} />
          : <Icon name={(PROVIDER_META[active?.id ?? '']?.icon ?? 'brain') as any} size={11} />
        }
        {active?.id ?? 'detecting…'}
        <Icon name="chevDown" size={11} />
      </button>

      {showCrewCoderModes && (
        <button
          ref={crewCoderModeRef}
          className="model-btn crewcoder-mode-btn active"
          disabled={crewcoderModeDisabled}
          onClick={() => {
            setCrewCoderModeOpen(open => !open)
            setProvOpen(false)
            setModelOpen(false)
            setEffortOpen(false)
            setMcpOpen(false)
            setCrewCoderApprovalOpen(false)
          }}
          title={crewcoderModeDisabled ? 'CrewCoder mode cannot change during a running turn' : 'select CrewCoder agent mode'}
        >
          <Icon name="tags" size={11} /> crew · {crewcoderMode ?? 'configured'}
          <Icon name="chevDown" size={11} />
        </button>
      )}

      {showCrewCoderApproval && (
        <button
          ref={crewCoderApprovalRef}
          className={`model-btn crewcoder-approval-btn ${crewcoderApprovalMode !== 'review' ? 'active' : ''}`}
          disabled={crewcoderModeDisabled}
          onClick={() => {
            setCrewCoderApprovalOpen(open => !open)
            setProvOpen(false)
            setModelOpen(false)
            setEffortOpen(false)
            setMcpOpen(false)
            setCrewCoderModeOpen(false)
          }}
          title={crewcoderModeDisabled ? 'CrewCoder approval cannot change during a running turn' : 'select CrewCoder approval policy'}
        >
          <Icon name="key" size={11} /> {crewcoderApprovalMode.replace('-', ' ')}
          <Icon name="chevDown" size={11} />
        </button>
      )}

      <button
        ref={modelRef}
        className="model-btn"
        onClick={() => { setModelOpen(o => !o); setProvOpen(false); setEffortOpen(false); setCrewCoderModeOpen(false); setCrewCoderApprovalOpen(false) }}
      >
        <Icon name="crew" size={11} /> {shortModel(model)}
        <Icon name="chevDown" size={11} />
      </button>

      <button
        ref={effortRef}
        className="model-btn"
        disabled={effortRowsForProvider(activeAgentId).length === 0}
        title={effortRowsForProvider(activeAgentId).length === 0 ? 'This provider does not expose reasoning-effort controls' : undefined}
        onClick={() => { setEffortOpen(o => !o); setProvOpen(false); setModelOpen(false); setMcpOpen(false); setCrewCoderModeOpen(false); setCrewCoderApprovalOpen(false) }}
      >
        <Icon name="sliders" size={11} /> {EFFORT_LABEL[effort]}
        <Icon name="chevDown" size={11} />
      </button>

      {mcpEnabled && (
        <button
          ref={mcpRef}
          className={`model-btn ${mcpCount > 0 ? 'active' : ''}`}
          onClick={() => { setMcpOpen(o => !o); setProvOpen(false); setModelOpen(false); setEffortOpen(false); setCrewCoderModeOpen(false); setCrewCoderApprovalOpen(false) }}
          title="select mcp servers for this session"
        >
          <Icon name="box" size={11} /> mcp{mcpCount > 0 ? ` · ${mcpCount}` : ''}
          <Icon name="chevDown" size={11} />
        </button>
      )}
      {showCrewCoderModes && (
        <CrewCoderModePicker
          open={crewCoderModeOpen}
          onClose={() => setCrewCoderModeOpen(false)}
          anchor={crewCoderModeRef.current}
          value={crewcoderMode}
          onPick={onSelectCrewCoderMode}
        />
      )}
      {showCrewCoderApproval && (
        <CrewCoderApprovalPicker
          open={crewCoderApprovalOpen}
          onClose={() => setCrewCoderApprovalOpen(false)}
          anchor={crewCoderApprovalRef.current}
          value={crewcoderApprovalMode}
          onPick={onSelectCrewCoderApprovalMode}
        />
      )}

      <div style={{ marginLeft: 'auto', fontFamily: 'var(--font-family-mono)', fontSize: 10.5, color: '#5a625a' }}>
        <ModeSegment
          mode={mode}
          onChange={setMode}
          disabled={executionModeDisabled}
          disabledReason="CrewCoder profile active · Build approval policy is locked"
        />
      </div>

      <ProviderPicker
        open={provOpen}
        onClose={() => setProvOpen(false)}
        anchor={provRef.current}
        agents={agents}
        value={activeAgentId}
        onPick={handleSelectAgent}
      />
      <ModelPicker
        open={modelOpen}
        onClose={() => setModelOpen(false)}
        anchor={modelRef.current}
        provider={activeAgentId}
        value={model}
        onPick={onSelectModel}
        models={models}
      />
      <EffortPicker
        open={effortOpen}
        onClose={() => setEffortOpen(false)}
        anchor={effortRef.current}
        provider={activeAgentId}
        value={effort}
        onPick={onSelectEffort}
      />
      {mcpEnabled && (
        <McpPicker
          open={mcpOpen}
          onClose={() => setMcpOpen(false)}
          anchor={mcpRef.current}
          servers={mcpServers}
          selectedIds={selectedMcpIds}
          onToggle={id => onToggleMcp?.(id)}
        />
      )}
    </div>
  )
})

import { useEffect, useMemo, useRef, useState } from 'react'

import { Icon } from '../ui/Icon'
import { CreateBranchModal } from '../git/BranchPicker'
import type { GitBranchRef } from '../git/git-state'
import { prefetchProviderModels, useProviderModels } from '../../hooks/useProviderModels'
import type { McpServerConfig } from '../../hooks/useSettings'
import type { AgentInfo } from '../../types'
import { effortRowsForProvider, providerSupportsEffort, type EffortLevel } from './EffortPicker'
import type { Mode } from './ModeSegment'
import { PickerSheet, type PickerItem } from './PickerSheet'
import { PROVIDER_IMAGES, PROVIDER_META, providerImageClass } from './provider-meta'

const MODE_COPY: Record<Mode, string> = {
  Ask: 'Read-only answers and discovery',
  Plan: 'Fresh context and a markdown plan',
  Build: 'Careful implementation with approvals',
  Full: 'All tools pre-approved',
}

const EFFORT_LABEL: Record<EffortLevel, string> = {
  off: 'Off', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra',
}

function shortModel(id: string): string {
  if (!id) return 'auto'
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

function providerIcon(provider: string, size = 18) {
  const image = PROVIDER_IMAGES[provider]
  return image
    ? <img src={image} alt="" width={size} height={size} className={providerImageClass(provider)} style={{ display: 'block', objectFit: 'contain' }} />
    : <Icon name={(PROVIDER_META[provider]?.icon ?? 'brain') as any} size={13} />
}

type ModelPage = 'root' | 'provider' | 'model' | 'effort' | 'mode' | 'mcp'

interface MobileModelMenuProps {
  agents: AgentInfo[]
  activeAgentId: string
  onSelectAgent: (id: string) => void
  model: string
  onSelectModel: (model: string) => void
  effort: EffortLevel
  onSelectEffort: (effort: EffortLevel) => void
  mode: Mode
  setMode: (mode: Mode) => void
  executionModeDisabled?: boolean
  mcpEnabled?: boolean
  mcpServers?: McpServerConfig[]
  selectedMcpIds?: string[]
  onToggleMcp?: (id: string) => void
}

export function MobileComposerModelMenu({
  agents, activeAgentId, onSelectAgent,
  model, onSelectModel, effort, onSelectEffort, mode, setMode, executionModeDisabled = false,
  mcpEnabled = false, mcpServers = [], selectedMcpIds = [], onToggleMcp,
}: MobileModelMenuProps) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<ModelPage>('root')
  const { list: models, loading } = useProviderModels(activeAgentId, open, open)
  const activeProvider = agents.find(agent => agent.id === activeAgentId)
  const selectedModel = models.find(item => item.id === model)
  const mcpCount = selectedMcpIds.filter(id => mcpServers.some(server => server.id === id)).length

  useEffect(() => { if (!open) setPage('root') }, [open])

  const rootItems = useMemo<PickerItem[]>(() => [
    {
      id: 'provider', label: 'Provider',
      sub: activeProvider?.name ?? activeAgentId,
      icon: providerIcon(activeAgentId),
    },
    {
      id: 'model', label: 'Model',
      sub: selectedModel?.label ?? shortModel(model),
      icon: <Icon name="crew" size={13} />,
    },
    {
      id: 'effort', label: 'Effort',
      sub: EFFORT_LABEL[effort],
      icon: <Icon name="sliders" size={13} />,
      disabled: effortRowsForProvider(activeAgentId).length === 0,
    },
    {
      id: 'mode', label: 'Mode',
      sub: executionModeDisabled ? 'Build · locked by CrewCoder profile' : (mode === 'Full' ? 'Full Access' : mode),
      icon: <Icon name="wrench" size={13} />,
      disabled: executionModeDisabled,
    },
    ...(mcpEnabled ? [{
      id: 'mcp', label: 'MCP servers',
      sub: mcpCount > 0 ? `${mcpCount} selected` : 'none selected',
      icon: <Icon name="box" size={13} />,
    }] : []),
  ], [activeAgentId, activeProvider?.name, effort, executionModeDisabled, mcpCount, mcpEnabled, mode, model, selectedModel?.label])

  const pageItems = useMemo<PickerItem[]>(() => {
    const back: PickerItem = { id: '__back', label: 'Back', sub: 'Model settings', icon: <Icon name="chevLeft" size={13} /> }
    if (page === 'provider') return [back, ...agents.map(agent => ({
      id: agent.id,
      label: agent.name,
      sub: agent.description ?? (agent.available ? 'available' : 'not available'),
      disabled: !agent.available,
      icon: providerIcon(agent.id),
    }))]
    if (page === 'model') return [back, ...models.map(item => ({
      id: item.id || '__default_model',
      label: item.label || 'auto',
      sub: item.id || 'Provider default',
      icon: providerIcon(item.provider || activeAgentId),
    }))]
    if (page === 'effort') return [back, ...effortRowsForProvider(activeAgentId).map(item => ({
      id: item.id, label: item.label, sub: item.sub, icon: <Icon name="sliders" size={13} />,
    }))]
    if (page === 'mode') return [back, ...(['Ask', 'Plan', 'Build', 'Full'] as Mode[]).map(item => ({
      id: item, label: item === 'Full' ? 'Full Access' : item, sub: MODE_COPY[item], icon: <Icon name="wrench" size={13} />,
    }))]
    if (page === 'mcp') return [back, ...mcpServers.map(server => ({
      id: server.id, label: server.name, sub: [server.command, ...(server.args ?? [])].join(' '), icon: <Icon name="box" size={13} />,
    }))]
    return rootItems
  }, [activeAgentId, agents, mcpServers, models, page, rootItems])

  const pick = (id: string) => {
    if (id === '__back') { setPage('root'); return }
    if (page === 'root') { setPage(id as ModelPage); return }
    if (page === 'provider') {
      void prefetchProviderModels(id, true)
      if (!providerSupportsEffort(id, effort)) onSelectEffort(effortRowsForProvider(id)[0]?.id ?? 'off')
      onSelectAgent(id)
      setPage('root')
      return
    }
    if (page === 'model') { onSelectModel(id === '__default_model' ? '' : id); setPage('root'); return }
    if (page === 'effort') { onSelectEffort(id as EffortLevel); setPage('root'); return }
    if (page === 'mode' && !executionModeDisabled) { setMode(id as Mode); setPage('root'); return }
    if (page === 'mcp') onToggleMcp?.(id)
  }

  const header = page === 'root' ? 'MODEL SETTINGS' : page.toUpperCase()
  const activeId = page === 'provider' ? activeAgentId
    : page === 'model' ? (model || '__default_model')
    : page === 'effort' ? effort
    : page === 'mode' ? mode
    : undefined

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="mobile-composer-model-button"
        onClick={() => setOpen(value => !value)}
        title={`model settings · ${shortModel(model)}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {providerIcon(activeAgentId, 14)}
        <span>{loading && !model ? 'loading…' : (selectedModel?.label ?? shortModel(model))}</span>
        <Icon name="chevDown" size={10} />
      </button>
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchorRef.current}
        header={header}
        items={pageItems}
        activeId={activeId}
        multiSelect={page === 'mcp'}
        selectedIds={page === 'mcp' ? selectedMcpIds : undefined}
        onPick={pick}
        closeOnPick={false}
        className="mobile-composer-menu-sheet"
        emptyLabel={page === 'mcp' ? 'No MCP servers configured' : 'No options available'}
        width={330}
      />
    </>
  )
}

type ActionPage = 'root' | 'branches'

interface MobileActionMenuProps {
  onAttach: () => void
  onOpenPrompts?: () => void
  branchPicker?: {
    currentBranch: string
    branches: GitBranchRef[]
    onCheckoutBranch?: (ref: string) => void
    onCreateBranch?: (name: string) => void
    onRefresh?: () => void
  }
}

export function MobileComposerActionMenu({ onAttach, onOpenPrompts, branchPicker }: MobileActionMenuProps) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState<ActionPage>('root')
  const [createBranchOpen, setCreateBranchOpen] = useState(false)

  useEffect(() => { if (!open) setPage('root') }, [open])
  useEffect(() => { if (open && page === 'branches') branchPicker?.onRefresh?.() }, [branchPicker, open, page])

  const items = useMemo<PickerItem[]>(() => {
    if (page === 'root') return [
      { id: 'attach', label: 'Attach files', sub: 'Add files or images to this message', icon: <Icon name="paperclip" size={13} /> },
      { id: 'prompts', label: 'Prompts & Skills', sub: 'Browse your prompt library', icon: <Icon name="inspection" size={13} />, disabled: !onOpenPrompts },
      ...(branchPicker ? [{ id: 'branches', label: 'Branch', sub: branchPicker.currentBranch, icon: <Icon name="gitBranch" size={13} /> }] : []),
    ]
    if (!branchPicker) return []
    return [
      { id: '__back', label: 'Back', sub: 'Composer actions', icon: <Icon name="chevLeft" size={13} /> },
      ...branchPicker.branches.map(item => ({
        id: `branch:${item.name}`,
        label: item.name,
        sub: `${item.kind}${item.updated ? ` · ${item.updated}` : ''}`,
        icon: <Icon name="gitBranch" size={13} />,
      })),
      { id: '__create', label: 'Create branch…', sub: `From ${branchPicker.currentBranch}`, icon: <Icon name="plus" size={13} /> },
    ]
  }, [branchPicker, onOpenPrompts, page])

  const pick = (id: string) => {
    if (id === '__back') { setPage('root'); return }
    if (page === 'root') {
      if (id === 'attach') { setOpen(false); onAttach(); return }
      if (id === 'prompts') { setOpen(false); onOpenPrompts?.(); return }
      if (id === 'branches') { setPage('branches'); return }
    }
    if (id === '__create') { setOpen(false); setCreateBranchOpen(true); return }
    if (id.startsWith('branch:')) {
      setOpen(false)
      const name = id.slice('branch:'.length)
      const branch = branchPicker?.branches.find(item => item.name === name)
      const ref = branch?.kind === 'remote' && !name.startsWith('origin/') ? `origin/${name}` : name
      branchPicker?.onCheckoutBranch?.(ref)
    }
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="mobile-composer-action-button"
        onClick={() => setOpen(value => !value)}
        title="Composer actions"
        aria-label="Composer actions"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Icon name="plus" size={14} />
      </button>
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        anchor={anchorRef.current}
        header={page === 'root' ? 'COMPOSER ACTIONS' : 'BRANCHES'}
        items={items}
        activeId={page === 'branches' ? `branch:${branchPicker?.currentBranch ?? ''}` : undefined}
        onPick={pick}
        closeOnPick={false}
        className="mobile-composer-menu-sheet"
        width={330}
      />
      {branchPicker && (
        <CreateBranchModal
          open={createBranchOpen}
          seed=""
          sourceBranch={branchPicker.currentBranch}
          onCreate={branchPicker.onCreateBranch}
          onClose={() => setCreateBranchOpen(false)}
        />
      )}
    </>
  )
}

import React from 'react'
import { Icon } from '../ui/Icon'
import { PickerSheet } from './PickerSheet'

export type EffortLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export interface EffortRow {
  id: EffortLevel
  label: string
  sub: string
}

const DEFAULT_ROWS: EffortRow[] = [
  { id: 'off',    label: 'off',    sub: 'Off' },
  { id: 'low',    label: 'Low',    sub: 'Fast responses with lighter reasoning' },
  { id: 'medium', label: 'Medium', sub: 'Balances speed and reasoning depth for everyday tasks' },
  { id: 'high',   label: 'High',   sub: 'Greater reasoning depth for complex problems' },
  { id: 'xhigh',  label: 'XHigh',  sub: 'Extra high reasoning depth for complex problems' },
]

const CODEX_ROWS: EffortRow[] = [
  ...DEFAULT_ROWS,
  { id: 'max',   label: 'Max',   sub: 'Maximum reasoning depth for hardest problems' },
  { id: 'ultra', label: 'Ultra', sub: 'Ultra reasoning with automatic task delegation' },
]

const CLAUDE_ROWS: EffortRow[] = [
  { id: 'off',    label: 'off',    sub: 'Off' },
  { id: 'low',    label: 'Low',    sub: 'Fast responses with lighter reasoning' },
  { id: 'medium', label: 'Medium', sub: 'Balances speed and reasoning depth for everyday tasks' },
  { id: 'high',   label: 'High',   sub: 'For intelligence-sensitive workloads' },
  { id: 'xhigh',  label: 'XHigh',  sub: 'For coding and agentic use' },
  { id: 'max',    label: 'Max',    sub: 'Maximum reasoning depth for hardest problems' },
]

const CREWCODER_ROWS: EffortRow[] = [
  ...DEFAULT_ROWS,
  { id: 'max', label: 'Max', sub: 'Maximum reasoning depth for hardest problems' },
]
// Grok exposes exactly three efforts and has no "off" — its own picker shows
// only these. Labels and descriptions are Grok's, so the two UIs agree.
const GROK_ROWS: EffortRow[] = [
  { id: 'low',    label: 'Low',    sub: 'Quick, fast implementations' },
  { id: 'medium', label: 'Medium', sub: 'Balanced effort with standard implementation and testing' },
  { id: 'high',   label: 'High',   sub: 'Highest implementation quality with extensive reasoning' },
]
const OPENROUTER_ROWS: EffortRow[] = DEFAULT_ROWS
const OLLAMA_ROWS: EffortRow[] = DEFAULT_ROWS.filter(row => row.id !== 'xhigh')
const NO_EFFORT_ROWS: EffortRow[] = []

/** Provider-native effort choices. Unsupported presets are intentionally hidden. */
export function effortRowsForProvider(provider: string): EffortRow[] {
  if (provider === 'codex') return CODEX_ROWS
  if (provider === 'claude') return CLAUDE_ROWS
  if (provider === 'crewcoder') return CREWCODER_ROWS
  if (provider === 'grok') return GROK_ROWS
  if (provider === 'openrouter') return OPENROUTER_ROWS
  if (provider === 'ollama') return OLLAMA_ROWS
  if (provider === 'pi' || provider === 'opencode') return DEFAULT_ROWS
  return NO_EFFORT_ROWS
}

export function providerSupportsEffort(provider: string, effort: EffortLevel): boolean {
  return effortRowsForProvider(provider).some(row => row.id === effort)
}

interface EffortPickerProps {
  open:     boolean
  anchor:   HTMLElement | null
  provider: string
  value:    EffortLevel
  onPick:   (v: EffortLevel) => void
  onClose:  () => void
}

export function EffortPicker({ open, anchor, provider, value, onPick, onClose }: EffortPickerProps) {
  const rows = effortRowsForProvider(provider)
  return (
    <PickerSheet
      open={open}
      onClose={onClose}
      anchor={anchor}
      header="EFFORT LEVEL"
      items={rows.map(r => ({ id: r.id, label: r.label, sub: r.sub }))}
      activeId={value}
      onPick={id => onPick(id as EffortLevel)}
      defaultIcon={<Icon name="chat" size={13} />}
    />
  )
}

import React from 'react'
import { Icon } from '../ui/Icon'
import { PickerSheet } from './PickerSheet'
import { CREWCODER_MODES, type CrewCoderMode } from '../../../../shared/crewcoder-types'

const MODE_DETAILS: Record<CrewCoderMode, { label: string; sub: string }> = {
  general: { label: 'General', sub: 'General-purpose coding agent' },
  crewcoder: { label: 'CrewCoder', sub: 'Architect, plan, and approve' },
  plugin: { label: 'Plugin', sub: 'Build CrewCode plugins with plugin tools and docs' },
  extension: { label: 'Extension', sub: 'Build CrewCoder extensions with extension tools and docs' },
}

export function crewCoderModeItems() {
  return [
    { id: '', label: 'Configured default', sub: 'Use CrewCoder’s saved default mode' },
    ...CREWCODER_MODES.map(id => ({ id, ...MODE_DETAILS[id] })),
  ]
}

interface CrewCoderModePickerProps {
  open: boolean
  anchor: HTMLElement | null
  value?: CrewCoderMode
  onPick: (mode: CrewCoderMode | undefined) => void
  onClose: () => void
}

export function CrewCoderModePicker({ open, anchor, value, onPick, onClose }: CrewCoderModePickerProps) {
  return (
    <PickerSheet
      open={open}
      onClose={onClose}
      anchor={anchor}
      header="CREWCODER MODE"
      items={crewCoderModeItems()}
      activeId={value ?? ''}
      onPick={id => onPick(id ? id as CrewCoderMode : undefined)}
      defaultIcon={<Icon name="tags" size={13} />}
      width={320}
    />
  )
}

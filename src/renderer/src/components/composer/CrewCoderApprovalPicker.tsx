import React from 'react'
import { Icon } from '../ui/Icon'
import { PickerSheet } from './PickerSheet'
import type { CrewCoderApprovalMode } from '../../../../shared/crewcoder-types'

export function crewCoderApprovalItems() {
  return [
    { id: 'review', label: 'Review', sub: 'Safe calls proceed; mutations and dangerous calls ask' },
    { id: 'always', label: 'Always', sub: 'Every non-safe call asks for permission' },
    { id: 'never', label: 'Never', sub: 'No prompts; dangerous calls remain blocked' },
    { id: 'full-access', label: 'Full access', sub: 'No prompts; all calls are accepted' },
    { id: 'sandboxed', label: 'Sandboxed', sub: 'No prompts; non-dangerous calls use the sandbox policy' },
  ] satisfies Array<{ id: CrewCoderApprovalMode; label: string; sub: string }>
}

interface CrewCoderApprovalPickerProps {
  open: boolean
  anchor: HTMLElement | null
  value: CrewCoderApprovalMode
  onPick: (mode: CrewCoderApprovalMode) => void
  onClose: () => void
}

export function CrewCoderApprovalPicker({ open, anchor, value, onPick, onClose }: CrewCoderApprovalPickerProps) {
  return (
    <PickerSheet
      open={open}
      onClose={onClose}
      anchor={anchor}
      header="CREWCODER APPROVAL"
      items={crewCoderApprovalItems()}
      activeId={value}
      onPick={id => onPick(id as CrewCoderApprovalMode)}
      defaultIcon={<Icon name="key" size={13} />}
      width={340}
    />
  )
}

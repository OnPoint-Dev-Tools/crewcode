import React from 'react'
import { PickerSheet } from './PickerSheet'
import { Icon } from '../ui/Icon'
import type { McpServerConfig } from '../../hooks/useSettings'

interface McpPickerProps {
  open:        boolean
  anchor:      HTMLElement | null
  servers:     McpServerConfig[]
  selectedIds: string[]
  onToggle:    (id: string) => void
  onClose:     () => void
  placement?:  'auto' | 'down'
}

// Multi-select sheet listing the user's MCP server registry. Toggling a row
// opts the current session into that server; the sheet stays open so several
// can be checked at once.
export function McpPicker({ open, anchor, servers, selectedIds, onToggle, onClose, placement }: McpPickerProps) {
  const items = servers.map(s => ({
    id:    s.id,
    label: s.name,
    sub:   [s.command, ...(s.args ?? [])].join(' '),
    icon:  <Icon name="box" size={13} />,
  }))
  return (
    <PickerSheet
      open={open}
      onClose={onClose}
      anchor={anchor}
      header="mcp servers"
      items={items}
      multiSelect
      selectedIds={selectedIds}
      onPick={onToggle}
      placement={placement}
      width={300}
      emptyLabel="no mcp servers — add one in settings"
    />
  )
}

import React from 'react'
import { PickerSheet } from './PickerSheet'
import type { AgentInfo } from '../../types'
import { providerImageClass } from './provider-meta'

import claudeIcon   from '../../assets/claude-color.svg'
import openaiIcon   from '../../assets/openai.svg'
import piIcon       from '../../assets/pi.svg'
import opencodeIcon from '../../assets/opencode.svg'
import hermesIcon   from '../../assets/hermes.png'
import ollamaIcon   from '../../assets/ollama.svg'
import openrouterIcon from '../../assets/openrouter.svg'
import crewCoderIcon from '../../assets/icon-logo-light.png'

const ICONS: Record<string, string> = {
  claude:     claudeIcon,
  codex:      openaiIcon,
  pi:         piIcon,
  opencode:   opencodeIcon,
  hermes:     hermesIcon,
  crewcoder:  crewCoderIcon,
  ollama:     ollamaIcon,
  openrouter: openrouterIcon,
}

const SUB: Record<string, string> = {
  claude:     'Anthropic',
  codex:      'OpenAI',
  pi:         'Pi',
  opencode:   'Anomaly',
  hermes:     'NousResearch',
  crewcoder:  'CrewCode · ACP',
  ollama:     'Local',
  openrouter: 'Hosted · needs API key',
}

const BADGE: Record<string, string | undefined> = {
  hermes:     'BETA',
  crewcoder:  'BETA',
  ollama:     'BETA',
  openrouter: 'BETA',
}

interface ProviderPickerProps {
  open:    boolean
  anchor:  HTMLElement | null
  agents:  AgentInfo[]
  value:   string
  onPick:  (id: string) => void
  onClose: () => void
  placement?: 'auto' | 'down'
}

function ProviderIcon({ src, alt }: { src: string; alt: string }) {
  return (
    <img
      src={src}
      alt={alt}
      width={16}
      height={16}
      className={providerImageClass(alt)}
      style={{ objectFit: 'contain', display: 'block' }}
    />
  )
}

export function ProviderPicker({ open, anchor, agents, value, onPick, onClose, placement }: ProviderPickerProps) {
  const items = agents.map(a => ({
    id:       a.id,
    label:    a.name,
    sub:      a.source === 'plugin'
      ? `${a.description ?? 'plugin agent provider'} · ${a.pluginId}`
      : SUB[a.id] ?? a.name,
    badge:    a.source === 'plugin' ? 'PLUGIN' : BADGE[a.id],
    disabled: !a.available,
    icon:     ICONS[a.id]
      ? <ProviderIcon src={ICONS[a.id]} alt={a.id} />
      : undefined,
  }))
  return (
    <PickerSheet
      open={open}
      onClose={onClose}
      anchor={anchor}
      items={items}
      activeId={value}
      onPick={onPick}
      placement={placement}
      width={280}
    />
  )
}

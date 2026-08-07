import type { PtyPane, Tab } from './types'

export interface TerminalTabDisplay {
  label: string
  providerId?: string
}

const GENERIC_TERMINAL_LABELS = new Set(['terminal', 'terminals', 'shell'])

export function terminalProjectNameFromPath(cwd: string, fallback: string): string {
  const cleaned = cwd.trim().replace(/[\\/]+$/, '')
  if (!cleaned) return fallback
  const parts = cleaned.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? fallback
}

function hasCustomTerminalLabel(label: string): boolean {
  const trimmed = label.trim()
  return trimmed.length > 0 && !GENERIC_TERMINAL_LABELS.has(trimmed.toLowerCase())
}

export function terminalTabDisplay(tab: Tab, panes: PtyPane[], workspaceName: string): TerminalTabDisplay {
  const tabPanes = panes.filter(pane => pane.tabId === tab.id)
  const firstAgentPane = tabPanes.find(pane => pane.agentId)
  const providerId = firstAgentPane?.agentId ?? undefined

  if (hasCustomTerminalLabel(tab.label)) return { label: tab.label, providerId }

  const primary = firstAgentPane ?? tabPanes[0]
  if (!primary) return { label: workspaceName || tab.label || 'terminal', providerId }

  const countSuffix = tabPanes.length > 1 ? ` · ${tabPanes.length}` : ''
  if (primary.shell === 'ssh') return { label: `${primary.title}${countSuffix}`, providerId }

  const projectName = terminalProjectNameFromPath(primary.cwd, workspaceName || primary.title || 'terminal')
  const base = primary.agentId ? `${primary.title} · ${projectName}` : projectName
  return { label: `${base}${countSuffix}`, providerId }
}

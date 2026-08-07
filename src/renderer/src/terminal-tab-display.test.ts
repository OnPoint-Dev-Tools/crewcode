import { describe, expect, it } from 'vitest'

import { terminalTabDisplay } from './terminal-tab-display'
import type { PtyPane, Tab } from './types'

function terminalTab(partial: Partial<Tab> = {}): Tab {
  return { id: 'ws1-terminal', kind: 'terminal', label: 'Terminal', live: false, ...partial }
}

function pane(partial: Partial<PtyPane> = {}): PtyPane {
  return {
    paneId:  'pane-1',
    wsId:    'ws1',
    tabId:   'ws1-terminal',
    agentId: null,
    title:   'shell',
    sub:     '/repo/crewcode',
    cwd:     '/repo/crewcode',
    live:    true,
    ...partial,
  }
}

describe('terminalTabDisplay', () => {
  it('uses a custom terminal tab label when the user renamed it', () => {
    const display = terminalTabDisplay(
      terminalTab({ label: 'release runner' }),
      [pane({ agentId: 'claude', title: 'Claude' })],
      'CrewCode',
    )

    expect(display).toEqual({ label: 'release runner', providerId: 'claude' })
  })

  it('uses the project folder for plain shell terminal tabs', () => {
    const display = terminalTabDisplay(terminalTab(), [pane()], 'CrewCode')

    expect(display.label).toBe('crewcode')
    expect(display.providerId).toBeUndefined()
  })

  it('uses the agent/provider name and project for agent terminal tabs', () => {
    const display = terminalTabDisplay(
      terminalTab(),
      [pane({ agentId: 'codex', title: 'Codex', cwd: '/repo/CrewCode' })],
      'CrewCode',
    )

    expect(display).toEqual({ label: 'Codex · CrewCode', providerId: 'codex' })
  })

  it('adds a pane count when a terminal tab contains multiple panes', () => {
    const display = terminalTabDisplay(
      terminalTab(),
      [pane({ paneId: 'pane-1' }), pane({ paneId: 'pane-2' }), pane({ paneId: 'pane-3' })],
      'CrewCode',
    )

    expect(display.label).toBe('crewcode · 3')
  })

  it('uses ssh target titles for ssh terminal tabs', () => {
    const display = terminalTabDisplay(
      terminalTab(),
      [pane({ shell: 'ssh', title: 'ssh · prod', sub: 'prod', cwd: '/repo/crewcode' })],
      'CrewCode',
    )

    expect(display.label).toBe('ssh · prod')
  })
})

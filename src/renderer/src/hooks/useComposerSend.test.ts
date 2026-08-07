import { describe, expect, it, vi } from 'vitest'

import type { AgentInfo } from '../types'
import { renderHook } from './hook-test-host'
import { useComposerSend, type UseComposerSendOpts } from './useComposerSend'

const agent: AgentInfo = {
  id: 'pi',
  name: 'pi',
  path: '/usr/bin/pi',
  available: true,
  transport: 'bridge',
}

function makeOpts(overrides: Partial<UseComposerSendOpts> = {}): UseComposerSendOpts {
  return {
    activeWs: 'ws-1',
    activeTabId: 'tab-1',
    sessActive: 'sess-1',
    composer: '',
    setComposer: vi.fn(),
    setMessages: vi.fn(),
    agents: [agent],
    activeAgentId: 'pi',
    model: 'model-a',
    effort: 'medium',
    mode: 'build',
    effectivePath: '/repo',
    bridges: {
      ensureBridge: vi.fn(async () => ({ bridgeId: 'bridge-1' })),
      prompt: vi.fn(async () => ({ ok: true })),
      dropBridge: vi.fn(),
    },
    pty: {
      addAgent: vi.fn(() => ({ paneId: 'pane-1', live: true })),
      write: vi.fn(),
    },
    activeAgentPane: null,
    enabledSkills: [],
    skillsDeliveredTo: vi.fn(() => []),
    markSkillsDelivered: vi.fn(),
    lastDeliveredMode: vi.fn(() => undefined),
    markModeDelivered: vi.fn(),
    getAttachments: vi.fn(() => []),
    getMcpServers: vi.fn(() => []),
    ...overrides,
  }
}

describe('useComposerSend session continuity', () => {
  it('does not drop or reset provider history on initial mount', () => {
    const opts = makeOpts()
    const h = renderHook(useComposerSend, opts)

    expect(opts.bridges.dropBridge).not.toHaveBeenCalled()

    h.unmount()
  })

  it('does not treat switching chat sessions as launch-flag changes', () => {
    const opts = makeOpts()
    const h = renderHook(useComposerSend, opts)

    h.rerender(makeOpts({
      bridges: opts.bridges,
      activeTabId: 'tab-2',
      sessActive: 'sess-2',
      model: 'model-b',
      effort: 'high',
    }))

    expect(opts.bridges.dropBridge).not.toHaveBeenCalled()

    h.unmount()
  })

  it('respawns on launch-flag changes but keeps mode changes in the same live session', () => {
    const opts = makeOpts()
    const h = renderHook(useComposerSend, opts)
    const changedModel = makeOpts({ bridges: opts.bridges, model: 'model-b' })

    h.rerender(changedModel)

    expect(opts.bridges.dropBridge).toHaveBeenCalledWith('sess-1', 'pi')

    const changedMode = makeOpts({ bridges: opts.bridges, model: 'model-b', mode: 'plan' })
    h.rerender(changedMode)

    expect(opts.bridges.dropBridge).toHaveBeenCalledTimes(1)

    const changedEffort = makeOpts({ bridges: opts.bridges, model: 'model-b', mode: 'plan', effort: 'high' })
    h.rerender(changedEffort)

    expect(opts.bridges.dropBridge).toHaveBeenCalledTimes(2)
    expect(opts.bridges.dropBridge).toHaveBeenLastCalledWith('sess-1', 'pi')

    h.unmount()
  })
})

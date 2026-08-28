import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

import { installCrewCodeRuntime, type CrewCodeClient } from './crewcode-client'
import { WebAgentChat } from './WebAgentChat'

describe('WebAgentChat execution custody', () => {
  it('replays the detached reply and unmounts without stopping the Brain bridge', () => {
    let listener!: (event: unknown) => void
    const off = vi.fn()
    const bridgeStop = vi.fn()
    const client = {
      onBridgeEvent: vi.fn((next: (event: unknown) => void) => { listener = next; return off }),
      bridgeStop,
    } as unknown as CrewCodeClient
    vi.stubGlobal('window', {})
    installCrewCodeRuntime({ kind: 'web', client })

    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(createElement(WebAgentChat, {
        workspacePath: '/workspace', workspaceId: 'workspace-id', onClose: vi.fn(),
      }))
    })
    act(() => listener({
      type: 'history_agent', bridgeId: 'web-chat-workspace-id', turnId: 'remote-turn', text: 'finished while the page was closed',
    }))
    expect(renderer.root.findAllByType('div').some(node => node.children.includes('finished while the page was closed'))).toBe(true)

    act(() => renderer.unmount())
    expect(off).toHaveBeenCalledTimes(1)
    expect(bridgeStop).not.toHaveBeenCalled()
  })
})

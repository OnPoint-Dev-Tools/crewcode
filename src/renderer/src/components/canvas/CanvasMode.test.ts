import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../hooks/useSettings', () => ({
  useSettings: () => ({
    state: { hideVerboseAgentLogs: false },
    set: vi.fn(),
  }),
}))

import { CanvasMode, type CanvasPaneView } from './CanvasMode'

function renderPane(modePrompt?: CanvasPaneView['modePrompt']): TestRenderer.ReactTestRenderer {
  return TestRenderer.create(createElement(CanvasMode, {
    workspaceName: 'Test workspace',
    openChatCount: 1,
    openTerminalCount: 0,
    panes: [{
      id: 'chat-1',
      kind: 'chat' as const,
      title: 'Workbench Chat 1',
      content: createElement('div', null, 'chat'),
      modePrompt,
    }],
  }))
}

describe('CanvasMode chat pane bar', () => {
  it('toggles the per-chat mode prompt while the session is fresh', () => {
    const onToggle = vi.fn()
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderPane({ enabled: true, locked: false, onToggle })
    })

    const toggle = renderer.root.findByProps({
      'aria-label': 'Inject CrewCode mode prompt for this Workbench chat',
    })
    expect(toggle.props['aria-pressed']).toBe(true)
    expect(toggle.props.disabled).toBe(false)

    act(() => toggle.props.onClick())
    expect(onToggle).toHaveBeenCalledOnce()
    act(() => renderer.unmount())
  })

  it('disables the mode prompt toggle after session context is delivered', () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = renderPane({ enabled: false, locked: true, onToggle: vi.fn() })
    })

    const toggle = renderer.root.findByProps({
      'aria-label': 'Inject CrewCode mode prompt for this Workbench chat',
    })
    expect(toggle.props['aria-pressed']).toBe(false)
    expect(toggle.props.disabled).toBe(true)
    expect(toggle.props.title).toContain('was disabled')
    act(() => renderer.unmount())
  })
})

import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceDock } from './WorkspaceDock'

vi.mock('../ui/Icon', () => ({ Icon: () => null }))
afterEach(() => vi.unstubAllGlobals())

describe('workspace dock tab switcher', () => {
  it('opens mobile tabs without also opening the workspace drawer', () => {
    vi.stubGlobal('window', {})
    const onToggle = vi.fn()
    const onOpenTabs = vi.fn()
    const stopPropagation = vi.fn()
    let view!: TestRenderer.ReactTestRenderer
    act(() => { view = TestRenderer.create(createElement(WorkspaceDock, { open: false, onToggle, onOpenTabs, tabsOpen: true, tabCount: 3 })) })
    const trigger = view.root.findByProps({ 'aria-label': 'Tabs, 3 open' })
    expect(trigger.props['aria-expanded']).toBe(true)
    act(() => trigger.props.onClick({ stopPropagation }))
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(onOpenTabs).toHaveBeenCalledOnce()
    expect(onToggle).not.toHaveBeenCalled()
    act(() => view.unmount())
  })

  it('does not add a tab button to the desktop dock', () => {
    vi.stubGlobal('window', {})
    let view!: TestRenderer.ReactTestRenderer
    act(() => { view = TestRenderer.create(createElement(WorkspaceDock, { open: false, onToggle: vi.fn() })) })
    expect(view.root.findAllByProps({ className: 'ws-dock-tabs' })).toHaveLength(0)
    act(() => view.unmount())
  })
})

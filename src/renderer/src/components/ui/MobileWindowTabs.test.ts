import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { MobileWindowTabs } from './MobileWindowTabs'
import type { WindowTab } from './WindowTabs'

vi.mock('./Icon', () => ({ Icon: () => null }))
vi.mock('./AgentActivityIndicator', () => ({ AgentActivityIndicator: ({ state }: { state?: string }) => createElement('span', { 'data-activity': state }) }))

const tabs = [
  { id: 'chat', kind: 'chat', label: 'Fix scrolling', agentActivity: 'working' },
  { id: 'terminal', kind: 'terminal', label: 'Terminal' },
  { id: 'settings', kind: 'settings', label: 'Settings', pinned: true },
] as WindowTab[]

function render() {
  const props = { tabs, activeId: 'chat', crewTabs: {}, onActivate: vi.fn(), onClose: vi.fn(), onNewTab: vi.fn(), pluginMenuItems: [{ id: 'plugin', pluginId: 'plugin', title: 'My plugin', kind: 'tab' as const, target: { pluginId: 'plugin', tab: 'home' } }], onPluginMenuItem: vi.fn() }
  let view!: TestRenderer.ReactTestRenderer
  act(() => { view = TestRenderer.create(createElement(MobileWindowTabs, props)) })
  return { view, props }
}

describe('mobile tab switcher', () => {
  it('marks the exact active tab, shows activity, and activates by identity', () => {
    const { view, props } = render()
    const selected = view.root.findByProps({ 'aria-current': 'page' })
    expect(selected.findByProps({ className: 'mobile-tab-label' }).children).toContain('Fix scrolling')
    expect(view.root.findAllByProps({ 'data-activity': 'working' })).toHaveLength(1)
    act(() => selected.props.onClick())
    expect(props.onActivate).toHaveBeenCalledWith('chat')
    act(() => view.unmount())
  })

  it('closes the selected row without activating it and keeps pinned tabs protected', () => {
    const { view, props } = render()
    expect(view.root.findAllByProps({ 'aria-label': 'Close Settings' })).toHaveLength(0)
    act(() => view.root.findByProps({ 'aria-label': 'Close Terminal' }).props.onClick())
    expect(props.onClose).toHaveBeenCalledWith('terminal')
    expect(props.onActivate).not.toHaveBeenCalled()
    act(() => view.unmount())
  })

  it('opens built-in and plugin destinations through the existing callbacks', () => {
    const { view, props } = render()
    act(() => view.root.findByProps({ className: 'mobile-tabs-new' }).props.onClick())
    const choices = view.root.findByProps({ 'aria-label': 'New tab choices' })
    const buttons = choices.findAllByType('button')
    const terminal = buttons.find(button => button.findAllByType('span').some(span => span.children.includes('Terminal')))!
    act(() => terminal.props.onClick())
    expect(props.onNewTab).toHaveBeenCalledWith('terminal')
    act(() => buttons[buttons.length - 1].props.onClick())
    expect(props.onPluginMenuItem).toHaveBeenCalledWith(props.pluginMenuItems[0])
    act(() => view.unmount())
  })
})

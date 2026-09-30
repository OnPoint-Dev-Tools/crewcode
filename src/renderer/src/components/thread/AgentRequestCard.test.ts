import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

import type { AgentUserRequest } from '../../types'
import { AgentRequestCard, isInlineChoiceSet } from './AgentRequestCard'

function permission(overrides: Partial<AgentUserRequest> = {}): AgentUserRequest {
  return {
    requestId: 'request-1',
    bridgeId: 'bridge-1',
    turnId: 'turn-1',
    kind: 'permission',
    title: 'allow write',
    ...overrides,
  }
}

function buttonText(node: TestRenderer.ReactTestInstance): string {
  return node.children.filter(child => typeof child === 'string').join('')
}

describe('AgentRequestCard turn approvals', () => {
  it('shows allow all only when main grants the capability', () => {
    const withoutCapability = TestRenderer.create(createElement(AgentRequestCard, { request: permission() }))
    expect(withoutCapability.root.findAllByType('button').map(buttonText)).not.toContain('allow all (this turn ONLY)')

    const withCapability = TestRenderer.create(createElement(AgentRequestCard, {
      request: permission({ allowAllForTurn: true }),
    }))
    expect(withCapability.root.findAllByType('button').map(buttonText)).toContain('allow all (this turn ONLY)')
  })

  it('submits a turn-scoped acceptance response', () => {
    const onRespond = vi.fn()
    const renderer = TestRenderer.create(createElement(AgentRequestCard, {
      request: permission({ allowAllForTurn: true }),
      onRespond,
    }))
    const button = renderer.root.findAllByType('button')
      .find(candidate => buttonText(candidate) === 'allow all (this turn ONLY)')

    act(() => { button?.props.onClick() })

    expect(onRespond).toHaveBeenCalledWith({
      requestId: 'request-1',
      action: 'accept_for_turn',
    })
  })
})

function question(overrides: Partial<AgentUserRequest> = {}): AgentUserRequest {
  return {
    requestId: 'q-1',
    bridgeId: 'bridge-1',
    kind: 'select',
    title: 'Deploy?',
    ...overrides,
  }
}

// Mount inside act so mount effects (input reset) flush before interaction.
function mount(props: Parameters<typeof AgentRequestCard>[0]): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined
  act(() => { renderer = TestRenderer.create(createElement(AgentRequestCard, props)) })
  return renderer!
}

function labelOf(node: TestRenderer.ReactTestInstance): string {
  const flatten = (n: TestRenderer.ReactTestInstance | string): string =>
    typeof n === 'string' ? n : n.children.map(flatten).join('')
  return flatten(node)
}

function findButton(renderer: TestRenderer.ReactTestRenderer, label: string): TestRenderer.ReactTestInstance {
  const match = renderer.root.findAllByType('button').find(candidate => labelOf(candidate).includes(label))
  if (!match) throw new Error(`no button ${label}`)
  return match
}

describe('AgentRequestCard questions', () => {
  it('lays short yes/no choices on one row and answers on click', () => {
    const onRespond = vi.fn()
    const options = [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }]
    expect(isInlineChoiceSet(options)).toBe(true)
    const renderer = mount({ request: question({ options }), onRespond })
    expect(renderer.root.findAll(node => typeof node.props.className === 'string' && node.props.className.includes('agent-request-options-inline'))).toHaveLength(1)
    // Option-only questions need no send button.
    expect(renderer.root.findAllByType('button').map(labelOf)).not.toContain('send reply')

    act(() => { findButton(renderer, 'No').props.onClick() })
    expect(onRespond).toHaveBeenCalledWith({ requestId: 'q-1', action: 'submit', optionId: 'n' })
  })

  it('keeps send disabled until the free-text answer is non-empty', () => {
    const onRespond = vi.fn()
    const renderer = mount({
      request: question({ kind: 'prompt', title: 'Branch name?' }),
      onRespond,
    })
    expect(findButton(renderer, 'send reply').props.disabled).toBe(true)

    act(() => { renderer.root.findByType('input').props.onChange({ target: { value: 'feature/x' } }) })
    expect(findButton(renderer, 'send reply').props.disabled).toBe(false)
    act(() => { findButton(renderer, 'send reply').props.onClick() })
    expect(onRespond).toHaveBeenCalledWith({ requestId: 'q-1', action: 'submit', value: 'feature/x' })
  })

  it('masks secret answers', () => {
    const renderer = mount({
      request: question({ kind: 'prompt', secret: true }),
    })
    expect(renderer.root.findByType('input').props.type).toBe('password')
  })

  it('submits toggled multi-select options in option order', () => {
    const onRespond = vi.fn()
    const renderer = mount({
      request: question({
        multiple: true,
        options: [{ id: 'a', label: 'Lint' }, { id: 'b', label: 'Tests' }, { id: 'c', label: 'Types' }],
      }),
      onRespond,
    })
    act(() => { findButton(renderer, 'Types').props.onClick() })
    act(() => { findButton(renderer, 'Lint').props.onClick() })
    expect(onRespond).not.toHaveBeenCalled()
    act(() => { findButton(renderer, 'send reply').props.onClick() })
    expect(onRespond).toHaveBeenCalledWith({ requestId: 'q-1', action: 'submit', optionIds: ['a', 'c'] })
  })
})

import { createElement } from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

import type { AgentUserRequest } from '../../types'
import { AgentRequestCard } from './AgentRequestCard'

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

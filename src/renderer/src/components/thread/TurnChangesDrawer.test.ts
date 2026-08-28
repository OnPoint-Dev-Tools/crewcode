import { createElement } from 'react'
import TestRenderer from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../diff/PierreDiff', () => ({
  PierreDiff: ({ patch }: { patch: string }) => createElement('div', { 'data-testid': 'pierre-diff', patch }),
}))

import { TurnChangesDrawer } from './TurnChangesDrawer'
import type { Message } from '../../types'

describe('TurnChangesDrawer targeted opening', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      innerWidth: 1200,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    })
    vi.stubGlobal('document', { body: { style: {} } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('focuses the requested turn diff with the agent summary sidebar closed', () => {
    const alphaPatch = 'diff --git a/src/alpha.ts b/src/alpha.ts\n--- a/src/alpha.ts\n+++ b/src/alpha.ts\n@@ -1 +1 @@\n-old\n+new'
    const betaPatch = 'diff --git a/src/beta.ts b/src/beta.ts\n--- a/src/beta.ts\n+++ b/src/beta.ts\n@@ -1 +1 @@\n-old\n+new'
    const messages: Message[] = [
      {
        kind: 'toolcall', time: '9:00 PM', turnId: 'turn-1', toolCallId: 'edit-1', toolName: 'edit',
        args: { path: 'src/alpha.ts' }, status: 'completed',
        fileChanges: [
          { path: 'src/alpha.ts', beforeText: 'old', afterText: 'new', patch: alphaPatch },
          { path: 'src/beta.ts', beforeText: 'old', afterText: 'new', patch: betaPatch },
        ],
      },
      { kind: 'agent', time: '9:01 PM', turnId: 'turn-1', blocks: [], text: 'done', streaming: false },
    ]

    let renderer!: TestRenderer.ReactTestRenderer
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(TurnChangesDrawer, {
        open: true,
        messages,
        target: { turnId: 'turn-1', filePath: 'src/beta.ts' },
        onClose: vi.fn(),
      }))
    })

    expect(renderer.root.findByProps({ 'aria-pressed': false })).toBeTruthy()
    expect(renderer.root.find(node => node.props.className === 'turn-drawer-body sidebar-closed')).toBeTruthy()
    expect(renderer.root.findByProps({ 'data-testid': 'pierre-diff' }).props.patch).toBe(betaPatch)

    TestRenderer.act(() => renderer.unmount())
  })
})
